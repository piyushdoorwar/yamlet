import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CookieInfo } from "../../../shared/api";
import { Button, IconButton } from "../components/Button";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { onPairWindow, refreshInterceptorStatus, sendPairCode, useInterceptorExtension, useInterceptorPaired } from "../lib/interceptor";

export function CookiesModal({ onClose }: { onClose: () => void }) {
  const [cookies, setCookies] = useState<CookieInfo[] | null>(null);
  const toast = useToast();
  const load = useCallback(async () => {
    try {
      setCookies(await api.cookies());
    } catch (err) {
      toast.error("Could not load cookies", errorMessage(err));
    }
  }, [toast]);
  useEffect(() => void load(), [load]);
  const [editing, setEditing] = useState<{ cookie: CookieInfo; original?: CookieInfo } | null>(null);
  const domains = new Map<string, CookieInfo[]>();
  for (const c of cookies ?? []) domains.set(c.domain, [...(domains.get(c.domain) ?? []), c]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (err) {
      toast.error("Could not update cookies", errorMessage(err));
    }
  };

  return (
    <Modal
      title="Cookies"
      subtitle="Cookies that responses set, or that you add, go back on matching requests. They are kept per workspace in Yamlet's data folder."
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button variant="cancel" icon={Plus} onClick={() => setEditing({ cookie: { domain: "", path: "/", name: "", value: "" } })}>
            Add cookie
          </Button>
          <Button variant="cancel" icon={RefreshCw} onClick={() => void load()}>
            Refresh
          </Button>
          <Button variant="delete" icon={Trash2} disabled={!cookies?.length} onClick={() => void act(() => api.clearCookies())}>
            Clear all
          </Button>
        </>
      }
    >
      <ExtensionPairing onPaired={load} />
      {editing && (
        <CookieForm
          initial={editing.cookie}
          isNew={!editing.original}
          onCancel={() => setEditing(null)}
          onSave={(cookie) =>
            act(async () => {
              await api.saveCookie(cookie, editing.original && { domain: editing.original.domain, name: editing.original.name, path: editing.original.path });
              setEditing(null);
            })
          }
        />
      )}
      {cookies === null ? (
        <p className="text-13 text-muted">Loading…</p>
      ) : cookies.length === 0 ? (
        <p className="py-6 text-center text-13 text-muted">No cookies yet. They appear after a response sets one.</p>
      ) : (
        <div className="space-y-4">
          {[...domains].map(([domain, list]) => (
            <section key={domain} className="rounded-lg border border-line">
              <header className="flex items-center justify-between border-b border-line-soft px-4 py-2">
                <h3 className="font-mono text-13 font-medium text-ink">{domain}</h3>
                <button type="button" className="text-12 text-muted hover:text-danger" onClick={() => void act(() => api.clearCookies(domain))}>
                  Clear domain
                </button>
              </header>
              <ul>
                {list.map((c) => (
                  <li key={`${c.path}:${c.name}`} className="flex items-center gap-3 border-b border-line-soft px-4 py-2 last:border-0">
                    <span className="w-40 shrink-0 truncate text-13 font-medium text-ink">{c.name}</span>
                    {c.fromBrowser && <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-11 font-medium text-primary">Chrome</span>}
                    <span className="min-w-0 flex-1 truncate font-mono text-12 text-body" title={c.value}>
                      {c.value}
                    </span>
                    <span className="shrink-0 text-11 text-muted">
                      {c.path} · {c.expires ? new Date(c.expires).toLocaleDateString() : "Session"}
                      {c.httpOnly ? " · HttpOnly" : ""}
                      {c.secure ? " · Secure" : ""}
                    </span>
                    <IconButton icon={Pencil} label={`Edit ${c.name}`} onClick={() => setEditing({ cookie: c, original: c })} />
                    <IconButton icon={Trash2} label={`Delete ${c.name}`} danger onClick={() => void act(() => api.deleteCookie(c.domain, c.name, c.path))} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Adds a cookie or edits one; dates are entered in local time. */
function CookieForm({ initial, isNew, onSave, onCancel }: { initial: CookieInfo; isNew: boolean; onSave: (c: CookieInfo) => Promise<void>; onCancel: () => void }) {
  const toLocalInput = (iso?: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  const [c, setC] = useState({ ...initial, expires: toLocalInput(initial.expires) });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof c>) => setC((x) => ({ ...x, ...patch }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({ ...c, expires: c.expires ? new Date(c.expires).toISOString() : undefined });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="mb-5 grid grid-cols-2 gap-3 rounded-lg border border-line p-4" aria-label={isNew ? "Add cookie" : "Edit cookie"}>
      <h3 className="col-span-2 text-13 font-semibold text-ink">{isNew ? "Add cookie" : `Edit ${initial.name}`}</h3>
      <label className="flex flex-col gap-1">
        <span className="label">Domain</span>
        <input className="input font-mono" required placeholder="api.example.com" value={c.domain} onChange={(e) => set({ domain: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Path</span>
        <input className="input font-mono" placeholder="/" value={c.path} onChange={(e) => set({ path: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Name</span>
        <input className="input font-mono" required value={c.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Value</span>
        <input className="input font-mono" value={c.value} onChange={(e) => set({ value: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Expires (empty for a session cookie)</span>
        <input className="input" type="datetime-local" value={c.expires} onChange={(e) => set({ expires: e.target.value })} />
      </label>
      <span className="flex items-end gap-4 pb-2 text-13">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="check" checked={!!c.secure} onChange={(e) => set({ secure: e.target.checked })} /> Secure
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="check" checked={!!c.httpOnly} onChange={(e) => set({ httpOnly: e.target.checked })} /> HttpOnly
        </label>
      </span>
      <div className="col-span-2 flex justify-end gap-2">
        <Button variant="cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {isNew ? "Add" : "Save"}
        </Button>
      </div>
    </form>
  );
}

const EXTENSION_STORE_URL = "https://chromewebstore.google.com/detail/yamlet-interceptor/ojnilooocnngdafipgchmlnaldpejaei";

/** A live one-time code; `expiresAt` is absolute so re-renders cannot extend it. */
interface LiveCode { code: string; expiresAt: number }

type PairFlow =
  | { kind: "idle"; note?: string }
  | { kind: "starting" }
  | ({ kind: "confirm" } & LiveCode)
  | ({ kind: "failed"; error: string } & LiveCode)
  | ({ kind: "code" } & LiveCode);

/**
 * Pairs the Yamlet Interceptor extension. With the extension on this page the code goes
 * straight to it: a known address pairs at once, a new one waits for the user in the
 * extension's own window. The code is shown only when asked for, or when the extension
 * is not on this page.
 */
function ExtensionPairing({ onPaired }: { onPaired: () => Promise<void> }) {
  const extension = useInterceptorExtension();
  const toast = useToast();
  const paired = useInterceptorPaired((s) => s.paired) ?? false;
  const pairedAt = useInterceptorPaired((s) => s.pairedAt);
  const [flow, setFlow] = useState<PairFlow>({ kind: "idle" });

  useEffect(() => void refreshInterceptorStatus(), []);

  const done = useCallback(() => {
    useInterceptorPaired.setState({ paired: true });
    void refreshInterceptorStatus();
    setFlow({ kind: "idle" });
    toast.success("Extension paired", "Approve sites in the extension popup to sync their cookies.");
    void onPaired();
  }, [toast, onPaired]);

  // The extension reports how its confirmation window ended.
  useEffect(
    () =>
      onPairWindow((outcome) => {
        if (outcome.status === "paired") return done();
        setFlow((current) =>
          current.kind !== "confirm"
            ? current
            : outcome.status === "cancelled"
              ? { kind: "idle", note: "Pairing cancelled in the extension." }
              : { kind: "failed", error: outcome.error, code: current.code, expiresAt: current.expiresAt },
        );
      }),
    [done],
  );

  // While a code is live, watch for it to be used, and drop it when it expires.
  const live = flow.kind === "confirm" || flow.kind === "failed" || flow.kind === "code" ? flow : null;
  const liveCode = live?.code;
  const liveExpiresAt = live?.expiresAt ?? 0;
  useEffect(() => {
    if (!liveCode) return;
    // A new pairedAt means a pairing was made, even if the status was stale.
    const timer = setInterval(() => {
      void api.interceptorStatus().then((result) => result.paired && result.pairedAt !== pairedAt && done()).catch(() => {});
    }, 1500);
    const expire = setTimeout(() => setFlow({ kind: "idle", note: "The pairing code expired. Start again." }), Math.max(0, liveExpiresAt - Date.now()));
    return () => {
      clearInterval(timer);
      clearTimeout(expire);
    };
  }, [liveCode, liveExpiresAt, pairedAt, done]);

  const start = async (showCode: boolean) => {
    setFlow({ kind: "starting" });
    try {
      const { code, expiresInSeconds } = await api.interceptorPairStart();
      const live = { code, expiresAt: Date.now() + expiresInSeconds * 1000 };
      if (showCode || !extension) return setFlow({ kind: "code", ...live });
      const outcome = await sendPairCode(code);
      if (outcome.status === "paired") done();
      else if (outcome.status === "confirm") setFlow({ kind: "confirm", ...live });
      else setFlow({ kind: "failed", error: outcome.error, ...live });
    } catch (err) {
      setFlow({ kind: "idle", note: `Could not start pairing: ${errorMessage(err)}` });
    }
  };

  const disconnect = async () => {
    try {
      await api.interceptorDisconnect();
      useInterceptorPaired.setState({ paired: false, pairedAt: null });
      setFlow({ kind: "idle" });
      void onPaired();
    } catch (err) {
      toast.error("Could not disconnect", errorMessage(err));
    }
  };

  const showCode = live && flow.kind !== "code" ? () => setFlow({ kind: "code", code: live.code, expiresAt: live.expiresAt }) : null;

  return (
    <section className="mb-5 rounded-lg border border-line bg-primary-tint p-4">
      <h3 className="text-13 font-semibold text-ink">
        Chrome cookie sync
        {paired && <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-11 font-medium text-primary">Paired</span>}
      </h3>
      <p className="mt-1 text-12 text-body">
        {paired
          ? "Approve sites in the Yamlet Interceptor popup. Their cookies refresh while Chrome and Yamlet are running."
          : "Pair the Yamlet Interceptor extension, then approve individual sites in its popup."}
        {!extension && !paired && (
          <>
            {" Extension not detected on this page. "}
            <a className="font-medium text-primary hover:underline" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
              Get it from the Chrome Web Store
            </a>
            , or reload this tab if you just installed it.
          </>
        )}
      </p>

      {flow.kind === "confirm" && (
        <p className="mt-3 flex items-center gap-2 text-12 text-ink" role="status">
          <Loader2 size={13} className="spin text-primary" aria-hidden /> Confirm in the Yamlet Interceptor window.
        </p>
      )}
      {flow.kind === "failed" && <p className="mt-3 text-12 text-danger" role="alert">{flow.error}</p>}
      {flow.kind === "idle" && flow.note && <p className="mt-3 text-12 text-body" role="status">{flow.note}</p>}
      {flow.kind === "code" && (
        <div className="mt-3 text-12 text-body">
          Paste this one-time code into the extension popup within five minutes:
          <code className="mt-1 block select-all break-all rounded bg-surface p-2 font-mono text-12 text-ink">{flow.code}</code>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!paired && flow.kind !== "code" && flow.kind !== "confirm" && (
          <Button variant="primary" disabled={flow.kind === "starting"} onClick={() => void start(false)}>
            {extension ? "Pair extension" : "Pair with code"}
          </Button>
        )}
        {flow.kind === "confirm" && <Button variant="cancel" onClick={() => setFlow({ kind: "idle" })}>Cancel</Button>}
        {flow.kind === "code" && <Button variant="cancel" onClick={() => setFlow({ kind: "idle" })}>Done</Button>}
        {paired && flow.kind === "idle" && <Button variant="cancel" onClick={() => void disconnect()}>Disconnect extensions</Button>}
        {showCode && (
          <button type="button" className="text-12 text-muted underline-offset-2 hover:text-primary hover:underline" onClick={showCode}>
            Use a code instead
          </button>
        )}
      </div>
    </section>
  );
}
