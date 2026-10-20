import { newId, type YamletRequest, type YamletResponse } from "@core/models";
import { isEventStream, parseEventStream } from "@core/sse";
import clsx from "clsx";
import { BookmarkPlus, CircleAlert, CircleCheck, CircleX, Copy, CornerDownRight, Download, Filter, History, Loader2, MoreHorizontal, Send, WrapText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "../../components/Button";
import { useDialogs } from "../../components/Dialogs";
import { StatusPill } from "../../components/Labels";
import { useMenu } from "../../components/Menu";
import { CountBadge, UnderlineTabs } from "../../components/Tabs";
import { useToast } from "../../components/Toast";
import { CodeEditor } from "../../editor/CodeEditor";
import { copyText, downloadBlob, formatBytes, formatMs, languageFor, prettyJson, prettyXml, suggestedFileName } from "../../lib/format";
import { queryJson, JsonPathError } from "../../lib/jsonPath";
import { keys, readJson, writeJson } from "../../lib/storage";
import { useStore } from "../../lib/store";
import { NetworkBadge, SizeBreakdown, TimeBreakdown } from "./ResponseMeta";
import { EventsView, LiveText } from "./StreamViews";

type View = "body" | "headers" | "cookies" | "tests" | "console";
type BodyMode = "pretty" | "raw" | "preview" | "events";

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
        <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-11">Ctrl</kbd> +{" "}
        <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-11">Enter</kbd>
      </p>
    </div>
  );
}

function isImage(ct: string) {
  return /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|x-icon|avif)/i.test(ct);
}

function isPdf(ct: string) {
  return /^application\/pdf\b/i.test(ct);
}

