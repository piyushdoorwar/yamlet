import { Modal } from "../components/Modal";

const SHORTCUTS: [string, string][] = [
  ["Send request", "Ctrl Enter"],
  ["Save now (edits also save automatically)", "Ctrl S"],
  ["Find a request", "Ctrl K"],
  ["Close tab", "Alt W"],
  ["Next / previous tab", "Alt Right / Alt Left"],
  ["Search inside an editor", "Ctrl F"],
  ["Fold / unfold JSON", "Ctrl Shift [ / ]"],
  ["Insert a variable", "Type {{"],
  ["Insert a dynamic variable", "Type {{$"],
  ["Keyboard shortcuts", "Ctrl /"],
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" subtitle="On macOS, use Cmd in place of Ctrl." onClose={onClose} width={520}>
      <ul>
        {SHORTCUTS.map(([what, keys]) => (
          <li key={what} className="flex items-center justify-between gap-4 border-b border-line-soft py-2.5 last:border-0">
            <span className="text-13 text-body">{what}</span>
            <span className="flex gap-1">
              {keys.split(" ").map((k, i) =>
                k === "/" ? (
                  <span key={i} className="px-0.5 text-muted">
                    /
                  </span>
                ) : (
                  <kbd key={i} className="rounded border border-line bg-subtle px-1.5 py-0.5 font-mono text-11 text-grey">
                    {k}
                  </kbd>
                ),
              )}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
