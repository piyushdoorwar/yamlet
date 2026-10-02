import { HTTP_METHODS, type YamletRequest } from "@core/models";
import { parseCurl } from "@core/curl";
import clsx from "clsx";
import { ChevronDown, Code2, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../../components/Dialogs";
import { methodClass } from "../../components/Labels";
import { Menu } from "../../components/Menu";
import { useToast } from "../../components/Toast";
import { CodeEditor, type VariableSource } from "../../editor/CodeEditor";
import { useStore } from "../../lib/store";
import { useUi } from "../../lib/ui";
import { displayUrl, fromDisplayUrl, pathVariablesFromUrl } from "../../lib/urlSync";

interface Props {
  request: YamletRequest;
  update: (fn: (r: YamletRequest) => YamletRequest) => void;
  variables: VariableSource;
}

export function UrlBar({ request, update, variables }: Props) {
  const loading = useStore((s) => s.responses[request.id]?.loading ?? false);
  const send = useStore((s) => s.send);
  const cancel = useStore((s) => s.cancel);
  const setModal = useUi((s) => s.setModal);
  const toast = useToast();
  const { prompt } = useDialogs();
  const [methodsOpen, setMethodsOpen] = useState(false);
  const methodBtn = useRef<HTMLButtonElement>(null);

  // The box keeps exactly what was typed ("?a=" would otherwise render as "?a"),
  // and only re-syncs when the URL or params change from elsewhere.
  const shown = displayUrl(request.url, request.queryParams);
  const [text, setText] = useState(shown);
  useEffect(() => {
    setText((current) => {
      const parsed = fromDisplayUrl(current, request.queryParams);
      return displayUrl(parsed.url, parsed.queryParams) === shown ? current : shown;
    });
  }, [shown, request.queryParams]);

  const customMethod = async () => {
    const isStandard = (HTTP_METHODS as readonly string[]).includes(request.method);
    const value = await prompt({ title: "Custom method", label: "HTTP method", initial: isStandard ? "" : request.method, placeholder: "PROPFIND", action: "Use" });
    if (!value) return;
    const method = value.trim().toUpperCase();
    // RFC 9110 method token characters.
    if (!/^[A-Z0-9!#$%&'*+.^_`|~-]+$/.test(method)) {
      toast.error("Not a valid HTTP method", "Use letters, digits and symbols like - or _, with no spaces.");
      return;
    }
    update((r) => ({ ...r, method }));
  };

  const setUrl = (value: string) => {
    if (value === text) return;
    setText(value);
    // A pasted cURL command becomes the whole request.
    if (/^\s*curl\s/i.test(value)) {
      try {
        const parsed = parseCurl(value);
        setText(displayUrl(parsed.url, parsed.queryParams));
        update((r) => ({
          ...r,
          method: parsed.method,
          url: parsed.url,
          headers: parsed.headers,
          queryParams: parsed.queryParams,
          pathVariables: pathVariablesFromUrl(parsed.url, r.pathVariables),
          body: parsed.body,
          auth: parsed.auth.type === "inherit" || parsed.auth.type === "none" ? r.auth : parsed.auth,
          settings: { ...r.settings, ...parsed.settings },
        }));
        toast.success("Imported cURL command");
        return;
      } catch {
        // Not a parseable command: keep it as typed.
      }
    }
    update((r) => {
      const next = fromDisplayUrl(value, r.queryParams);
      return { ...r, ...next, pathVariables: pathVariablesFromUrl(next.url, r.pathVariables) };
    });
  };

  return (
    <div className="flex items-stretch gap-2 px-5 pt-3 pb-3">
      <div className="flex min-w-0 flex-1 items-stretch rounded-lg border border-line bg-white focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--color-primary-soft)]">
        <button
          ref={methodBtn}
          type="button"
          aria-label="HTTP method"
          aria-haspopup="menu"
          onClick={() => setMethodsOpen(true)}
          className={clsx("flex max-w-44 min-w-28 shrink-0 items-center justify-between gap-1 rounded-l-lg border-r border-line-soft px-3 font-mono text-12 font-bold hover:bg-[#fafbfa]", methodClass(request.method))}
        >
          <span className="truncate">{request.method}</span>
          <ChevronDown size={13} className="shrink-0 text-muted" aria-hidden />
        </button>
        {methodsOpen && methodBtn.current && (
          <Menu
            at={methodBtn.current}
            onClose={() => setMethodsOpen(false)}
            items={[
              ...HTTP_METHODS.map((m) => ({ label: m, onSelect: () => update((r) => ({ ...r, method: m })) })),
              "separator" as const,
              { label: "Custom method…", onSelect: () => void customMethod() },
            ]}
          />
        )}
        <div className="min-w-0 flex-1 px-3">
          <CodeEditor
            singleLine
            value={text}
            onChange={setUrl}
            variables={variables}
            placeholder="Enter a URL, or paste a cURL command"
            ariaLabel="Request URL"
            onSubmit={() => void send(request.id)}
          />
        </div>
      </div>
      {loading ? (
        <button type="button" className="btn btn-cancel w-28" onClick={() => cancel(request.id)}>
          <X size={14} aria-hidden /> Cancel
        </button>
      ) : (
        <button type="button" className="btn btn-primary w-28" onClick={() => void send(request.id)} title="Send (Ctrl+Enter)">
          <Send size={14} aria-hidden /> Send
        </button>
      )}
      <button type="button" className="btn btn-cancel px-3" title="Code snippet" aria-label="Code snippet" onClick={() => setModal({ kind: "snippet", requestId: request.id })}>
        <Code2 size={15} aria-hidden />
      </button>
    </div>
  );
}
