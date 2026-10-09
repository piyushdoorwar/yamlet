import type { YamletRequest } from "@core/models";
import { Check, ChevronRight, CircleAlert, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useToast } from "../../components/Toast";
import { useStore } from "../../lib/store";
import { findRequest } from "../../lib/tree";
import { useActions } from "../../lib/useActions";
import { upsertVariable, useVariableContext, useVariableSource, useVariableTargets } from "../../lib/variables";
import { RenameInput } from "../../sidebar/CollectionsTree";
import { useUi } from "../../lib/ui";
import { RequestPanes } from "./RequestPanes";
import { ResponsePanel } from "./ResponsePanel";
import { UrlBar } from "./UrlBar";

function SaveIndicator({ id }: { id: string }) {
  const state = useStore((s) => s.saveState[id]);
  const error = useStore((s) => s.saveErrors[id]);
  const toast = useToast();
  useEffect(() => {
    if (error) toast.error("Changes not saved", `${error}. Your edits are kept here; use Retry to save them again.`);
  }, [error, toast]);
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1 text-11 text-muted">
        <Loader2 size={12} className="spin" aria-hidden /> Saving
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="flex items-center gap-2 text-11 text-danger" title={error}>
        <span className="flex items-center gap-1">
          <CircleAlert size={12} aria-hidden /> Not saved
        </span>
        <button type="button" className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary-soft" onClick={() => void useStore.getState().saveNow(id)}>
          Retry
        </button>
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="flex items-center gap-1 text-11 text-muted">
        <Check size={12} aria-hidden /> Saved to disk
      </span>
    );
  }
  return null;
}

export function RequestView({ requestId }: { requestId: string }) {
  const workspace = useStore((s) => s.workspace);
  const draft = useStore((s) => s.drafts[requestId]);
  const updateDraft = useStore((s) => s.updateDraft);
  const layout = useStore((s) => s.layout);
  const renaming = useUi((s) => s.renaming === requestId);
  const actions = useActions();
  const loc = useMemo(() => findRequest(workspace, requestId), [workspace, requestId]);
  const request = draft ?? loc?.request;
  const ctx = useVariableContext(loc?.collection.id, request?.variables);
  const update = useCallback((fn: (r: YamletRequest) => YamletRequest) => updateDraft(requestId, fn), [updateDraft, requestId]);
  const writeRequestVariable = useCallback(
    (name: string, value: string) => update((r) => ({ ...r, variables: upsertVariable(r.variables, name, value) })),
    [update],
  );
  const targets = useVariableTargets({ collectionId: loc?.collection.id, request: writeRequestVariable });
  const variables = useVariableSource(ctx, targets);

  if (!request || !loc) {
    return <p className="p-8 text-13 text-muted">This request no longer exists on disk.</p>;
  }

  const crumbs = [loc.collection.name, ...loc.folders.map((f) => f.name)];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-5 pt-3 text-13">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5 text-muted">
            <span className="max-w-40 truncate">{c}</span>
            <ChevronRight size={13} aria-hidden />
          </span>
        ))}
        {renaming ? (
          <span className="w-72">
            <RenameInput
              initial={request.name}
              onDone={(v) => {
                useUi.getState().setRenaming(null);
                if (v && v !== request.name) void actions.renameRequest(requestId, v);
              }}
            />
          </span>
        ) : (
          <button type="button" title="Rename" className="truncate rounded px-1 font-medium text-ink hover:bg-line-soft" onClick={() => useUi.getState().setRenaming(requestId)}>
            {request.name}
          </button>
        )}
        <span className="ml-auto">
          <SaveIndicator id={requestId} />
        </span>
      </div>
      <UrlBar request={request} update={update} variables={variables} />
      <div className="min-h-0 flex-1 border-t border-line-soft">
        <Group key={layout} orientation={layout === "side" ? "horizontal" : "vertical"} id={`yamlet-request-${layout}`}>
          <Panel id="req" defaultSize="52%" minSize={layout === "side" ? 320 : 140}>
            <div className="h-full bg-canvas">
              <RequestPanes request={request} collection={loc.collection} update={update} variables={variables} />
            </div>
          </Panel>
          <Separator className={layout === "side" ? "w-px" : "h-px"} />
          <Panel id="res" minSize={layout === "side" ? 320 : 120}>
            <ResponsePanel request={request} update={update} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
