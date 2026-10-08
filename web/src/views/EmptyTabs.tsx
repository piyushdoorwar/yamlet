import { Download, FilePlus, Layers, Search } from "lucide-react";
import { Logo } from "../components/Logo";
import { useStore } from "../lib/store";
import { useUi } from "../lib/ui";
import { useActions } from "../lib/useActions";

function Action({ icon: Icon, title, text, onClick, disabled }: { icon: typeof Layers; title: string; text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-start gap-3 rounded-lg border border-line bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-primary-tint disabled:opacity-50"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
        <Icon size={17} aria-hidden />
      </span>
      <span>
        <span className="block text-13 font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-12 text-muted">{text}</span>
      </span>
    </button>
  );
}

export function EmptyTabs() {
  const workspace = useStore((s) => s.workspace);
  const setModal = useUi((s) => s.setModal);
  const actions = useActions();
  const first = workspace?.collections[0];
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={40} />
          <div>
            <h1 className="text-lg font-medium text-ink">{workspace?.name}</h1>
            <p className="text-13 text-muted">Pick a request from the sidebar, or start something new.</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Action icon={FilePlus} title="New request" text={first ? `In ${first.name}` : "Create a collection first"} disabled={!first} onClick={() => first && void actions.newRequest(first.id, null)} />
          <Action icon={Layers} title="New collection" text="A folder of request files" onClick={() => void actions.newCollection()} />
          <Action icon={Download} title="Import" text="cURL, OpenAPI, or a v2.1 collection export" onClick={() => setModal({ kind: "import" })} />
          <Action icon={Search} title="Find a request" text="Ctrl + K" onClick={() => setModal({ kind: "quickOpen" })} />
        </div>
      </div>
    </div>
  );
}
