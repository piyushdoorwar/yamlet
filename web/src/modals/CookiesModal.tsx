import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CookieInfo } from "../../../shared/api";
import { Button, IconButton } from "../components/Button";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { onPairCancelled, sendPairCode, useInterceptorExtension } from "../lib/interceptor";

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
      subtitle="Set-Cookie responses are stored here and sent back on matching requests. Kept in memory until the server restarts."
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button variant="cancel" icon={RefreshCw} onClick={() => void load()}>
            Refresh
          </Button>
          <Button variant="delete" icon={Trash2} disabled={!cookies?.length} onClick={() => void act(() => api.clearCookies())}>
            Clear all
          </Button>
        </>
      }
    >
      <ExtensionPairing onPaired={() => void load()} />
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

type PairFlow =
  | { kind: "idle"; note?: string }
  | { kind: "starting" }
  | { kind: "confirm"; code: string; expiresInSeconds: number }
  | { kind: "failed"; error: string; code: string; expiresInSeconds: number }
  | { kind: "code"; code: string; expiresInSeconds: number };

/**
 * Pairs the Yamlet Interceptor extension. With the extension on this page the code goes
 * straight to it: a known address pairs at once, a new one waits for the user in the
 * extension's own window. The code is shown only when asked for, or when the extension
 * is not on this page.
 */
function ExtensionPairing({ onPaired }: { onPaired: () => void }) {
  const extension = useInterceptorExtension();
  const toast = useToast();
  const [paired, setPaired] = useState(false);
  const [flow, setFlow] = useState<PairFlow>({ kind: "idle" });

  useEffect(() => {
    void api.interceptorStatus().then((result) => setPaired(result.paired)).catch(() => {});
  }, []);

  const done = useCallback(() => {
    setPaired(true);
    setFlow({ kind: "idle" });
    toast.success("Extension paired", "Approve sites in the extension popup to sync their cookies.");
    onPaired();
  }, [toast, onPaired]);

  useEffect(() => onPairCancelled(() => setFlow((current) => (current.kind === "confirm" ? { kind: "idle", note: "Pairing cancelled in the extension." } : current))), []);

  // While a code is live, watch for it to be used, and drop it when it expires.
  const live = flow.kind === "confirm" || flow.kind === "failed" || flow.kind === "code" ? flow : null;
  const liveCode = live?.code;
  const liveSeconds = live?.expiresInSeconds ?? 0;
  useEffect(() => {
    if (!liveCode) return;
    const timer = setInterval(() => {
      void api.interceptorStatus().then((result) => result.paired && !paired && done()).catch(() => {});
    }, 1500);
    const expire = setTimeout(() => setFlow({ kind: "idle", note: "The pairing code expired. Start again." }), liveSeconds * 1000);
    return () => {
      clearInterval(timer);
      clearTimeout(expire);
    };
  }, [liveCode, liveSeconds, paired, done]);

  const start = async (showCode: boolean) => {
    setFlow({ kind: "starting" });
    try {
      const started = await api.interceptorPairStart();
      if (showCode || !extension) return setFlow({ kind: "code", ...started });
      const outcome = await sendPairCode(started.code);
      if (outcome.status === "paired") done();
      else if (outcome.status === "confirm") setFlow({ kind: "confirm", ...started });
      else setFlow({ kind: "failed", error: outcome.error, ...started });
    } catch (err) {
      setFlow({ kind: "idle", note: `Could not start pairing: ${errorMessage(err)}` });
    }
  };

  const disconnect = async () => {
    try {
      await api.interceptorDisconnect();
      setPaired(false);
      setFlow({ kind: "idle" });
      onPaired();
    } catch (err) {
      toast.error("Could not disconnect", errorMessage(err));
    }
  };

  const showCode = live && flow.kind !== "code" ? () => setFlow({ kind: "code", code: live.code, expiresInSeconds: live.expiresInSeconds }) : null;

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
        {!extension && !paired && " Extension not detected on this page; if you just installed it, reload this tab."}
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
          <code className="mt-1 block select-all break-all rounded bg-white p-2 font-mono text-12 text-ink">{flow.code}</code>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {flow.kind !== "code" && flow.kind !== "confirm" && (
          <Button variant="primary" disabled={flow.kind === "starting"} onClick={() => void start(false)}>
            {extension ? (paired ? "Pair again" : "Pair extension") : "Pair with code"}
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
