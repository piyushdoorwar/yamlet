import { ExternalLink } from "lucide-react";
import { Wordmark } from "../components/Logo";
import { Modal } from "../components/Modal";
import { useStore } from "../lib/store";

const LINKS = [
  { label: "GitHub", href: "https://github.com/piyushdoorwar/yamlet" },
  { label: "Releases", href: "https://github.com/piyushdoorwar/yamlet/releases" },
  { label: "Website", href: "https://piyushdoorwar.github.io/yamlet/" },
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
