import { FilePlus, FolderOpen, FolderPlus, Play } from "lucide-react";
import { useMemo } from "react";
import { Button } from "../components/Button";
import { MethodLabel } from "../components/Labels";
import { Card, PageHeader, SaveStatus, ScrollPage } from "../components/Page";
import { CodeEditor } from "../editor/CodeEditor";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { allRequests, findFolder } from "../lib/tree";
import { useActions } from "../lib/useActions";
import { useAutosave } from "../lib/useAutosave";

export function FolderView({ folderId }: { folderId: string }) {
  const workspace = useStore((s) => s.workspace);
  const applyWorkspace = useStore((s) => s.applyWorkspace);
  const openTab = useStore((s) => s.openTab);
  const actions = useActions();
  const loc = useMemo(() => findFolder(workspace, folderId), [workspace, folderId]);
  const { value, update, status, error } = useAutosave(loc?.folder.description ?? "", async (description) => {
    const res = await api.updateFolder(folderId, { description });
    applyWorkspace(res.workspace);
  });
  if (!loc) return <p className="p-8 text-13 text-muted">This folder no longer exists.</p>;
  const { folder, collection } = loc;
  const requests = allRequests(folder);

  return (
    <ScrollPage>
      <PageHeader
        icon={<FolderOpen size={20} aria-hidden />}
        title={folder.name}
        subtitle={[collection.name, ...loc.folders.map((f) => f.name)].join(" / ")}
        actions={
          <>
            <SaveStatus status={status} error={error} />
            <Button variant="cancel" icon={FolderPlus} onClick={() => void actions.newFolder(collection.id, folder.id)}>
              Add folder
            </Button>
            <Button variant="cancel" icon={FilePlus} onClick={() => void actions.newRequest(collection.id, folder.id)}>
              Add request
            </Button>
            <Button icon={Play} onClick={() => openTab({ kind: "runner", id: collection.id, folderId: folder.id })}>
              Run folder
            </Button>
          </>
        }
      />
      <Card title="Description" className="mb-5">
        <div className="h-44 overflow-hidden rounded-lg border border-line">
          <CodeEditor fill lineNumbers={false} value={value} onChange={update} placeholder="Notes about the requests in this folder" ariaLabel="Folder description" />
        </div>
      </Card>
      <Card title={`Requests (${requests.length})`} flush>
        {requests.length === 0 ? (
          <p className="p-5 text-13 text-muted italic">No requests in this folder yet.</p>
        ) : (
          <ul>
            {requests.map(({ request, path }) => (
              <li key={request.id} className="border-b border-line-soft last:border-0">
                <button type="button" className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-primary-soft" onClick={() => openTab({ kind: "request", id: request.id })}>
                  <MethodLabel method={request.method} className="w-14" />
                  <span className="text-13 text-ink">{[...path, request.name].join(" / ")}</span>
                  <span className="ml-auto truncate font-mono text-11 text-muted">{request.url}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </ScrollPage>
  );
}
