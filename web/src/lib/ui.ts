import { create } from "zustand";

export type ModalState =
  | { kind: "import" }
  | { kind: "cookies" }
  | { kind: "about" }
  | { kind: "quickOpen" }
  | { kind: "openWorkspace" }
  | { kind: "shortcuts" }
  | { kind: "snippet"; requestId: string }
  | null;

export type SidebarSection = "collections" | "environments" | "history";

interface Ui {
  modal: ModalState;
  section: SidebarSection;
  /** Tree folders/collections the user expanded. */
  expanded: Record<string, boolean>;
  /** Tree item to rename inline. */
  renaming: string | null;
  setModal: (m: ModalState) => void;
  setSection: (s: SidebarSection) => void;
  toggle: (id: string, open?: boolean) => void;
  setRenaming: (id: string | null) => void;
}

export const useUi = create<Ui>((set) => ({
  modal: null,
  section: "collections",
  expanded: {},
  renaming: null,
  setModal: (modal) => set({ modal }),
  setSection: (section) => set({ section }),
  toggle: (id, open) => set((s) => ({ expanded: { ...s.expanded, [id]: open ?? !s.expanded[id] } })),
  setRenaming: (renaming) => set({ renaming }),
}));
