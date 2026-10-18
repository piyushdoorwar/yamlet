import type { AppSettings, ClientCertificate, ProxyMode } from "@core/models";
import clsx from "clsx";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { SettingsResult } from "../../../shared/api";
import { IconButton } from "../components/Button";
import { Modal } from "../components/Modal";
import { TabButton } from "../components/Tabs";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";

type Section = "general" | "proxy" | "certificates";

function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-line-soft py-4 last:border-0">
      <span className="min-w-0">
        <label htmlFor={htmlFor} className="block text-13 font-medium text-ink">
          {label}
        </label>
        {hint && <span className="mt-0.5 block text-12 text-muted">{hint}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}

function NumberInput({ id, value, onChange, step, unit }: { id: string; value: number; onChange: (n: number) => void; step: number; unit: string }) {
  return (
    <span className="flex items-center gap-2">
      <input id={id} type="number" min={0} step={step} className="input w-28 text-right" value={value} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} />
      <span className="w-6 text-12 text-muted">{unit}</span>
    </span>
  );
}

const blankCert = (): ClientCertificate => ({ host: "", certPath: "", keyPath: "", pfxPath: "", passphrase: "" });

/** Machine-wide settings: timeouts, response size, proxy and certificates. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<SettingsResult | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [section, setSection] = useState<Section>("general");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setLoaded(r);
        setDraft(r.settings);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const net = draft?.network;
  const setNet = (patch: Partial<AppSettings["network"]>) => draft && setDraft({ ...draft, network: { ...draft.network, ...patch } });
  const setProxy = (patch: Partial<AppSettings["network"]["proxy"]>) => net && setNet({ proxy: { ...net.proxy, ...patch } });
  const setCert = (i: number, patch: Partial<ClientCertificate>) => net && setNet({ clientCertificates: net.clientCertificates.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      // Rows left without a host are dropped rather than rejected.
      const clean = { ...draft, network: { ...draft.network, clientCertificates: draft.network.clientCertificates.filter((c) => c.host.trim()), caCertificatePaths: draft.network.caCertificatePaths.filter((p) => p.trim()) } };
      await api.saveSettings(clean);
      toast.success("Settings saved");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const env = loaded?.systemProxy;
  const envProxy = env?.httpsProxy || env?.httpProxy;

  return (
    <Modal
      title="Settings"
      subtitle={loaded?.filePath ? `Saved on this machine in ${loaded.filePath}` : "Kept until the server stops"}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button type="button" className="btn btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!draft || saving} onClick={() => void save()}>
            {saving && <Loader2 size={14} className="spin" aria-hidden />} Save
          </button>
        </>
      }
    >
      {!draft || !net ? (
        error ? <p className="text-13 text-danger">{error}</p> : <Loader2 size={18} className="spin mx-auto text-primary" aria-label="Loading" />
      ) : (
        <div className="flex flex-col gap-4">
          <TabButton<Section>
            tabs={[
              { id: "general", label: "General" },
              { id: "proxy", label: "Proxy" },
              { id: "certificates", label: "Certificates" },
            ]}
            active={section}
            onChange={setSection}
          />

          {section === "general" && (
            <div>
              <Field label="Request timeout" hint="How long a request may take before it is abandoned. 0 means no limit. A request's own timeout setting wins." htmlFor="set-timeout">
                <NumberInput id="set-timeout" value={draft.timeoutMs} step={1000} unit="ms" onChange={(timeoutMs) => setDraft({ ...draft, timeoutMs })} />
              </Field>
              <Field label="Maximum response size" hint="Bodies past this size are cut off, with a notice. 0 keeps everything." htmlFor="set-max">
                <NumberInput id="set-max" value={draft.maxResponseMb} step={10} unit="MB" onChange={(maxResponseMb) => setDraft({ ...draft, maxResponseMb })} />
              </Field>
              <Field label="Use HTTP/2 when the server offers it" hint="Turn off to always use HTTP/1.1. The network details on a response show which was used." htmlFor="set-h2">
                <input id="set-h2" type="checkbox" className="check" checked={net.http2 !== false} onChange={(e) => setNet({ http2: e.target.checked })} />
              </Field>
              <Field label="Verify SSL certificates" hint="Turn off to accept self-signed and expired certificates everywhere. Requests can also turn it off one by one." htmlFor="set-ssl">
                <input id="set-ssl" type="checkbox" className="check" checked={net.verifySsl} onChange={(e) => setNet({ verifySsl: e.target.checked })} />
              </Field>
            </div>
          )}

          {section === "proxy" && (
            <div className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Proxy</legend>
                {(
                  [
                    ["system", "Use the system proxy", envProxy ? `From the server's environment: ${envProxy}${env?.noProxy ? `, bypassing ${env.noProxy}` : ""}` : "No HTTP_PROXY or HTTPS_PROXY is set where the server runs, so requests go direct."],
                    ["custom", "Use a custom proxy", "One proxy for HTTP and HTTPS requests."],
                    ["none", "No proxy", "Always connect directly."],
                  ] as [ProxyMode, string, string][]
                ).map(([mode, label, hint]) => (
                  <label key={mode} className={clsx("flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5", net.proxy.mode === mode ? "border-primary bg-primary-soft" : "border-line")}>
                    <input type="radio" name="proxy-mode" className="mt-1" checked={net.proxy.mode === mode} onChange={() => setProxy({ mode })} />
                    <span>
                      <span className="block text-13 font-medium text-ink">{label}</span>
                      <span className="block text-12 break-all text-muted">{hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {net.proxy.mode === "custom" && (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="label">Proxy URL</span>
                    <input className="input font-mono" placeholder="http://user:password@proxy.local:8080" value={net.proxy.url} onChange={(e) => setProxy({ url: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="label">Bypass for these hosts</span>
                    <input className="input font-mono" placeholder="localhost, 127.0.0.1, .internal.example.com" value={net.proxy.bypass} onChange={(e) => setProxy({ bypass: e.target.value })} />
                  </label>
                </div>
              )}
            </div>
          )}

          {section === "certificates" && (
            <div className="flex flex-col gap-5">
              <section>
                <h3 className="text-13 font-medium text-ink">CA certificates</h3>
                <p className="mt-0.5 mb-2 text-12 text-muted">PEM files of extra authorities to trust, such as a company CA. Paths are on the machine (or container) running Yamlet.</p>
                {net.caCertificatePaths.map((p, i) => (
                  <div key={i} className="mb-2 flex items-center gap-2">
                    <input
                      className="input flex-1 font-mono"
                      placeholder="/workspace/certs/company-ca.pem"
                      aria-label={`CA certificate ${i + 1}`}
                      value={p}
                      onChange={(e) => setNet({ caCertificatePaths: net.caCertificatePaths.map((x, j) => (j === i ? e.target.value : x)) })}
                    />
                    <IconButton icon={Trash2} label="Remove CA certificate" danger onClick={() => setNet({ caCertificatePaths: net.caCertificatePaths.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNet({ caCertificatePaths: [...net.caCertificatePaths, ""] })}>
                  <Plus size={14} aria-hidden /> Add CA certificate
                </button>
              </section>
              <section>
                <h3 className="text-13 font-medium text-ink">Client certificates</h3>
                <p className="mt-0.5 mb-2 text-12 text-muted">Sent to hosts that ask for one (mutual TLS). Give a certificate and key, or a PFX file. Not used through a proxy.</p>
                {net.clientCertificates.map((c, i) => (
                  <div key={i} className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-line p-3">
                    <label className="col-span-2 flex items-center gap-2">
                      <span className="label w-16 shrink-0">Host</span>
                      <input className="input flex-1 font-mono" placeholder="api.example.com or *.example.com:8443" value={c.host} onChange={(e) => setCert(i, { host: e.target.value })} />
                      <IconButton icon={Trash2} label="Remove client certificate" danger onClick={() => setNet({ clientCertificates: net.clientCertificates.filter((_, j) => j !== i) })} />
                    </label>
                    <input className="input font-mono" placeholder="Certificate (.crt / .pem)" aria-label="Certificate file" value={c.certPath} onChange={(e) => setCert(i, { certPath: e.target.value })} />
                    <input className="input font-mono" placeholder="Key (.key)" aria-label="Key file" value={c.keyPath} onChange={(e) => setCert(i, { keyPath: e.target.value })} />
                    <input className="input font-mono" placeholder="Or PFX (.pfx / .p12)" aria-label="PFX file" value={c.pfxPath} onChange={(e) => setCert(i, { pfxPath: e.target.value })} />
                    <input className="input" type="password" autoComplete="off" placeholder="Passphrase" aria-label="Passphrase" value={c.passphrase} onChange={(e) => setCert(i, { passphrase: e.target.value })} />
                  </div>
                ))}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNet({ clientCertificates: [...net.clientCertificates, blankCert()] })}>
                  <Plus size={14} aria-hidden /> Add client certificate
                </button>
              </section>
            </div>
          )}
          {error && <p role="alert" className="text-13 text-danger">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
