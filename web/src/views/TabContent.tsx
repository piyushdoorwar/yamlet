import { tabKey, useStore } from "../lib/store";
import { CollectionView } from "./CollectionView";
import { EmptyTabs } from "./EmptyTabs";
import { EnvironmentView, GlobalsView } from "./EnvironmentView";
import { FolderView } from "./FolderView";
import { RequestView } from "./request/RequestView";
import { RunnerView } from "./RunnerView";

/** Renders the active tab. Request tabs stay mounted so editor state survives tab switches. */
export function TabContent() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const current = tabs.find((t) => tabKey(t) === active);
  if (!current) return <EmptyTabs />;
  return (
    <>
      {tabs
        .filter((t) => t.kind === "request" || t.kind === "runner")
        .map((t) => (
          <div key={tabKey(t)} className="h-full" hidden={tabKey(t) !== active}>
            {t.kind === "request" ? <RequestView requestId={t.id} /> : <RunnerView collectionId={t.id} folderId={t.folderId} />}
          </div>
        ))}
      {current.kind === "collection" && <CollectionView key={current.id} collectionId={current.id} />}
      {current.kind === "folder" && <FolderView key={current.id} folderId={current.id} />}
      {current.kind === "environment" && <EnvironmentView key={current.id} environmentId={current.id} />}
      {current.kind === "globals" && <GlobalsView />}
    </>
  );
}
