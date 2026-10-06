import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CookieInfo } from "../../../shared/api";
import { Button, IconButton } from "../components/Button";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";

export function CookiesModal({ onClose }: { onClose: () => void }) {
  const [cookies, setCookies] = useState<CookieInfo[] | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresInSeconds: number } | null>(null);
  const [paired, setPaired] = useState(false);
  const toast = useToast();
  const load = useCallback(async () => {
    try {
      setCookies(await api.cookies());
    } catch (err) {
      toast.error("Could not load cookies", errorMessage(err));
    }
  }, [toast]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void api.interceptorStatus().then((result) => setPaired(result.paired)).catch(() => {});
  }, []);

  // While a code is on screen, watch for the extension to use it.
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => {
      void api
        .interceptorStatus()
        .then(async (result) => {
          if (!result.paired || paired) return;
          setPaired(true);
          setPairing(null);
          toast.success("Extension paired", "Approve sites in the extension popup to sync their cookies.");
          await load();
        })
        .catch(() => {});
    }, 2000);
    const expire = setTimeout(() => setPairing(null), pairing.expiresInSeconds * 1000);
    return () => {
      clearInterval(timer);
      clearTimeout(expire);
    };
  }, [pairing, paired, toast, load]);

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
      <section className="mb-5 rounded-lg border border-line bg-primary-tint p-4">
        <h3 className="text-13 font-semibold text-ink">
          Chrome cookie sync
          {paired && <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-11 font-medium text-primary">Paired</span>}
        </h3>
        <p className="mt-1 text-12 text-body">Pair the Yamlet Interceptor extension, then approve individual sites in its popup. Approved cookies refresh while Chrome and Yamlet are running.</p>
        {pairing && <p className="mt-3 text-12 text-body">Paste this one-time code into the extension within five minutes: <code className="block select-all break-all rounded bg-white p-2 font-mono text-12 text-ink">{pairing.code}</code></p>}
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => void api.interceptorPairStart().then(setPairing).catch((err: unknown) => toast.error("Could not start pairing", errorMessage(err)))}>Pair extension</Button>
          {paired && <Button variant="cancel" onClick={() => void act(async () => { await api.interceptorDisconnect(); setPaired(false); setPairing(null); })}>Disconnect extensions</Button>}
        </div>
      </section>
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
