import { defaultAuth } from "@core/models";
import { FilePlus, FolderOpen, FolderPlus, Play } from "lucide-react";
import { useMemo } from "react";
import { AUTH_LABELS, AuthEditor } from "../components/AuthEditor";
import { Button } from "../components/Button";
import { MethodLabel } from "../components/Labels";
import { Card, PageHeader, SaveStatus, ScrollPage } from "../components/Page";
import { CodeEditor } from "../editor/CodeEditor";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { allRequests, findFolder } from "../lib/tree";
import { useActions } from "../lib/useActions";
import { useAutosave } from "../lib/useAutosave";
import { useVariableContext, useVariableSource, useVariableTargets } from "../lib/variables";
import { ScriptsEditor } from "./request/ScriptsEditor";

export function FolderView({ folderId }: { folderId: string }) {
  const workspace = useStore((s) => s.workspace);
  const applyWorkspace = useStore((s) => s.applyWorkspace);
  const openTab = useStore((s) => s.openTab);
  const actions = useActions();
  const loc = useMemo(() => findFolder(workspace, folderId), [workspace, folderId]);
  const source = useMemo(
    () => ({
      description: loc?.folder.description ?? "",
      auth: loc?.folder.auth ?? defaultAuth("inherit"),
      preRequestScript: loc?.folder.preRequestScript ?? "",
      postResponseScript: loc?.folder.postResponseScript ?? "",
    }),
    [loc],
  );
  const { value, update, status, error, retry } = useAutosave(source, async (v) => {
    const res = await api.updateFolder(folderId, v);
    applyWorkspace(res.workspace);
  });
  const vars = useVariableSource(useVariableContext(loc?.collection.id), useVariableTargets({ collectionId: loc?.collection.id }));
  if (!loc) return <p className="p-8 text-13 text-muted">This folder no longer exists.</p>;
  const { folder, collection } = loc;
  const requests = allRequests(folder);
  // What "Inherit" means here: the nearest outer folder with its own auth, else the collection's.
  const inherited = [...loc.folders].reverse().find((f) => f.auth && f.auth.type !== "inherit")?.auth ?? collection.auth;

  return (
    <ScrollPage>
      <PageHeader
        icon={<FolderOpen size={20} aria-hidden />}
        title={folder.name}
        subtitle={[collection.name, ...loc.folders.map((f) => f.name)].join(" / ")}
        actions={
          <>
            <SaveStatus status={status} error={error} onRetry={retry} />
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
          <CodeEditor fill lineNumbers={false} value={value.description} onChange={(description) => update((v) => ({ ...v, description }))} placeholder="Notes about the requests in this folder" ariaLabel="Folder description" />
        </div>
      </Card>
      <Card title="Authorization" className="mb-5" actions={<span className="text-12 text-muted">Used by requests inside whose auth is "Inherit".</span>}>
        <AuthEditor
          auth={value.auth}
          onChange={(auth) => update((v) => ({ ...v, auth }))}
          allowInherit
          variables={vars}
          collectionId={collection.id}
          inheritedLabel={AUTH_LABELS[inherited.type]}
        />
      </Card>
      <Card title="Folder scripts" className="mb-5" actions={<span className="text-12 text-muted">Run after the collection's pre-request script and before its post-response script.</span>}>
        <div className="flex h-72 flex-col">
          <ScriptsEditor pre={value.preRequestScript} post={value.postResponseScript} onChange={(p) => update((v) => ({ ...v, ...p }))} />
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
