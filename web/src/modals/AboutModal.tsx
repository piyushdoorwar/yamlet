import { ArrowUpCircle, Check, CircleCheck, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Wordmark } from "../components/Logo";
import { Modal } from "../components/Modal";
import { copyText } from "../lib/format";
import { useStore } from "../lib/store";
import { CONTAINER_UPDATE_COMMAND, useUpdates } from "../lib/updates";

const LINKS = [
  { label: "GitHub", href: "https://github.com/piyushdoorwar/yamlet" },
  { label: "Releases", href: "https://github.com/piyushdoorwar/yamlet/releases" },
  { label: "Website", href: "https://yamlet.piyushdoorwar.com/" },
];

export function AboutModal({ onClose }: { onClose: () => void }) {
  const info = useStore((s) => s.info);
  const workspace = useStore((s) => s.workspace);
  const rows: [string, string][] = [
    ["Version", info?.version ?? "dev"],
    ["Running in", info?.inContainer ? "Container" : "Node.js"],
    ["Workspace", workspace?.rootPath ?? "None"],
    ["Browse root", info?.browseRoot ?? ""],
  ];
  return (
    <Modal onClose={onClose} width={460}>
      <div className="flex flex-col items-center pt-2 text-center">
        <Wordmark />
        <p className="mt-3 text-13 text-muted">A local-first API client for Git-friendly YAML collections.</p>
      </div>
      <dl className="mt-6 rounded-lg border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-4 border-b border-line-soft px-4 py-2.5 last:border-0">
            <dt className="w-28 shrink-0 text-13 text-grey">{k}</dt>
            <dd className="min-w-0 truncate font-mono text-12 text-ink" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <UpdateSection inContainer={!!info?.inContainer} />
      <div className="mt-5 flex justify-center gap-5">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-13 font-medium text-primary hover:underline">
            {l.label} <ExternalLink size={12} aria-hidden />
          </a>
        ))}
      </div>
    </Modal>
  );
}

function UpdateSection({ inContainer }: { inContainer: boolean }) {
  const { info, checking, refresh } = useUpdates();
  const [copied, setCopied] = useState(false);
  if (!info?.enabled) return null;

  if (!info.available) {
    return (
      <div className="mt-4 flex items-center gap-2 text-12 text-muted">
        <CircleCheck size={14} className="shrink-0 text-primary" aria-hidden />
        <span className="flex-1">
          {info.error && !info.latest ? "Could not check for updates." : "You are on the latest version."}
          {info.checkedAt && ` Checked ${new Date(info.checkedAt).toLocaleTimeString()}.`}
        </span>
        <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary-soft disabled:opacity-60" disabled={checking} onClick={() => void refresh(true)}>
          {checking ? <Loader2 size={12} className="spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />} Check now
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-line bg-primary-tint p-4 text-left">
      <p className="flex items-center gap-2 text-13 font-medium text-ink">
        <ArrowUpCircle size={16} className="text-primary" aria-hidden />
        Yamlet {info.latest} is available
        <span className="font-normal text-muted">(you have {info.current})</span>
      </p>
      {inContainer ? (
        <>
          <p className="mt-2 text-12 text-grey">Run this from your workspace folder. Your collections and pairing are kept; add back any extra flags you started Yamlet with.</p>
          <div className="relative mt-2">
            <pre className="overflow-x-auto rounded-md border border-line bg-surface p-3 pr-10 font-mono text-11 leading-5 text-ink">{CONTAINER_UPDATE_COMMAND}</pre>
            <button
              type="button"
              className="absolute top-2 right-2 rounded p-1.5 text-muted hover:bg-primary-soft hover:text-primary"
              aria-label={copied ? "Copied" : "Copy commands"}
              title={copied ? "Copied" : "Copy"}
              onClick={async () => setCopied(await copyText(CONTAINER_UPDATE_COMMAND))}
            >
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-12 text-grey">Pull the latest source and rebuild, or switch to the container image.</p>
      )}
      {info.releaseUrl && (
        <a href={info.releaseUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-12 font-medium text-primary hover:underline">
          What's new in {info.latest} <ExternalLink size={12} aria-hidden />
        </a>
      )}
    </div>
  );
}