/** The browser's own PDF viewer, fed from a blob URL that is released on unmount. */
function PdfPreview({ r }: { r: YamletResponse }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const bytes = r.bodyEncoding === "base64" ? Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(r.body);
    const next = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [r]);
  return url ? <iframe title="PDF preview" src={url} className="h-full w-full" /> : null;
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
  const [mode, setModeState] = useState<BodyMode>("pretty");
  const [pickedMode, setPickedMode] = useState(false);
  const setMode = (m: BodyMode) => {
    setModeState(m);
    setPickedMode(true);
  };
  const r = state?.response;

  const ct = r?.contentType ?? "";
  const lang = languageFor(ct);
  const text = useMemo(() => (r ? bodyText(r) : ""), [r]);
  const pretty = useMemo(() => (lang === "json" ? prettyJson(text) : lang === "xml" ? prettyXml(text) : text), [text, lang]);
  const canPreview = !!r && (lang === "html" || isImage(ct) || isPdf(ct));
  const isStream = isEventStream(ct);
  // Events with arrival times when they were received live; otherwise parsed from the body.
  const events = useMemo(() => (isStream ? (state?.events ?? parseEventStream(text)) : undefined), [isStream, state?.events, text]);
  const live = state?.loading ? state.live : undefined;
  const liveStream = !!live && isEventStream(live.contentType);

  // Event streams open on the event list; other bodies can't show it.
  const bodyMode: BodyMode = mode === "preview" && !canPreview ? "pretty" : mode === "events" && !isStream ? "pretty" : isStream && mode === "pretty" && !pickedMode ? "events" : mode;

  const [filterOpen, setFilterOpen] = useState(false);
  const [jsonPath, setJsonPath] = useState("");
  const [wrap, setWrapState] = useState(() => readJson<boolean>(keys.responseWrap, true));
  const setWrap = (v: boolean) => {
    setWrapState(v);
    writeJson(keys.responseWrap, v);
  };
  const showFilter = filterOpen && lang === "json" && bodyMode === "pretty";
  // The filter shows its matches as JSON: one match on its own, several as a list.
  const filtered = useMemo((): { text?: string; error?: string; count?: number } => {
    if (!showFilter || !jsonPath.trim()) return {};
    try {
      const matches = queryJson(JSON.parse(text), jsonPath);
      return { text: JSON.stringify(matches.length === 1 ? matches[0] : matches, null, 2) ?? "", count: matches.length };
    } catch (e) {
      return { error: e instanceof JsonPathError ? e.message : "The body isn't valid JSON." };
    }
  }, [showFilter, jsonPath, text]);

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
        { id: newId(), name, status: r.statusCode, headers: r.headers, body: text, contentType: r.contentType, savedAt: new Date().toISOString(),
          // What was sent, as written ({{variables}} unresolved), so no resolved secret lands in the file.
          ...(state?.sent ? { request: state.sent } : {}) },
      ],
    }));
    toast.success("Example saved", "Find it under the request's Examples tab.");
  };

  const copyBody = async () => (await copyText(text)) && toast.success("Copied response body");
  const saveBody = () => {
    if (!r) return;
    const bytes = r.bodyEncoding === "base64" ? Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)) : r.body;
    downloadBlob(bytes, suggestedFileName(r.headers, r.resolvedUrl) ?? `response.${extensionFor(ct)}`, ct || "application/octet-stream");
  };

  if (!state || (!state.loading && !r && !state.error)) {
    return (
      <div className="relative h-full bg-surface">
        <Empty />
      </div>
    );
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line-soft px-5">
        <span className="hidden text-12 font-medium tracking-wide text-muted uppercase @md:inline">Response</span>
        {live ? (
          <span className="flex min-w-0 items-center gap-3 overflow-hidden text-12 whitespace-nowrap text-grey">
            <StatusPill status={live.statusCode} text={live.reasonPhrase} />
            <span className="flex items-center gap-1.5">
              <Loader2 size={13} className="spin text-primary" aria-hidden />
              {liveStream ? "Streaming" : "Receiving"} <Elapsed since={state.startedAt} />
            </span>
            <span>
              <span className="text-muted">Size</span> <b className="font-medium text-primary">{formatBytes(live.bytes)}</b>
            </span>
            {liveStream && (
              <span>
                <span className="text-muted">Events</span> <b className="font-medium text-primary">{state.events?.length ?? 0}</b>
              </span>
            )}
          </span>
        ) : state.loading ? (
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
            <TimeBreakdown r={r} />
            <SizeBreakdown r={r} />
            <NetworkBadge r={r} />
            {state.restoredAt && (
              <span className="flex items-center gap-1 text-muted" title={`Received ${new Date(state.restoredAt).toLocaleString()}, before the page was reloaded. Send again for a fresh response.`}>
                <History size={13} aria-hidden />
                Last session
              </span>
            )}
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
        <div role="alert" className="m-5 flex items-start gap-2 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-13 text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {state.error}
        </div>
      )}
      {r?.isError && !state.loading && (
        <div className="m-5 rounded-lg border border-danger-line bg-danger-soft px-4 py-3">
          <p className="flex items-center gap-2 text-13 font-medium text-danger">
            <CircleAlert size={16} aria-hidden /> Could not get a response
          </p>
          <p className="mt-1 font-mono text-12 break-words text-danger-ink">{r.errorMessage}</p>
          {r.resolvedUrl && <p className="mt-2 font-mono text-11 break-all text-grey">{r.method} {r.resolvedUrl}</p>}
          {/localhost|127\.0\.0\.1/.test(r.resolvedUrl) && useStore.getState().info?.inContainer && (
            <p className="mt-2 text-12 text-grey">
              Yamlet runs in a container, where <span className="font-mono">localhost</span> means the container itself. To reach a server on your machine, use{" "}
              <span className="font-mono">host.docker.internal</span> or start Yamlet with <span className="font-mono">--network host -e HOST=127.0.0.1</span>.
            </p>
          )}
        </div>
      )}

      {live && (
        <div className="min-h-0 flex-1 overflow-hidden">
          {liveStream ? (
            <EventsView events={state.events ?? []} live />
          ) : live.text !== undefined ? (
            <LiveText text={live.text} />
          ) : (
            <p className="p-5 text-13 text-muted">Receiving a binary body ({formatBytes(live.bytes)} so far).</p>
          )}
        </div>
      )}

      {r && !r.isError && !state.loading && r.incomplete && (
        <p role="status" className="mx-5 mt-3 flex items-start gap-2 rounded-lg bg-s-client px-3 py-2 text-12 text-s-client-ink">
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden /> {r.incomplete}
        </p>
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
                  <span className="flex items-center gap-1">
                    {lang === "json" && bodyMode === "pretty" && (
                      <IconButton icon={Filter} size={14} label="Filter with JSONPath" active={filterOpen} onClick={() => setFilterOpen((v) => !v)} />
                    )}
                    {(bodyMode === "pretty" || bodyMode === "raw") && (
                      <IconButton icon={WrapText} size={14} label={wrap ? "Don't wrap lines" : "Wrap lines"} active={wrap} onClick={() => setWrap(!wrap)} />
                    )}
                    <select className="input h-7 w-28 text-12" aria-label="Body view" value={bodyMode} onChange={(e) => setMode(e.target.value as BodyMode)}>
                      {isStream && <option value="events">Events</option>}
                      <option value="pretty">Pretty</option>
                      <option value="raw">Raw</option>
                      {canPreview && <option value="preview">Preview</option>}
                    </select>
                  </span>
                ) : undefined
              }
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {view === "body" &&
              (bodyMode === "events" && events ? (
                <EventsView events={events} />
              ) : (
                <div className="flex h-full flex-col">
                  {showFilter && (
                    <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-5 py-1.5">
                      <Filter size={13} className="shrink-0 text-muted" aria-hidden />
                      <input
                        className="input h-7 flex-1 font-mono text-12"
                        placeholder="$.data[*].id  or  $..items[?(@.price < 10)]"
                        aria-label="JSONPath filter"
                        value={jsonPath}
                        autoFocus
                        onChange={(e) => setJsonPath(e.target.value)}
                      />
                      {filtered.error && <span className="max-w-[40%] truncate text-12 text-danger" title={filtered.error}>{filtered.error}</span>}
                      {filtered.count !== undefined && <span className="shrink-0 text-12 text-muted">{filtered.count} {filtered.count === 1 ? "match" : "matches"}</span>}
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <BodyView r={r} mode={bodyMode === "events" ? "pretty" : bodyMode} pretty={filtered.text ?? pretty} raw={text} lang={lang} wrap={wrap} />
                  </div>
                </div>
              ))}
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

function BodyView({ r, mode, pretty, raw, lang, wrap }: { r: YamletResponse; mode: BodyMode; pretty: string; raw: string; lang: ReturnType<typeof languageFor>; wrap: boolean }) {
  if (mode === "preview") {
    if (isPdf(r.contentType)) return <PdfPreview r={r} />;
    if (isImage(r.contentType)) {
      const src = r.bodyEncoding === "base64" ? `data:${r.contentType.split(";")[0]};base64,${r.body}` : `data:${r.contentType.split(";")[0]};utf8,${encodeURIComponent(r.body)}`;
      return (
        <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--color-line-soft)_0_25%,var(--color-surface)_0_50%)] bg-[length:16px_16px] p-6">
          <img src={src} alt="Response preview" className="max-h-full max-w-full" />
        </div>
      );
    }
    // No scripts, forms or same-origin access: the page can't reach Yamlet's API.
    return <iframe title="HTML preview" sandbox="" srcDoc={raw} className="h-full w-full bg-white" />;
  }
  if (r.bodyEncoding === "base64" && isPdf(r.contentType)) {
    return <p className="p-5 text-13 text-muted">PDF response ({formatBytes(r.sizeBytes)}). Switch the view to Preview to read it, or download it.</p>;
  }
  if (r.bodyEncoding === "base64" && !isImage(r.contentType)) {
    return <p className="p-5 text-13 text-muted">Binary response ({formatBytes(r.sizeBytes)}). Use the download button to save it.</p>;
  }
  if (r.bodyEncoding === "base64") {
    return <p className="p-5 text-13 text-muted">Image response. Switch the view to Preview to see it.</p>;
  }
  if (!raw) return <p className="p-5 text-13 text-muted italic">The response body is empty.</p>;
  return <CodeEditor fill readOnly wrap={wrap} value={mode === "pretty" ? pretty : raw} language={mode === "pretty" ? lang : "text"} ariaLabel="Response body" />;
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
