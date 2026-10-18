import type { YamletResponse } from "@core/models";
import { Globe, Lock } from "lucide-react";
import { HoverCard } from "../../components/HoverCard";
import { formatBytes, formatMs } from "../../lib/format";

const ms = (n: number) => (n < 10 ? `${n.toFixed(1)} ms` : formatMs(n));

/** Total time, with the phases of the exchange on hover. */
export function TimeBreakdown({ r }: { r: YamletResponse }) {
  const t = r.timings;
  const connect = (t.dns ?? 0) + (t.tcp ?? 0) + (t.tls ?? 0);
  const phases: [string, number | undefined][] = [
    ["DNS lookup", t.dns],
    ["TCP handshake", t.tcp],
    ["TLS handshake", t.tls],
    ["Waiting (TTFB)", t.firstByte !== undefined ? Math.max(0, t.firstByte - connect) : undefined],
    ["Download", t.download],
  ];
  const shown = phases.filter((p): p is [string, number] => p[1] !== undefined);
  const total = Math.max(1, t.total);
  let offset = 0;
  const card = (
    <div className="flex flex-col gap-1.5">
      {shown.map(([name, value]) => {
        const left = (offset / total) * 100;
        offset += value;
        return (
          <div key={name} className="grid grid-cols-[7.5rem_1fr_4rem] items-center gap-2">
            <span className="text-grey">{name}</span>
            <span className="relative h-2 rounded-sm bg-line-soft">
              <span className="absolute inset-y-0 rounded-sm bg-primary" style={{ left: `${left}%`, width: `${Math.max(1, (value / total) * 100)}%` }} />
            </span>
            <span className="text-right font-mono text-11">{ms(value)}</span>
          </div>
        );
      })}
      <div className="mt-1 flex justify-between border-t border-line-soft pt-1.5 font-medium">
        <span>Total</span>
        <span className="font-mono text-11">{ms(t.total)}</span>
      </div>
      {t.reusedConnection && <p className="text-11 text-muted">Sent over an open connection, so there was no DNS, TCP or TLS setup.</p>}
    </div>
  );
  return (
    <HoverCard label={`Time ${formatMs(r.durationMs)}, hover for the breakdown`} card={card} width={300}>
      <span className="text-muted">Time</span> <b className="font-medium text-primary">{formatMs(r.durationMs)}</b>
    </HoverCard>
  );
}

/** Size, with compressed and header sizes on hover. */
export function SizeBreakdown({ r }: { r: YamletResponse }) {
  const headerBytes = r.headers.reduce((n, h) => n + h.key.length + h.value.length + 4, 0);
  const card = (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
      <dt className="text-grey">Body</dt>
      <dd className="text-right font-mono text-11">{formatBytes(r.sizeBytes)}</dd>
      {r.encodedSizeBytes !== undefined && (
        <>
          <dt className="text-grey">Body on the wire (compressed)</dt>
          <dd className="text-right font-mono text-11">{formatBytes(r.encodedSizeBytes)}</dd>
        </>
      )}
      <dt className="text-grey">Headers (approx.)</dt>
      <dd className="text-right font-mono text-11">{formatBytes(headerBytes)}</dd>
    </dl>
  );
  return (
    <HoverCard label={`Size ${formatBytes(r.sizeBytes)}, hover for details`} card={card} width={260}>
      <span className="text-muted">Size</span> <b className="font-medium text-primary">{formatBytes(r.sizeBytes)}</b>
    </HoverCard>
  );
}

function Row({ k, v }: { k: string; v?: string | number }) {
  if (v === undefined || v === "") return null;
  return (
    <>
      <dt className="text-grey">{k}</dt>
      <dd className="min-w-0 font-mono text-11 break-all">{v}</dd>
    </>
  );
}

/** Where the request went: addresses, protocol and the TLS certificate. */
export function NetworkBadge({ r }: { r: YamletResponse }) {
  const n = r.network;
  if (!n) return null;
  const tls = n.tls;
  const card = (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1">
        <Row k="HTTP version" v={n.httpVersion} />
        <Row k="Remote address" v={n.remoteAddress && `${n.remoteAddress}:${n.remotePort}`} />
        <Row k="Local address" v={n.localAddress && `${n.localAddress}:${n.localPort}`} />
      </dl>
      {tls && (
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 border-t border-line-soft pt-2">
          <Row k="TLS protocol" v={tls.protocol} />
          <Row k="Cipher" v={tls.cipher} />
          <Row k="Issued to" v={tls.certificate?.subject} />
          <Row k="Issued by" v={tls.certificate?.issuer} />
          <Row k="Valid until" v={tls.certificate?.validTo} />
          <Row k="Not trusted" v={tls.authorizationError} />
        </dl>
      )}
    </div>
  );
  const Icon = tls ? Lock : Globe;
  return (
    <HoverCard label="Network details" card={card} width={340}>
      <Icon size={13} className={tls?.authorizationError ? "text-warning" : "text-muted"} aria-hidden />
    </HoverCard>
  );
}
