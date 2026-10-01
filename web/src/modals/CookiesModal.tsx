import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CookieInfo } from "../../../shared/api";
import { Button, IconButton } from "../components/Button";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";

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
