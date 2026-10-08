import type { YamletCollection, YamletFolder, YamletRequest } from "@core/models";
import clsx from "clsx";
import { ChevronRight, Copy, FilePlus, Folder, FolderOpen, FolderPlus, Layers, MoreHorizontal, Pencil, Play, Settings2, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { MethodLabel } from "../components/Labels";
import { type MenuEntry, useMenu } from "../components/Menu";
import type { TreeActions } from "../lib/actions";
import { tabKey, useStore } from "../lib/store";
import { useUi } from "../lib/ui";

const NONE: never[] = [];

type Drag = { kind: "request" | "folder"; id: string; collectionId: string };
let dragging: Drag | null = null;

interface Props {
  actions: TreeActions;
  filter: string;
}

function matches(r: YamletRequest, q: string): boolean {
  return r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q) || r.method.toLowerCase() === q;
}

/** Prune a container to items matching the filter; folders survive if anything inside matches. */
function filterContainer<T extends { folders: YamletFolder[]; requests: YamletRequest[] }>(c: T, q: string): T | null {
  if (!q) return c;
  const folders = c.folders.map((f) => (f.name.toLowerCase().includes(q) ? f : filterContainer(f, q))).filter((f): f is YamletFolder => !!f);
  const requests = c.requests.filter((r) => matches(r, q));
  if (!folders.length && !requests.length) return null;
  return { ...c, folders, requests };
}

export function CollectionsTree({ actions, filter }: Props) {
  const collections = useStore((s) => s.workspace?.collections) ?? NONE;
  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      collections
        .map((c) => (c.name.toLowerCase().includes(q) ? c : filterContainer(c, q)))
        .filter((c): c is YamletCollection => !!c),
    [collections, q],
  );
  const menu = useMenu();

  if (!collections.length) {
    return (
      <div className="px-6 py-8 text-center">
        <Layers size={28} className="mx-auto text-faint" aria-hidden />
        <p className="mt-3 text-13 text-grey">No collections yet.</p>
        <button type="button" className="btn btn-primary btn-sm mt-4" onClick={() => void actions.newCollection()}>
          New collection
        </button>
      </div>
    );
  }
  if (!visible.length) return <p className="px-6 py-6 text-13 text-muted italic">Nothing matches "{filter}".</p>;

  return (
    <div role="tree" aria-label="Collections" className="pb-6">
      {visible.map((c) => (
        <CollectionNode key={c.id} collection={c} actions={actions} forceOpen={!!q} menu={menu} />
      ))}
      {menu.node}
    </div>
  );
}

type MenuApi = ReturnType<typeof useMenu>;

function CollectionNode({ collection, actions, forceOpen, menu }: { collection: YamletCollection; actions: TreeActions; forceOpen: boolean; menu: MenuApi }) {
  const open = useUi((s) => s.expanded[collection.id]) || forceOpen;
  const toggle = useUi((s) => s.toggle);
  const openTab = useStore((s) => s.openTab);
  const items: MenuEntry[] = [
    { label: "Add request", icon: FilePlus, onSelect: () => void actions.newRequest(collection.id, null) },
    { label: "Add folder", icon: FolderPlus, onSelect: () => void actions.newFolder(collection.id, null) },
    { label: "Run collection", icon: Play, onSelect: () => openTab({ kind: "runner", id: collection.id }) },
    { label: "Settings", icon: Settings2, onSelect: () => openTab({ kind: "collection", id: collection.id }) },
    "separator",
    { label: "Rename", icon: Pencil, onSelect: () => useUi.getState().setRenaming(collection.id) },
    { label: "Duplicate", icon: Copy, onSelect: () => void actions.duplicateCollection(collection.id) },
    { label: "Delete", icon: Trash2, danger: true, onSelect: () => void actions.deleteCollection(collection.id, collection.name) },
  ];
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false}>
      <Row
        id={collection.id}
        tab={{ kind: "collection", id: collection.id }}
        depth={0}
        open={open}
        onToggle={() => toggle(collection.id)}
        onActivate={() => toggle(collection.id)}
        icon={<Layers size={15} aria-hidden />}
        name={collection.name}
        bold
        onRename={(name) => void actions.renameCollection(collection.id, name)}
        menuItems={items}
        menu={menu}
        drop={{ collectionId: collection.id, folderId: null, actions, container: collection }}
      />
      {open && <Children container={collection} collectionId={collection.id} folderId={null} depth={1} actions={actions} forceOpen={forceOpen} menu={menu} />}
    </div>
  );
}

