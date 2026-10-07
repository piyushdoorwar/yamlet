import { newId, type YamletRequest, type YamletResponse } from "@core/models";
import clsx from "clsx";
import { BookmarkPlus, CircleAlert, CircleCheck, CircleX, Copy, CornerDownRight, Download, Loader2, MoreHorizontal, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "../../components/Button";
import { useDialogs } from "../../components/Dialogs";
import { StatusPill } from "../../components/Labels";
import { useMenu } from "../../components/Menu";
import { CountBadge, UnderlineTabs } from "../../components/Tabs";
import { useToast } from "../../components/Toast";
import { CodeEditor } from "../../editor/CodeEditor";
import { copyText, downloadBlob, formatBytes, formatMs, languageFor, prettyJson, prettyXml } from "../../lib/format";
import { useStore } from "../../lib/store";

type View = "body" | "headers" | "cookies" | "tests" | "console";
type BodyMode = "pretty" | "raw" | "preview";

function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <>{formatMs(Math.max(0, now - (since ?? now)))}</>;
}

function Empty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Send size={20} aria-hidden />
      </span>
      <p className="text-13 text-grey">Send the request to see the response here.</p>
      <p className="text-12 text-muted">
        <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-11">Ctrl</kbd> +{" "}
        <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-11">Enter</kbd>
      </p>
    </div>
  );
}

function isImage(ct: string) {
  return /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|x-icon|avif)/i.test(ct);
}

function bodyText(r: YamletResponse): string {
  if (r.bodyEncoding !== "base64") return r.body;
  try {
    return atob(r.body);
  } catch {
    return r.body;
  }
}

function extensionFor(ct: string): string {
  const lang = languageFor(ct);
  if (lang === "json") return "json";
  if (lang === "html") return "html";
  if (lang === "xml") return "xml";
  const sub = ct.split(";")[0].split("/")[1];
  return sub && /^[a-z0-9.+-]+$/i.test(sub) ? sub.replace("+xml", "").replace("svg", "svg") : "txt";
}

