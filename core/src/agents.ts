// Connection pools for outgoing requests, instrumented so each exchange can report
// its connection phases (DNS, TCP, TLS) and where it went.
import { AsyncLocalStorage } from "node:async_hooks";
import diagnostics from "node:diagnostics_channel";
import dns from "node:dns";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { TLSSocket } from "node:tls";
import { Agent, buildConnector } from "undici";
import type { NetworkInfo } from "./models.js";

// When a host resolves to several addresses, Node tries them in turn and gives
// each only 250 ms by default. Over Docker networking or a slow link a healthy
// TLS host (e.g. behind a CDN) can miss that window on every address and fail
// with ETIMEDOUT / ENETUNREACH. Give each address a realistic window instead;
// the request's own timeout still bounds the whole exchange.
const ATTEMPT_TIMEOUT_MS = 2500;

/** What one request learned about its connection; filled in while it is sent. */
export interface ExchangeTrace {
  /** Set when a new connection was opened for this request. */
  connect?: { dns?: number; tcp?: number; tls?: number };
  network?: NetworkInfo;
}

const traces = new AsyncLocalStorage<ExchangeTrace>();

/** Run `fn` (which sends one request) so the connection details land in `trace`. */
export function withTrace<T>(trace: ExchangeTrace, fn: () => Promise<T>): Promise<T> {
  return traces.run(trace, fn);
}

const certName = (o: unknown) => {
  const r = o as Record<string, string | string[]> | undefined;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : v);
  return pick(r?.CN) ?? pick(r?.O);
};

function networkOf(socket: Socket): NetworkInfo {
  const info: NetworkInfo = {
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    localAddress: socket.localAddress,
    localPort: socket.localPort,
  };
  const tls = socket as TLSSocket;
  if (typeof tls.getProtocol === "function") {
    const cert = tls.getPeerCertificate?.();
    info.tls = {
      protocol: tls.getProtocol() ?? undefined,
      cipher: tls.getCipher?.()?.name,
      ...(cert && Object.keys(cert).length
        ? { certificate: { subject: certName(cert.subject), issuer: certName(cert.issuer), validFrom: cert.valid_from, validTo: cert.valid_to, altNames: cert.subjectaltname } }
        : {}),
      ...(tls.authorizationError ? { authorizationError: String(tls.authorizationError) } : {}),
    };
  }
  return info;
}

// Fires as a request is written to its socket, new or reused, in the sender's async context.
diagnostics.channel("undici:client:sendHeaders").subscribe((message) => {
  const trace = traces.getStore();
  const socket = (message as { socket?: Socket }).socket;
  if (trace && socket) trace.network = { httpVersion: "1.1", ...networkOf(socket) };
});

function timedConnector(tlsOptions: { rejectUnauthorized?: boolean }): buildConnector.connector {
  const base = buildConnector({
    ...tlsOptions,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: ATTEMPT_TIMEOUT_MS,
    // Times the lookup; with several addresses only the first lookup counts.
    lookup: ((host: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
      const trace = traces.getStore();
      const started = performance.now();
      dns.lookup(host, options, (...args: unknown[]) => {
        if (trace?.connect && trace.connect.dns === undefined) trace.connect.dns = performance.now() - started;
        callback(...args);
      });
    }) as never,
  } as buildConnector.BuildOptions);
  return (options, callback) => {
    const trace = traces.getStore();
    const started = performance.now();
    if (trace) trace.connect = {};
    const socket = base(options, (...args) => {
      if (trace?.connect && !args[0] && options.protocol === "https:") {
        const tcpDone = (trace.connect.dns ?? 0) + (trace.connect.tcp ?? 0);
        trace.connect.tls = Math.max(0, performance.now() - started - tcpDone);
      }
      callback(...args);
    });
    // TCP is up when the socket connects; for TLS sockets that comes before the handshake.
    (socket as unknown as Socket)?.once?.("connect", () => {
      if (trace?.connect) trace.connect.tcp = Math.max(0, performance.now() - started - (trace.connect.dns ?? 0));
    });
    return socket;
  };
}

// undici gives up after 300 s without headers or body data. A request's own
// timeout (or none) decides instead, so slow reports and idle streams survive.
const base = { headersTimeout: 0, bodyTimeout: 0 };

let standard: Agent | undefined;
let insecure: Agent | undefined;

export function defaultAgent(): Agent {
  return (standard ??= new Agent({ ...base, connect: timedConnector({}) }));
}

/** For requests with "skip SSL verification" on. */
export function insecureAgent(): Agent {
  return (insecure ??= new Agent({ ...base, connect: timedConnector({ rejectUnauthorized: false }) }));
}