function Children({ container, collectionId, folderId, depth, actions, forceOpen, menu }: { container: { folders: YamletFolder[]; requests: YamletRequest[] }; collectionId: string; folderId: string | null; depth: number; actions: TreeActions; forceOpen: boolean; menu: MenuApi }) {
  if (!container.folders.length && !container.requests.length) {
    return (
      <p className="py-1 text-12 text-muted italic" style={{ paddingLeft: 14 + depth * 14 }}>
        Empty.{" "}
        <button type="button" className="font-medium text-primary not-italic hover:underline" onClick={() => void actions.newRequest(collectionId, folderId)}>
          Add a request
        </button>
      </p>
    );
  }
  return (
    <div role="group">
      {container.folders.map((f) => (
        <FolderNode key={f.id} folder={f} collectionId={collectionId} depth={depth} actions={actions} forceOpen={forceOpen} menu={menu} />
      ))}
      {container.requests.map((r) => (
        <RequestNode key={r.id} request={r} collectionId={collectionId} folderId={folderId} container={container} depth={depth} actions={actions} menu={menu} />
      ))}
    </div>
  );
}

function FolderNode({ folder, collectionId, depth, actions, forceOpen, menu }: { folder: YamletFolder; collectionId: string; depth: number; actions: TreeActions; forceOpen: boolean; menu: MenuApi }) {
  const open = useUi((s) => s.expanded[folder.id]) || forceOpen;
  const toggle = useUi((s) => s.toggle);
  const openTab = useStore((s) => s.openTab);
  const items: MenuEntry[] = [
    { label: "Add request", icon: FilePlus, onSelect: () => void actions.newRequest(collectionId, folder.id) },
    { label: "Add folder", icon: FolderPlus, onSelect: () => void actions.newFolder(collectionId, folder.id) },
    { label: "Run folder", icon: Play, onSelect: () => openTab({ kind: "runner", id: collectionId, folderId: folder.id }) },
    { label: "Open folder", icon: Settings2, onSelect: () => openTab({ kind: "folder", id: folder.id }) },
    "separator",
    { label: "Rename", icon: Pencil, onSelect: () => useUi.getState().setRenaming(folder.id) },
    { label: "Duplicate", icon: Copy, onSelect: () => void actions.duplicateFolder(folder.id) },
    { label: "Delete", icon: Trash2, danger: true, onSelect: () => void actions.deleteFolder(folder.id, folder.name) },
  ];
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false}>
      <Row
        id={folder.id}
        tab={{ kind: "folder", id: folder.id }}
        depth={depth}
        open={open}
        onToggle={() => toggle(folder.id)}
        onActivate={() => toggle(folder.id)}
        icon={open ? <FolderOpen size={15} aria-hidden /> : <Folder size={15} aria-hidden />}
        name={folder.name}
        onRename={(name) => void actions.renameFolder(folder.id, name)}
        menuItems={items}
        menu={menu}
        draggable={{ kind: "folder", id: folder.id, collectionId }}
        drop={{ collectionId, folderId: folder.id, actions, container: folder }}
      />
      {open && <Children container={folder} collectionId={collectionId} folderId={folder.id} depth={depth + 1} actions={actions} forceOpen={forceOpen} menu={menu} />}
    </div>
  );
}

function RequestNode({ request, collectionId, folderId, container, depth, actions, menu }: { request: YamletRequest; collectionId: string; folderId: string | null; container: { requests: YamletRequest[] }; depth: number; actions: TreeActions; menu: MenuApi }) {
  const openTab = useStore((s) => s.openTab);
  const draftName = useStore((s) => s.drafts[request.id]?.name);
  const draftMethod = useStore((s) => s.drafts[request.id]?.method);
  const items: MenuEntry[] = [
    { label: "Open", icon: FilePlus, onSelect: () => openTab({ kind: "request", id: request.id }) },
    { label: "Rename", icon: Pencil, onSelect: () => useUi.getState().setRenaming(request.id) },
    { label: "Duplicate", icon: Copy, onSelect: () => void actions.duplicateRequest(request.id) },
    "separator",
    { label: "Delete", icon: Trash2, danger: true, onSelect: () => void actions.deleteRequest(request.id, request.name) },
  ];
  return (
    <div role="treeitem" aria-selected={false}>
      <Row
        id={request.id}
        tab={{ kind: "request", id: request.id }}
        depth={depth}
        onActivate={() => openTab({ kind: "request", id: request.id })}
        icon={<MethodLabel method={draftMethod ?? request.method} short className="w-9 text-right" />}
        name={draftName ?? request.name}
        onRename={(name) => void actions.renameRequest(request.id, name)}
        menuItems={items}
        menu={menu}
        draggable={{ kind: "request", id: request.id, collectionId }}
        dropBefore={{
          collectionId,
          folderId,
          index: () => container.requests.filter((r) => r.id !== dragging?.id).findIndex((r) => r.id === request.id),
          actions,
        }}
      />
    </div>
  );
}