export function ResponsePanel({ request, update }: { request: YamletRequest; update: (fn: (r: YamletRequest) => YamletRequest) => void }) {
  const state = useStore((s) => s.responses[request.id]);
  const toast = useToast();
  const { prompt } = useDialogs();
  const actionsMenu = useMenu();
  const [view, setView] = useState<View>("body");
  const [mode, setMode] = useState<BodyMode>("pretty");
  const r = state?.response;

  const ct = r?.contentType ?? "";
  const lang = languageFor(ct);
  const text = useMemo(() => (r ? bodyText(r) : ""), [r]);
  const pretty = useMemo(() => (lang === "json" ? prettyJson(text) : lang === "xml" ? prettyXml(text) : text), [text, lang]);
  const canPreview = !!r && (lang === "html" || isImage(ct));

  const passed = r?.testResults.filter((t) => t.passed).length ?? 0;
  const total = r?.testResults.length ?? 0;

  const saveExample = async () => {
    if (!r) return;
    const name = await prompt({ title: "Save as example", label: "Name", initial: `${r.statusCode} ${r.reasonPhrase}`.trim(), action: "Save" });
    if (!name) return;
    update((req) => ({
      ...req,
      examples: [
        ...req.examples,
        { id: newId(), name, status: r.statusCode, headers: r.headers, body: text, contentType: r.contentType, savedAt: new Date().toISOString() },
      ],
    }));
    toast.success("Example saved", "Find it under the request's Examples tab.");
  };

  const copyBody = async () => (await copyText(text)) && toast.success("Copied response body");
  const saveBody = () => {
    if (!r) return;
    const bytes = r.bodyEncoding === "base64" ? Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)) : r.body;
    downloadBlob(bytes, `response.${extensionFor(ct)}`, ct || "application/octet-stream");
  };

  if (!state || (!state.loading && !r && !state.error)) {
    return (
      <div className="relative h-full bg-white">
        <Empty />
      </div>
    );
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line-soft px-5">
        <span className="hidden text-12 font-medium tracking-wide text-muted uppercase @md:inline">Response</span>
        {state.loading ? (
          <span className="flex items-center gap-2 text-13 text-grey">
            <Loader2 size={14} className="spin text-primary" aria-hidden /> Sending… <Elapsed since={state.startedAt} />
          </span>
        ) : r && !r.isError ? (
          <span className="flex min-w-0 items-center gap-3 overflow-hidden text-12 whitespace-nowrap text-grey">
            <StatusPill status={r.statusCode} text={r.reasonPhrase} />
            {r.redirects?.length ? (
              <span
                className="flex items-center gap-1"
                title={`Followed ${r.redirects.map((h) => `${h.statusCode} from ${h.url}`).join(", ")}. Turn off "Follow redirects" in the request's Settings to see the redirect itself.`}
              >
                <CornerDownRight size={13} className="text-muted" aria-hidden />
                <span className="text-muted">Redirected</span>{" "}
                <b className="font-medium text-primary">{r.redirects.map((h) => h.statusCode).join(" > ")}</b>
              </span>
            ) : null}
            <span title={r.timings.firstByte !== undefined ? `Waiting ${formatMs(r.timings.firstByte)} · Download ${formatMs(r.timings.download ?? 0)}` : undefined}>
              <span className="text-muted">Time</span> <b className="font-medium text-primary">{formatMs(r.durationMs)}</b>
            </span>
            <span>
              <span className="text-muted">Size</span> <b className="font-medium text-primary">{formatBytes(r.sizeBytes)}</b>
            </span>
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {r && !r.isError && (
            <span className="@md:hidden">
              <IconButton
                icon={MoreHorizontal}
                label="Response actions"
                onClick={(e) =>
                  actionsMenu.openBelow(e.currentTarget as HTMLElement, [
                    { label: "Copy body", icon: Copy, onSelect: () => void copyBody() },
                    { label: "Save body to a file", icon: Download, onSelect: saveBody },
                    { label: "Save as example", icon: BookmarkPlus, onSelect: () => void saveExample() },
                  ], "end")
                }
              />
            </span>
          )}
          {r && !r.isError && (
            <span className="hidden items-center gap-1 @md:flex">
              <IconButton icon={Copy} label="Copy body" onClick={() => void copyBody()} />
              <IconButton icon={Download} label="Save body to a file" onClick={saveBody} />
              <IconButton icon={BookmarkPlus} label="Save as example" onClick={() => void saveExample()} />
            </span>
          )}
        </span>
        {actionsMenu.node}
      </div>

      {state.error && !state.loading && (
        <div role="alert" className="m-5 flex items-start gap-2 rounded-lg border border-[#ffc9d6] bg-danger-soft px-4 py-3 text-13 text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {state.error}
        </div>
      )}
      {r?.isError && !state.loading && (
        <div className="m-5 rounded-lg border border-[#ffc9d6] bg-danger-soft px-4 py-3">
          <p className="flex items-center gap-2 text-13 font-medium text-danger">
            <CircleAlert size={16} aria-hidden /> Could not get a response
          </p>
          <p className="mt-1 font-mono text-12 break-words text-[#8f0620]">{r.errorMessage}</p>
          {r.resolvedUrl && <p className="mt-2 font-mono text-11 break-all text-grey">{r.method} {r.resolvedUrl}</p>}
          {/localhost|127\.0\.0\.1/.test(r.resolvedUrl) && useStore.getState().info?.inContainer && (
            <p className="mt-2 text-12 text-grey">
              Yamlet runs in a container, where <span className="font-mono">localhost</span> means the container itself. To reach a server on your machine, use{" "}
              <span className="font-mono">host.docker.internal</span> or start Yamlet with <span className="font-mono">--network host -e HOST=127.0.0.1</span>.
            </p>
          )}
        </div>
      )}

      {r && !r.isError && !state.loading && (
        <>
          <div className="px-5">
            <UnderlineTabs
              tabs={[
                { id: "body", label: "Body" },
                { id: "headers", label: "Headers", badge: <CountBadge n={r.headers.length} />, hint: String(r.headers.length) },
                { id: "cookies", label: "Cookies", badge: <CountBadge n={r.cookies.length} />, hint: r.cookies.length ? String(r.cookies.length) : undefined },
                {
                  id: "tests",
                  label: "Tests",
                  hint: total ? `${passed}/${total}` : undefined,
                  badge: total ? (
                    <span className={clsx("rounded-full px-1.5 text-11 leading-4 font-medium", passed === total ? "bg-primary-soft text-primary" : "bg-danger-soft text-danger")}>
                      {passed}/{total}
                    </span>
                  ) : null,
                },
                { id: "console", label: "Console" },
              ]}
              active={view}
              onChange={setView}
              right={
                view === "body" && !r.isError ? (
                  <select className="input h-7 w-28 text-12" aria-label="Body view" value={mode} onChange={(e) => setMode(e.target.value as BodyMode)}>
                    <option value="pretty">Pretty</option>
                    <option value="raw">Raw</option>
                    {canPreview && <option value="preview">Preview</option>}
                  </select>
                ) : undefined
              }
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {view === "body" && (
              <BodyView r={r} mode={mode === "preview" && !canPreview ? "pretty" : mode} pretty={pretty} raw={text} lang={lang} />
            )}
            {view === "headers" && <HeaderTable rows={r.headers.map((h) => [h.key, h.value])} empty="No headers." />}
            {view === "cookies" && (
              <HeaderTable
                head={["Name", "Value", "Domain", "Path", "Expires", "Flags"]}
                rows={r.cookies.map((c) => [c.name, c.value, c.domain ?? "", c.path ?? "", c.expires ?? "Session", [c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite].filter(Boolean).join(", ")])}
                empty="No cookies were set by this response."
              />
            )}
            {view === "tests" && <TestsView r={r} />}
            {view === "console" && (
              <div className="h-full">
                <CodeEditor fill readOnly lineNumbers={false} value={[...r.scriptLogs.map((l) => `> ${l}`), r.scriptLogs.length ? "" : null, r.consoleText].filter((x) => x !== null).join("\n")} ariaLabel="Console" />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function BodyView({ r, mode, pretty, raw, lang }: { r: YamletResponse; mode: BodyMode; pretty: string; raw: string; lang: ReturnType<typeof languageFor> }) {
  if (mode === "preview") {
    if (isImage(r.contentType)) {
      const src = r.bodyEncoding === "base64" ? `data:${r.contentType.split(";")[0]};base64,${r.body}` : `data:${r.contentType.split(";")[0]};utf8,${encodeURIComponent(r.body)}`;
      return (
        <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(#f1f4f2_0_25%,#fff_0_50%)] bg-[length:16px_16px] p-6">
          <img src={src} alt="Response preview" className="max-h-full max-w-full" />
        </div>
      );
    }
    // No scripts, forms or same-origin access: the page can't reach Yamlet's API.
    return <iframe title="HTML preview" sandbox="" srcDoc={raw} className="h-full w-full bg-white" />;
  }
  if (r.bodyEncoding === "base64" && !isImage(r.contentType)) {
    return <p className="p-5 text-13 text-muted">Binary response ({formatBytes(r.sizeBytes)}). Use the download button to save it.</p>;
  }
  if (r.bodyEncoding === "base64") {
    return <p className="p-5 text-13 text-muted">Image response. Switch the view to Preview to see it.</p>;
  }
  if (!raw) return <p className="p-5 text-13 text-muted italic">The response body is empty.</p>;
  return <CodeEditor fill readOnly value={mode === "pretty" ? pretty : raw} language={mode === "pretty" ? lang : "text"} ariaLabel="Response body" />;
}

function HeaderTable({ rows, head = ["Key", "Value"], empty }: { rows: string[][]; head?: string[]; empty: string }) {
  if (!rows.length) return <p className="p-5 text-13 text-muted italic">{empty}</p>;
  return (
    <div className="h-full overflow-auto px-5 py-4">
      <table className="kv-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={clsx("px-2.5 py-1.5 text-12 break-all", j === 0 ? "font-medium text-ink" : "font-mono text-body")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TestsView({ r }: { r: YamletResponse }) {
  if (!r.testResults.length) {
    return (
      <p className="p-5 text-13 text-muted">
        No tests ran. Add <span className="font-mono">pm.test(...)</span> calls to the post-response script.
      </p>
    );
  }
  return (
    <ul className="h-full overflow-y-auto px-5 py-3">
      {r.testResults.map((t, i) => (
        <li key={i} className="flex items-start gap-2.5 border-b border-line-soft py-2.5 last:border-0">
          {t.passed ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-primary" aria-label="Passed" /> : <CircleX size={16} className="mt-0.5 shrink-0 text-danger" aria-label="Failed" />}
          <span className="min-w-0">
            <span className="block text-13 text-ink">{t.name}</span>
            {t.error && <span className="mt-0.5 block font-mono text-12 break-words text-danger">{t.error}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
