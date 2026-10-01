import type { Auth, Variable, YamletCollection } from "@core/models";
import { FilePlus, FolderPlus, Layers, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { AuthEditor } from "../components/AuthEditor";
import { Button } from "../components/Button";
import { KeyValueTable } from "../components/KeyValueTable";
import { Card, PageHeader, SaveStatus, ScrollPage } from "../components/Page";
import { TabButton } from "../components/Tabs";
import { CodeEditor } from "../editor/CodeEditor";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { countRequests } from "../lib/tree";
import { useActions } from "../lib/useActions";
import { useAutosave } from "../lib/useAutosave";
import { useVariableContext, useVariableSource } from "../lib/variables";
import { ScriptsEditor } from "./request/ScriptsEditor";

type Section = "overview" | "variables" | "auth" | "scripts";
type Editable = Pick<YamletCollection, "description" | "variables" | "auth" | "preRequestScript" | "postResponseScript">;

const blankVar = (): Variable => ({ key: "", value: "", enabled: true });

export function CollectionView({ collectionId }: { collectionId: string }) {
  const collection = useStore((s) => s.workspace?.collections.find((c) => c.id === collectionId));
  const applyWorkspace = useStore((s) => s.applyWorkspace);
  const openTab = useStore((s) => s.openTab);
  const actions = useActions();
  const [section, setSection] = useState<Section>("overview");

  const source = useMemo<Editable>(
    () => ({
      description: collection?.description ?? "",
      variables: collection?.variables ?? [],
      auth: collection?.auth as Auth,
      preRequestScript: collection?.preRequestScript ?? "",
      postResponseScript: collection?.postResponseScript ?? "",
    }),
    [collection],
  );
  const { value, update, status, error } = useAutosave(source, async (v) => {
    const res = await api.updateCollection(collectionId, v);
    applyWorkspace(res.workspace);
  });
  const ctx = useVariableContext(collectionId);
  const vars = useVariableSource(useMemo(() => ({ ...ctx, collection: value.variables }), [ctx, value.variables]));

  if (!collection) return <p className="p-8 text-13 text-muted">This collection no longer exists.</p>;

  return (
    <ScrollPage>
      <PageHeader
        icon={<Layers size={20} aria-hidden />}
        title={collection.name}
        subtitle={`${countRequests(collection)} requests · ${collection.directoryPath ?? ""}`}
        actions={
          <>
            <SaveStatus status={status} error={error} />
            <Button variant="cancel" icon={FolderPlus} onClick={() => void actions.newFolder(collection.id, null)}>
              Add folder
            </Button>
            <Button variant="cancel" icon={FilePlus} onClick={() => void actions.newRequest(collection.id, null)}>
              Add request
            </Button>
            <Button icon={Play} onClick={() => openTab({ kind: "runner", id: collection.id })}>
              Run
            </Button>
          </>
        }
      />
      <div className="mb-5">
        <TabButton<Section>
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "variables", label: `Variables (${value.variables.length})` },
            { id: "auth", label: "Authorization" },
            { id: "scripts", label: "Scripts" },
          ]}
          active={section}
          onChange={setSection}
        />
      </div>

      {section === "overview" && (
        <Card title="Description">
          <div className="h-64 overflow-hidden rounded-lg border border-line">
            <CodeEditor fill lineNumbers={false} value={value.description ?? ""} onChange={(description) => update((v) => ({ ...v, description }))} placeholder="What this API is, how to authenticate, links…" ariaLabel="Collection description" />
          </div>
        </Card>
      )}
      {section === "variables" && (
        <Card title="Collection variables" actions={<span className="text-12 text-muted">Override environment and globals; overridden by request variables.</span>}>
          <KeyValueTable<Variable> rows={value.variables} onChange={(variables) => update((v) => ({ ...v, variables }))} blank={blankVar} variables={vars} keyPlaceholder="Variable" secrets />
        </Card>
      )}
      {section === "auth" && (
        <Card title="Authorization" actions={<span className="text-12 text-muted">Used by requests whose auth is "Inherit".</span>}>
          <AuthEditor auth={value.auth} onChange={(auth) => update((v) => ({ ...v, auth }))} allowInherit={false} variables={vars} collectionId={collection.id} />
        </Card>
      )}
      {section === "scripts" && (
        <Card title="Collection scripts" actions={<span className="text-12 text-muted">Run around every request in this collection.</span>}>
          <div className="flex h-96 flex-col">
            <ScriptsEditor pre={value.preRequestScript} post={value.postResponseScript} onChange={(p) => update((v) => ({ ...v, ...p }))} />
          </div>
        </Card>
      )}
    </ScrollPage>
  );
}
