import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import { closeHoverTooltips, Decoration, EditorView, hoverTooltip, keymap, MatchDecorator, showTooltip, type Tooltip, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import clsx from "clsx";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DYNAMIC_VARIABLES } from "@core/dynamicVariables";
import { PM_COMPLETIONS } from "./pmCompletions";
import { isResolved, VariablePeek, type VariableSource } from "./VariablePeek";

export type { VariableInfo, VariableSource, VariableTarget } from "./VariablePeek";

export type EditorLanguage = "json" | "javascript" | "xml" | "html" | "yaml" | "text" | "graphql";

export interface CodeEditorHandle {
  focus: () => void;
  view: () => EditorView | undefined;
}

interface Props {
  value: string;
  onChange?: (value: string) => void;
  language?: EditorLanguage;
  readOnly?: boolean;
  singleLine?: boolean;
  placeholder?: string;
  variables?: VariableSource;
  onSubmit?: () => void;
  className?: string;
  /** Fill the parent's height (multi-line only). */
  fill?: boolean;
  minHeight?: number;
  lineNumbers?: boolean;
  ariaLabel?: string;
}

const PLACEHOLDER = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;
// Colors come from CSS variables in styles.css, so the editor follows the OS light/dark setting.
const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--color-surface)", color: "var(--color-body)" },
  ".cm-content": { caretColor: "var(--color-primary)" },
  ".cm-cursor": { borderLeftColor: "var(--color-primary)" },
  ".cm-gutters": { backgroundColor: "var(--color-subtle)", color: "var(--color-placeholder)", border: "none", borderRight: "1px solid var(--color-line-soft)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-primary-tint)", color: "var(--color-grey)" },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--editor-selection) !important" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-primary-tint)", border: "1px solid var(--editor-fold-line)", color: "var(--color-primary)", padding: "0 4px", borderRadius: "4px" },
  ".cm-placeholder": { color: "var(--color-placeholder)" },
  ".cm-searchMatch": { backgroundColor: "var(--editor-search)" },
  ".cm-panels": { backgroundColor: "var(--color-subtle)", color: "var(--color-body)", borderColor: "var(--color-line)" },
  ".cm-tooltip": { backgroundColor: "var(--color-surface)", color: "var(--color-body)", borderColor: "var(--color-line)" },
});

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--syn-property)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--syn-atom)", fontWeight: "500" },
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword], color: "var(--syn-keyword)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-property)" },
  { tag: [t.tagName], color: "var(--syn-property)" },
  { tag: [t.attributeName], color: "var(--syn-number)" },
  { tag: [t.typeName, t.className], color: "var(--syn-type)" },
  { tag: [t.punctuation, t.bracket], color: "var(--syn-punct)" },
  { tag: t.invalid, color: "var(--color-danger)" },
]);

function languageExtension(lang: EditorLanguage): Extension {
  switch (lang) {
    case "json":
      return json();
    case "javascript":
      return javascript();
    case "xml":
      return xml();
    case "html":
      return html();
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

interface PinnedPeek {
  name: string;
  tooltip: Tooltip;
}

function variableExtensions(source: VariableSource): { ext: Extension; complete: (ctx: CompletionContext) => CompletionResult | null } {
  const decorator = new MatchDecorator({
    regexp: PLACEHOLDER,
    decoration: (m) => Decoration.mark({ class: isResolved(source, m[1]) ? "cm-var-ok" : "cm-var-missing" }),
  });
  const plugin = ViewPlugin.fromClass(
    class {
      decorations;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );

  // The hover card closes when the mouse leaves it, so editing happens in a pinned
  // card that stays open until it is saved, cancelled or clicked away from.
  const pin = StateEffect.define<{ name: string; from: number; to: number } | null>();
  const peekTooltip = (name: string, from: number, to: number, pinned: boolean): Tooltip => ({
    pos: from,
    end: to,
    above: false,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "cm-var-tip";
      const root = createRoot(dom);
      const close = (refocus = true) => {
        view.dispatch({ effects: pin.of(null) });
        if (refocus) view.focus();
      };
      const edit = () => view.dispatch({ effects: [closeHoverTooltips, pin.of({ name, from, to })] });
      flushSync(() => root.render(<VariablePeek name={name} source={source} pinned={pinned} onEdit={edit} onClose={close} />));
      return { dom, destroy: () => queueMicrotask(() => root.unmount()) };
    },
  });
  const pinned = StateField.define<PinnedPeek | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(pin)) value = e.value ? { name: e.value.name, tooltip: peekTooltip(e.value.name, e.value.from, e.value.to, true) } : null;
      return tr.docChanged ? null : value;
    },
    provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
  });

  const hover = hoverTooltip((view, pos) => {
    if (view.state.field(pinned)) return null;
    const line = view.state.doc.lineAt(pos);
    PLACEHOLDER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER.exec(line.text))) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (pos < from || pos > to) continue;
      return peekTooltip(m[1], from, to, false);
    }
    return null;
  });

  const complete = (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\{\{\s*\$?[\w.\-]*$/);
    if (!before) return null;
    const open = before.text.indexOf("{{") + 2;
    const typed = before.text.slice(open).trimStart();
    const from = before.from + before.text.length - typed.length;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const close = after === "}}" ? "" : "}}";
    const options = typed.startsWith("$")
      ? DYNAMIC_VARIABLES.map((d) => ({
          label: d.name.startsWith("$") ? d.name : `$${d.name}`,
          detail: d.example,
          info: d.description,
          type: "constant",
          apply: `${d.name.startsWith("$") ? d.name : `$${d.name}`}${close}`,
        }))
      : source.names().map((v) => ({ label: v.name, detail: v.scope, info: v.value, type: "variable", apply: `${v.name}${close}` }));
    return { from, options, validFor: /^\$?[\w.\-]*$/ };
  };

  return { ext: [plugin, pinned, hover], complete };
}

