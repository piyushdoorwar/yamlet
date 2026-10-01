import type { YamletRequest } from "@core/models";
import type { ConfirmOptions, PromptOptions } from "../components/Dialogs";
import { api, errorMessage } from "./api";
import { useStore } from "./store";
import { findRequest } from "./tree";
import { useUi } from "./ui";

interface Ctx {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: PromptOptions) => Promise<string | null>;
  toast: { error: (s: string, d?: string) => void; success: (s: string, d?: string) => void };
}

async function guard<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    ctx.toast.error(what, errorMessage(err));
    return undefined;
  }
}

const apply = (r: { workspace: Parameters<ReturnType<typeof useStore.getState>["applyWorkspace"]>[0] }) => useStore.getState().applyWorkspace(r.workspace);

/** Tree and toolbar actions shared by the sidebar, context menus and empty states. */
export function treeActions(ctx: Ctx) {
  const store = () => useStore.getState();
  const ui = () => useUi.getState();

  return {
    async newCollection() {
      const name = await ctx.prompt({ title: "New collection", label: "Name", initial: "New Collection", action: "Create" });
      if (!name) return;
      const res = await guard(ctx, "Could not create the collection", () => api.createCollection(name));
      if (!res) return;
      apply(res);
      ui().toggle(res.item.id, true);
      ui().setSection("collections");
      store().openTab({ kind: "collection", id: res.item.id });
    },

    async newRequest(collectionId: string, folderId: string | null, init?: Partial<YamletRequest>) {
      const res = await guard(ctx, "Could not create the request", () => api.createRequest(collectionId, folderId, init ?? { name: "New Request" }));
      if (!res) return;
      apply(res);
      ui().toggle(collectionId, true);
      if (folderId) ui().toggle(folderId, true);
      store().openTab({ kind: "request", id: res.item.id });
      ui().setRenaming(res.item.id);
    },

    async newFolder(collectionId: string, parentId: string | null) {
      const name = await ctx.prompt({ title: "New folder", label: "Name", initial: "New Folder", action: "Create" });
      if (!name) return;
      const res = await guard(ctx, "Could not create the folder", () => api.createFolder(collectionId, parentId, name));
      if (!res) return;
      apply(res);
      ui().toggle(collectionId, true);
      if (parentId) ui().toggle(parentId, true);
      ui().toggle(res.item.id, true);
    },

    async renameCollection(id: string, name: string) {
      const res = await guard(ctx, "Could not rename the collection", () => api.updateCollection(id, { name }));
      if (res) apply(res);
    },
    async renameFolder(id: string, name: string) {
      const res = await guard(ctx, "Could not rename the folder", () => api.updateFolder(id, { name }));
      if (res) apply(res);
    },
    async renameRequest(id: string, name: string) {
      await store().saveNow(id);
      const s = store();
      const current = s.drafts[id];
      const res = await guard(ctx, "Could not rename the request", async () => {
        const base = current ?? findRequest(s.workspace, id)?.request;
        if (!base) throw new Error("Request not found");
        return api.saveRequest({ ...base, name });
      });
      if (!res) return;
      const drafts = { ...store().drafts };
      if (drafts[id]) drafts[id] = { ...drafts[id], name, sourceFilePath: res.item.sourceFilePath };
      useStore.setState({ drafts });
      apply(res);
    },

    async duplicateRequest(id: string) {
      await store().saveNow(id);
      const res = await guard(ctx, "Could not duplicate the request", () => api.duplicateRequest(id));
      if (!res) return;
      apply(res);
      store().openTab({ kind: "request", id: res.item.id });
    },
    async duplicateFolder(id: string) {
      const res = await guard(ctx, "Could not duplicate the folder", () => api.duplicateFolder(id));
      if (res) apply(res);
    },
    async duplicateCollection(id: string) {
      const res = await guard(ctx, "Could not duplicate the collection", () => api.duplicateCollection(id));
      if (res) apply(res);
    },

    async deleteRequest(id: string, name: string) {
      const ok = await ctx.confirm({ title: "Delete request", message: <>Delete <b>{name}</b>? Its YAML file is removed from disk.</>, action: "Delete", danger: true });
      if (!ok) return;
      const res = await guard(ctx, "Could not delete the request", () => api.deleteRequest(id));
      if (res) apply(res);
    },
    async deleteFolder(id: string, name: string) {
      const ok = await ctx.confirm({ title: "Delete folder", message: <>Delete <b>{name}</b> and every request inside it?</>, action: "Delete", danger: true });
      if (!ok) return;
      const res = await guard(ctx, "Could not delete the folder", () => api.deleteFolder(id));
      if (res) apply(res);
    },
    async deleteCollection(id: string, name: string) {
      const ok = await ctx.confirm({ title: "Delete collection", message: <>Delete <b>{name}</b> and every request inside it? Its folder is removed from disk.</>, action: "Delete", danger: true });
      if (!ok) return;
      const res = await guard(ctx, "Could not delete the collection", () => api.deleteCollection(id));
      if (res) apply(res);
    },

    async move(kind: "request" | "folder", id: string, targetCollectionId: string, targetFolderId: string | null, index: number) {
      if (kind === "request") await store().saveNow(id);
      const res = await guard(ctx, "Could not move the item", () => api.move({ kind, id, targetCollectionId, targetFolderId, index }));
      if (res) apply(res);
    },

    async newEnvironment() {
      const name = await ctx.prompt({ title: "New environment", label: "Name", initial: "dev", action: "Create" });
      if (!name) return;
      const res = await guard(ctx, "Could not create the environment", () => api.createEnvironment(name));
      if (!res) return;
      apply(res);
      store().setEnvironment(res.item.id);
      store().openTab({ kind: "environment", id: res.item.id });
    },
    async renameEnvironment(id: string, name: string) {
      const env = store().workspace?.environments.find((e) => e.id === id);
      if (!env) return;
      const res = await guard(ctx, "Could not rename the environment", () => api.saveEnvironment({ ...env, name }));
      if (res) apply(res);
    },
    async duplicateEnvironment(id: string) {
      const res = await guard(ctx, "Could not duplicate the environment", () => api.duplicateEnvironment(id));
      if (res) apply(res);
    },
    async deleteEnvironment(id: string, name: string) {
      const ok = await ctx.confirm({ title: "Delete environment", message: <>Delete <b>{name}</b>?</>, action: "Delete", danger: true });
      if (!ok) return;
      const res = await guard(ctx, "Could not delete the environment", () => api.deleteEnvironment(id));
      if (res) apply(res);
    },

    async reload() {
      const res = await guard(ctx, "Could not reload the workspace", () => api.reloadWorkspace());
      if (res) {
        apply(res);
        ctx.toast.success("Workspace reloaded from disk");
      }
    },
  };
}

export type TreeActions = ReturnType<typeof treeActions>;
