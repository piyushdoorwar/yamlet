import type { RequestSettings } from "@core/models";

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6 border-b border-line-soft py-4">
      <span>
        <span className="block text-13 font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-12 text-muted">{hint}</span>
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-5 w-9 rounded-full bg-line-strong transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/30" />
        <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

export function SettingsPane({ settings, onChange }: { settings: RequestSettings; onChange: (s: RequestSettings) => void }) {
  return (
    <div className="max-w-2xl">
      <Toggle
        label="Follow redirects"
        hint="Follow 3xx responses automatically (up to 10 hops)."
        checked={settings.followRedirects}
        onChange={(followRedirects) => onChange({ ...settings, followRedirects })}
      />
      <Toggle
        label="Skip SSL certificate verification"
        hint="Accept self-signed or expired certificates for this request."
        checked={settings.skipSslVerification}
        onChange={(skipSslVerification) => onChange({ ...settings, skipSslVerification })}
      />
      <div className="flex items-start justify-between gap-6 py-4">
        <span>
          <label htmlFor="req-timeout" className="block text-13 font-medium text-ink">
            Timeout
          </label>
          <span className="mt-0.5 block text-12 text-muted">Milliseconds before the request is abandoned. 0 uses the server default.</span>
        </span>
        <input
          id="req-timeout"
          type="number"
          min={0}
          step={1000}
          className="input w-32 text-right"
          value={settings.timeoutMs}
          onChange={(e) => onChange({ ...settings, timeoutMs: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
    </div>
  );
}
