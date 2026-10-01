import { useMemo } from "react";
import { useDialogs } from "../components/Dialogs";
import { useToast } from "../components/Toast";
import { treeActions } from "./actions";

export function useActions() {
  const { confirm, prompt } = useDialogs();
  const toast = useToast();
  return useMemo(() => treeActions({ confirm, prompt, toast }), [confirm, prompt, toast]);
}
