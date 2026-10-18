import { useMemo } from "react";
import { useDialogs } from "../components/Dialogs";
import { useToast } from "../components/Toast";
import { treeActions } from "./actions";

export function useActions() {
  const { confirm, choose, prompt } = useDialogs();
  const toast = useToast();
  return useMemo(() => treeActions({ confirm, choose, prompt, toast }), [confirm, choose, prompt, toast]);
}
