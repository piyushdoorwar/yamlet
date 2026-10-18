// Connection pools for outgoing requests, instrumented so each exchange can report
// its connection phases (DNS, TCP, TLS) and where it went.
import { AsyncLocalStorage } from "node:async_hooks";
import diagnostics from "node:diagnostics_channel";
import dns from "node:dns";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { Agent, buildConnector, type Dispatcher, EnvHttpProxyAgent } from "undici";
import { defaultNetworkSettings, type NetworkInfo, type NetworkSettings } from "./models.js";

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

interface TlsOptions {
  rejectUnauthorized?: boolean;
  ca?: (string | Buffer)[];
  cert?: Buffer;
  key?: Buffer;
  pfx?: Buffer;
  passphrase?: string;
}

function timedConnector(tlsOptions: TlsOptions): buildConnector.connector {
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

/** Whether a client-certificate host pattern covers this host (and port, when it names one). */
export function hostMatches(pattern: string, hostname: string, port: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const [host, wantPort] = p.split(":");
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (wantPort && wantPort !== (port || "443")) return false;
  return host.startsWith("*.") ? h.endsWith(host.slice(1)) && h.length > host.length - 1 : h === host;
}

/** Picks the client certificate (if any) by target host, then connects with timing. */
function connectorFor(net: NetworkSettings, tls: TlsOptions): buildConnector.connector {
  const plain = timedConnector(tls);
  const withCert = new Map<number, buildConnector.connector>();
  return (options, callback) => {
    const i = options.protocol === "https:" ? net.clientCertificates.findIndex((c) => hostMatches(c.host, options.hostname, options.port)) : -1;
    if (i < 0) return plain(options, callback);
    let connector = withCert.get(i);
    if (!connector) {
      const c = net.clientCertificates[i];
      try {
        connector = timedConnector({
          ...tls,
          ...(c.pfxPath ? { pfx: readFileSync(c.pfxPath) } : { cert: readFileSync(c.certPath), key: readFileSync(c.keyPath) }),
          ...(c.passphrase ? { passphrase: c.passphrase } : {}),
        });
      } catch (e) {
        callback(new Error(`Could not read the client certificate for ${c.host}: ${(e as Error).message}`), null);
        return null as never;
      }
      withCert.set(i, connector);
    }
    return connector(options, callback);
  };
}

// undici gives up after 300 s without headers or body data. A request's own
// timeout (or none) decides instead, so slow reports and idle streams survive.
const base = { headersTimeout: 0, bodyTimeout: 0 };

const dispatchers = new Map<string, Dispatcher>();

/** A connection pool for these network settings, reused while they stay the same. */
export function dispatcherFor(net: NetworkSettings = defaultNetworkSettings(), skipVerify = false): Dispatcher {
  const key = JSON.stringify([net, skipVerify]);
  const hit = dispatchers.get(key);
  if (hit) return hit;
  const ca = net.caCertificatePaths.length ? [...rootCertificates, ...net.caCertificatePaths.map((p) => readCa(p))] : undefined;
  const tls: TlsOptions = { ...(skipVerify || !net.verifySsl ? { rejectUnauthorized: false } : {}), ...(ca ? { ca } : {}) };
  const connect = connectorFor(net, tls);
  let dispatcher: Dispatcher;
  const p = net.proxy;
  if (p.mode === "custom" && p.url) {
    dispatcher = new EnvHttpProxyAgent({ ...base, connect, httpProxy: p.url, httpsProxy: p.url, noProxy: p.bypass, requestTls: tls, proxyTls: tls });
  } else if (p.mode === "system" && hasEnvProxy()) {
    dispatcher = new EnvHttpProxyAgent({ ...base, connect, requestTls: tls, proxyTls: tls });
  } else {
    dispatcher = new Agent({ ...base, connect });
  }
  // Settings rarely change; keep the pools of the latest few.
  if (dispatchers.size >= 4) {
    const [oldest, old] = dispatchers.entries().next().value!;
    dispatchers.delete(oldest);
    void old.close().catch(() => undefined);
  }
  dispatchers.set(key, dispatcher);
  return dispatcher;
}

function readCa(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`Could not read the CA certificate ${file}: ${(e as Error).message}`);
  }
}

const hasEnvProxy = () => ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].some((k) => !!process.env[k]);

export function defaultAgent(): Dispatcher {
  return dispatcherFor();
}