const singleLineExtensions: Extension = [
  EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
  EditorView.domEventHandlers({
    paste: (e, view) => {
      const text = e.clipboardData?.getData("text/plain");
      if (!text || !/[\r\n]/.test(text)) return false;
      e.preventDefault();
      // Shell line continuations (cURL commands) become spaces; other line breaks vanish.
      view.dispatch(view.state.replaceSelection(text.replace(/\\\r?\n\s*/g, " ").replace(/\s*[\r\n]+\s*/g, "")));
      return true;
    },
  }),
];

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { value, onChange, language = "text", readOnly, singleLine, placeholder, variables, onSubmit, className, fill, minHeight, lineNumbers = true, ariaLabel },
  ref,
) {
  const cm = useRef<ReactCodeMirrorRef>(null);
  useImperativeHandle(ref, () => ({ focus: () => cm.current?.view?.focus(), view: () => cm.current?.view }));

  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  const extensions = useMemo(() => {
    const ext: Extension[] = [editorTheme, syntaxHighlighting(highlight), languageExtension(language)];
    const sources: ((ctx: CompletionContext) => CompletionResult | null)[] = [];
    if (variables) {
      const v = variableExtensions(variables);
      ext.push(v.ext);
      sources.push(v.complete);
    }
    if (language === "javascript") sources.push(pmComplete);
    if (sources.length && !readOnly) ext.push(autocompletion({ override: sources, icons: false }));
    if (singleLine) ext.push(singleLineExtensions);
    else ext.push(EditorView.lineWrapping);
    ext.push(
      Prec.highest(
        keymap.of([
          { key: "Mod-Enter", run: () => (submitRef.current ? (submitRef.current(), true) : false) },
          ...(singleLine ? [{ key: "Enter", run: () => (submitRef.current?.(), true) }] : []),
        ]),
      ),
    );
    if (ariaLabel) ext.push(EditorView.contentAttributes.of({ "aria-label": ariaLabel }));
    return ext;
    // variables.version captures every lookup change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, singleLine, readOnly, variables?.version, ariaLabel]);

  return (
    <CodeMirror
      ref={cm}
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      placeholder={placeholder}
      extensions={extensions}
      theme="none"
      height={fill ? "100%" : undefined}
      minHeight={minHeight ? `${minHeight}px` : undefined}
      className={clsx(singleLine && "cm-singleline", fill && "h-full", className)}
      basicSetup={
        singleLine
          ? { lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, autocompletion: false, searchKeymap: false }
          : { lineNumbers, foldGutter: !readOnly || language === "json" || language === "xml", highlightActiveLine: !readOnly, autocompletion: false, tabSize: 2 }
      }
      indentWithTab={!singleLine}
    />
  );
});

function pmComplete(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/(pm|console|JSON)(\.[\w]*)*\.?[\w]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const options = PM_COMPLETIONS.filter((c) => c.label.startsWith(word.text.split(".").slice(0, -1).join(".") + ".") || c.label.startsWith(word.text));
  return { from: word.from, options, validFor: /^[\w.]*$/ };
}
