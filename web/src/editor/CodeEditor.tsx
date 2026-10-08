import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension, Prec } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, keymap, MatchDecorator, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import clsx from "clsx";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { DYNAMIC_VARIABLES } from "@core/dynamicVariables";
import { PM_COMPLETIONS } from "./pmCompletions";

export type EditorLanguage = "json" | "javascript" | "xml" | "html" | "yaml" | "text" | "graphql";

export interface VariableInfo {
  value: string;
  scope: string;
}

/** What the editor needs to color, peek and edit `{{variables}}`. */
export interface VariableSource {
  lookup: (name: string) => VariableInfo | undefined;
  names: () => { name: string; scope: string; value: string }[];
  /** Write a value to the active environment; undefined when there is none. */
  edit?: (name: string, value: string) => void;
  /** Bumps whenever lookups would change, so decorations refresh. */
  version: string;
}

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
const DYNAMIC_BY_NAME = new Map(DYNAMIC_VARIABLES.map((d) => [d.name.replace(/^\$/, ""), d]));

function dynamicInfo(name: string) {
  return name.startsWith("$") ? DYNAMIC_BY_NAME.get(name.slice(1)) : undefined;
}

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
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
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

function variableExtensions(source: VariableSource): { ext: Extension; complete: (ctx: CompletionContext) => CompletionResult | null } {
  const decorator = new MatchDecorator({
    regexp: PLACEHOLDER,
    decoration: (m) => {
      const name = m[1];
      const known = !!source.lookup(name) || !!dynamicInfo(name);
      return Decoration.mark({ class: known ? "cm-var-ok" : "cm-var-missing" });
    },
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

  const tooltip = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    PLACEHOLDER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER.exec(line.text))) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (pos < from || pos > to) continue;
      const name = m[1];
      return {
        pos: from,
        end: to,
        above: true,
        create: () => ({ dom: renderPeek(name, source) }),
      };
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

  return { ext: [plugin, tooltip], complete };
}

function renderPeek(name: string, source: VariableSource): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-var-tip";
  dom.style.cssText = "padding:10px 12px;min-width:220px;max-width:360px;font-size:12px";
  const title = document.createElement("div");
  title.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px";
  const nameEl = document.createElement("span");
  nameEl.style.cssText = "font-family:var(--font-mono);font-weight:600;color:var(--color-ink)";
  nameEl.textContent = name;
  const scopeEl = document.createElement("span");
  scopeEl.style.cssText = "font-size:11px;color:var(--color-muted);text-transform:uppercase;letter-spacing:.04em";
  title.append(nameEl, scopeEl);
  dom.append(title);

  const dyn = dynamicInfo(name);
  if (dyn) {
    scopeEl.textContent = "dynamic";
    const desc = document.createElement("div");
    desc.style.color = "var(--color-grey)";
    desc.textContent = dyn.description;
    const ex = document.createElement("div");
    ex.style.cssText = "margin-top:6px;font-family:var(--font-mono);color:var(--syn-string);word-break:break-all";
    ex.textContent = `e.g. ${dyn.example}`;
    dom.append(desc, ex);
    return dom;
  }

  const info = source.lookup(name);
  scopeEl.textContent = info ? info.scope : "undefined";
  if (!source.edit) {
    const val = document.createElement("div");
    val.style.cssText = "font-family:var(--font-mono);word-break:break-all;color:" + (info ? "var(--color-body)" : "var(--color-danger)");
    val.textContent = info ? info.value || "(empty)" : "Not defined in any active scope";
    dom.append(val);
    return dom;
  }
  const form = document.createElement("form");
  form.style.cssText = "display:flex;gap:6px";
  const input = document.createElement("input");
  input.className = "input";
  input.style.cssText = "height:28px;font-family:var(--font-mono);font-size:12px";
  input.value = info?.value ?? "";
  input.placeholder = "Value";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn btn-primary btn-sm";
  save.textContent = "Set";
  form.append(input, save);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    source.edit?.(name, input.value);
    save.textContent = "Saved";
  });
  const hint = document.createElement("div");
  hint.style.cssText = "margin-top:6px;font-size:11px;color:var(--color-muted)";
  hint.textContent = info && info.scope !== "environment" ? `Defined in ${info.scope}. Setting writes to the active environment.` : "Writes to the active environment.";
  dom.append(form, hint);
  return dom;
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