interface RowProps {
  id: string;
  tab: { kind: "request" | "collection" | "folder"; id: string };
  depth: number;
  open?: boolean;
  onToggle?: () => void;
  onActivate: () => void;
  icon: ReactNode;
  name: string;
  bold?: boolean;
  onRename: (name: string) => void;
  menuItems: MenuEntry[];
  menu: MenuApi;
  draggable?: Drag;
  /** Dropping onto this row moves the dragged item into this container. */
  drop?: { collectionId: string; folderId: string | null; actions: TreeActions; container: { folders: YamletFolder[]; requests: YamletRequest[] } };
  /** Dropping onto this row places a dragged request just before it. */
  dropBefore?: { collectionId: string; folderId: string | null; index: () => number; actions: TreeActions };
}

function Row({ id, tab, depth, open, onToggle, onActivate, icon, name, bold, onRename, menuItems, menu, draggable, drop, dropBefore }: RowProps) {
  const active = useStore((s) => s.active === tabKey(tab));
  const renaming = useUi((s) => s.renaming === id);
  const [over, setOver] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const canDrop = (d: Drag | null) => {
    if (!d || d.id === id) return false;
    if (dropBefore) return d.kind === "request";
    return !!drop;
  };

  return (
    <div
      className={clsx(
        "group relative mx-2 flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-13 select-none",
        active ? "bg-primary text-white" : "text-body hover:bg-primary-soft",
        over && !active && "ring-1 ring-primary ring-inset",
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={onActivate}
      onContextMenu={(e) => menu.openAt(e, menuItems)}
      draggable={!!draggable && !renaming}
      onDragStart={(e) => {
        if (!draggable) return;
        dragging = draggable;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", draggable.id);
      }}
      onDragEnd={() => {
        dragging = null;
      }}
      onDragOver={(e) => {
        if (!canDrop(dragging)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const d = dragging;
        dragging = null;
        if (!d || !canDrop(d)) return;
        if (dropBefore) {
          void dropBefore.actions.move(d.kind, d.id, dropBefore.collectionId, dropBefore.folderId, Math.max(0, dropBefore.index()));
        } else if (drop) {
          const list = d.kind === "folder" ? drop.container.folders : drop.container.requests;
          useUi.getState().toggle(drop.folderId ?? drop.collectionId, true);
          void drop.actions.move(d.kind, d.id, drop.collectionId, drop.folderId, list.filter((x) => x.id !== d.id).length);
        }
      }}
    >
      {onToggle ? (
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          className={clsx("rounded p-0.5", active ? "text-white" : "text-muted")}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <ChevronRight size={14} className={clsx("transition-transform", open && "rotate-90")} aria-hidden />
        </button>
      ) : (
        <span className="w-1" />
      )}
      <span className={clsx("flex shrink-0 items-center", active ? "text-white [&_span]:text-white" : "text-grey")}>{icon}</span>
      {renaming ? (
        <RenameInput initial={name} onDone={(v) => {
          useUi.getState().setRenaming(null);
          if (v && v !== name) onRename(v);
        }} />
      ) : (
        <span className={clsx("min-w-0 flex-1 truncate", bold && "font-medium")} title={name} onDoubleClick={(e) => {
          e.stopPropagation();
          useUi.getState().setRenaming(id);
        }}>
          {name}
        </span>
      )}
      {!renaming && (
        <button
          ref={moreRef}
          type="button"
          aria-label={`Actions for ${name}`}
          className={clsx("rounded p-1 opacity-0 group-hover:opacity-100 focus:opacity-100", active ? "text-white hover:bg-surface/15" : "text-grey hover:bg-surface")}
          onClick={(e) => {
            e.stopPropagation();
            if (moreRef.current) menu.openBelow(moreRef.current, menuItems, "end");
          }}
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v?.trim() || null);
  };
  return (
    <input
      ref={ref}
      aria-label="Name"
      className="h-6 min-w-0 flex-1 rounded border border-primary bg-surface px-1.5 text-13 text-ink outline-none"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}
