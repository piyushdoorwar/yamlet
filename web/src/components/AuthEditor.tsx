import type { Auth, AuthType, OAuth2Config, Variable } from "@core/models";
import clsx from "clsx";
import { CircleAlert, CircleCheck, Eye, EyeOff, KeyRound, Loader2, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { CodeEditor, type VariableSource } from "../editor/CodeEditor";
import { api, errorMessage } from "../lib/api";
import { useStore } from "../lib/store";
import { Button } from "./Button";

const TYPES: { id: AuthType; label: string }[] = [
  { id: "inherit", label: "Inherit from collection" },
  { id: "none", label: "No auth" },
  { id: "bearer", label: "Bearer token" },
  { id: "basic", label: "Basic auth" },
  { id: "apikey", label: "API key" },
  { id: "cookie", label: "Cookie" },
  { id: "oauth2", label: "OAuth 2.0" },
];

interface Props {
  auth: Auth;
  onChange: (auth: Auth) => void;
  allowInherit: boolean;
  variables?: VariableSource;
  collectionId?: string;
  requestVariables?: Variable[];
  /** Shown when type is "inherit" (what the collection uses). */
  inheritedLabel?: string;
}

function Field({ label, children, hint, error, warning }: { label: string; children: ReactNode; hint?: ReactNode; error?: string; warning?: string }) {
  return (
    <div className="grid items-start gap-1.5 md:grid-cols-[180px_minmax(0,1fr)] md:gap-4">
      <span className={clsx("pt-2 text-13", error ? "text-danger" : "text-grey")}>{label}</span>
      {/* min-w-0: a long token scrolls inside its field instead of widening the form. */}
      <div className="min-w-0">
        {children}
        {error ? (
          <p className="mt-1 flex items-center gap-1 text-11 text-danger">
            <CircleAlert size={12} aria-hidden /> {error}
          </p>
        ) : warning ? (
          <p className="mt-1 flex items-center gap-1 text-11 text-warning">
            <TriangleAlert size={12} aria-hidden /> {warning}
          </p>
        ) : hint ? (
          <p className="mt-1 text-11 text-muted">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

const PLACEHOLDERS = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** "{{a}} is not defined" for placeholders that resolve to nothing, so the problem shows before sending. */
function unresolvedWarning(value: string, variables?: VariableSource): string | undefined {
  if (!variables) return undefined;
  const missing = [...value.matchAll(PLACEHOLDERS)].map((m) => m[1]).filter((n) => !n.startsWith("$") && !variables.lookup(n)?.value);
  if (!missing.length) return undefined;
  const names = [...new Set(missing)].map((n) => `{{${n}}}`).join(", ");
  return `${names} ${missing.length > 1 ? "have" : "has"} no value in the active scopes`;
}

function VarInput({
  value,
  onChange,
  variables,
  placeholder,
  label,
  invalid,
  secret,
}: {
  value: string;
  onChange: (v: string) => void;
  variables?: VariableSource;
  placeholder?: string;
  label: string;
  invalid?: boolean;
  secret?: boolean;
}) {
  // Secrets start hidden unless they are just a variable reference.
  const [hidden, setHidden] = useState(() => !!secret && !!value && !/^\s*\{\{[^{}]+\}\}\s*$/.test(value));
  return (
    <div
      className={clsx(
        "flex min-w-0 items-center rounded-md border bg-surface pl-2.5 focus-within:shadow-[0_0_0_3px_var(--color-primary-soft)]",
        invalid ? "border-danger focus-within:border-danger" : "border-line focus-within:border-primary",
        !secret && "pr-2.5",
      )}
    >
      <div className="min-w-0 flex-1">
        {hidden ? (
          <input
            type="password"
            className="h-[32px] w-full bg-transparent font-mono text-13 text-ink outline-none"
            value={value}
            aria-label={label}
            autoComplete="off"
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <CodeEditor singleLine value={value} onChange={onChange} variables={variables} placeholder={placeholder} ariaLabel={label} />
        )}
      </div>
      {secret && (
        <button type="button" className="mx-1 shrink-0 rounded p-1.5 text-muted hover:bg-primary-soft hover:text-primary" aria-label={hidden ? `Show ${label}` : `Hide ${label}`} title={hidden ? "Show" : "Hide"} onClick={() => setHidden((h) => !h)}>
          {hidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
        </button>
      )}
    </div>
  );
}

export function AuthEditor({ auth, onChange, allowInherit, variables, collectionId, requestVariables, inheritedLabel }: Props) {
  // Build each change on the latest auth, not the one this render closed over: the
  // token fetch finishes long after its click, and edits made meanwhile must survive.
  const latest = useRef(auth);
  latest.current = auth;
  const set = (patch: Partial<Auth>) => {
    latest.current = { ...latest.current, ...patch };
    onChange(latest.current);
  };
  const setO = (patch: Partial<OAuth2Config>) => set({ oauth2: { ...latest.current.oauth2, ...patch } });
  const types = allowInherit ? TYPES : TYPES.filter((t) => t.id !== "inherit");

  return (
    <div className="max-w-3xl space-y-4">
      <Field label="Type">
        <select className="input max-w-xs" value={auth.type} aria-label="Auth type" onChange={(e) => set({ type: e.target.value as AuthType })}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>

      {auth.type === "inherit" && <p className="text-13 text-muted">This request uses the collection's auth{inheritedLabel ? `: ${inheritedLabel}` : ""}.</p>}
      {auth.type === "none" && <p className="text-13 text-muted">No authorization is sent.</p>}

      {auth.type === "bearer" && (
        <Field label="Token" hint="Sent as Authorization: Bearer <token>.">
          <VarInput label="Token" secret value={auth.token} onChange={(token) => set({ token })} variables={variables} placeholder="{{accessToken}}" />
        </Field>
      )}

      {auth.type === "basic" && (
        <>
          <Field label="Username">
            <VarInput label="Username" value={auth.username} onChange={(username) => set({ username })} variables={variables} />
          </Field>
          <Field label="Password">
            <VarInput label="Password" secret value={auth.password} onChange={(password) => set({ password })} variables={variables} />
          </Field>
        </>
      )}

      {auth.type === "apikey" && (
        <>
          <Field label="Key">
            <VarInput label="Key name" value={auth.apiKeyName} onChange={(apiKeyName) => set({ apiKeyName })} variables={variables} placeholder="X-API-Key" />
          </Field>
          <Field label="Value">
            <VarInput label="Key value" secret value={auth.apiKeyValue} onChange={(apiKeyValue) => set({ apiKeyValue })} variables={variables} />
          </Field>
          <Field label="Add to">
            <select className="input max-w-xs" value={auth.apiKeyIn} aria-label="Add API key to" onChange={(e) => set({ apiKeyIn: e.target.value as Auth["apiKeyIn"] })}>
              <option value="header">Header</option>
              <option value="query">Query params</option>
            </select>
          </Field>
        </>
      )}

      {auth.type === "cookie" && (
        <Field label="Cookie" hint="Sent as the Cookie header, e.g. session=abc; theme=light">
          <VarInput label="Cookie" value={auth.cookie} onChange={(cookie) => set({ cookie })} variables={variables} placeholder="name=value; other=value" />
        </Field>
      )}

      {auth.type === "oauth2" && <OAuth2Fields cfg={auth.oauth2} set={setO} variables={variables} collectionId={collectionId} requestVariables={requestVariables} />}
    </div>
  );
}

type TokenOutcome =
  | { kind: "error"; message: string }
  | { kind: "success"; at: Date; expiresIn?: number; refreshToken: boolean; tokenType?: string };

/** Fields the chosen grant cannot do without. */
function requiredFields(cfg: OAuth2Config): (keyof OAuth2Config)[] {
  if (cfg.grantType === "authorization_code") return ["authUrl", "accessTokenUrl", "clientId"];
  if (cfg.grantType === "password") return ["accessTokenUrl", "username"];
  return ["accessTokenUrl", "clientId"];
}

function formatExpiry(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

function OAuth2Fields({ cfg, set, variables, collectionId, requestVariables }: { cfg: OAuth2Config; set: (p: Partial<OAuth2Config>) => void; variables?: VariableSource; collectionId?: string; requestVariables?: Variable[] }) {
  const environmentId = useStore((s) => s.environmentId);
  const callback = useStore((s) => s.info?.oauthCallbackUrl);
  const [busy, setBusy] = useState<"token" | "signin" | null>(null);
  const [outcome, setOutcome] = useState<TokenOutcome | null>(null);
  const [attempted, setAttempted] = useState(false);
  const cancelled = useRef(false);
  const latestCfg = useRef(cfg);
  latestCfg.current = cfg;

  const missing = new Set(attempted ? requiredFields(cfg).filter((k) => !String(cfg[k] ?? "").trim()) : []);

  const getToken = async () => {
    setAttempted(true);
    setOutcome(null);
    const config = latestCfg.current;
    const empty = requiredFields(config).filter((k) => !String(config[k] ?? "").trim());
    if (empty.length) {
      setOutcome({ kind: "error", message: `Fill in the highlighted field${empty.length > 1 ? "s" : ""} first.` });
      return;
    }
    cancelled.current = false;
    setBusy(config.grantType === "authorization_code" ? "signin" : "token");
    try {
      const body = { config, collectionId, environmentId, requestVariables };
      if (config.grantType === "authorization_code") {
        const { authUrl, state } = await api.authorize(body);
        const popup = window.open(authUrl, "yamlet-oauth", "width=520,height=720");
        if (!popup) throw new Error("The browser blocked the sign-in window. Allow pop-ups for Yamlet and try again.");
        const deadline = Date.now() + 5 * 60_000;
        let closedChecks = 0;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          if (cancelled.current) {
            popup.close();
            return;
          }
          const status = await api.authorizeStatus(state);
          if (status.status === "done") {
            applyToken(status.token);
            return;
          }
          if (status.status === "error") throw new Error(status.error);
          // After the window closes, allow a couple of polls for the token exchange to land.
          if (popup.closed && ++closedChecks > 2) throw new Error("The sign-in window was closed before authorization finished.");
          if (Date.now() > deadline) throw new Error("Timed out after 5 minutes waiting for the sign-in to finish.");
        }
      } else {
        applyToken(await api.fetchToken(body));
      }
    } catch (err) {
      setOutcome({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const applyToken = (token: { accessToken: string; refreshToken?: string; expiresIn?: number; tokenType?: string }) => {
    set({ accessToken: token.accessToken, refreshToken: token.refreshToken ?? latestCfg.current.refreshToken });
    setOutcome({ kind: "success", at: new Date(), expiresIn: token.expiresIn, refreshToken: !!token.refreshToken, tokenType: token.tokenType });
  };

  const text = (key: keyof OAuth2Config, label: string, opts: { placeholder?: string; hint?: ReactNode; secret?: boolean } = {}) => {
    const value = String(cfg[key] ?? "");
    return (
      <Field label={label} hint={opts.hint} error={missing.has(key) ? `${label} is required for this grant type` : undefined} warning={unresolvedWarning(value, variables)}>
        <VarInput
          label={label}
          value={value}
          onChange={(v) => set({ [key]: v } as Partial<OAuth2Config>)}
          variables={variables}
          placeholder={opts.placeholder}
          invalid={missing.has(key)}
          secret={opts.secret}
        />
      </Field>
    );
  };

  return (
    <>
      <div className="rounded-lg border border-line bg-subtle p-4">
        <Field label="Access token" hint="Used for every request with this auth. Fetched below, or paste one." warning={unresolvedWarning(cfg.accessToken, variables)}>
          <VarInput label="Access token" secret value={cfg.accessToken} onChange={(accessToken) => set({ accessToken })} variables={variables} placeholder="Get a new token below, or paste one" />
        </Field>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <Field label="Header prefix">
            <input className="input" value={cfg.headerPrefix} aria-label="Header prefix" onChange={(e) => set({ headerPrefix: e.target.value })} />
          </Field>
          <Field label="Add token to">
            <select className="input" value={cfg.addTokenTo} aria-label="Add token to" onChange={(e) => set({ addTokenTo: e.target.value as OAuth2Config["addTokenTo"] })}>
              <option value="header">Authorization header</option>
              <option value="query">access_token query param</option>
            </select>
          </Field>
        </div>
      </div>

      <h4 className="pt-2 text-13 font-medium text-ink">Get a new access token</h4>
      <Field label="Grant type">
        <select className="input max-w-xs" value={cfg.grantType} aria-label="Grant type" onChange={(e) => set({ grantType: e.target.value as OAuth2Config["grantType"] })}>
          <option value="client_credentials">Client credentials</option>
          <option value="authorization_code">Authorization code (PKCE)</option>
          <option value="password">Password</option>
        </select>
      </Field>
      {cfg.grantType === "authorization_code" && text("authUrl", "Auth URL", { placeholder: "https://provider/authorize" })}
      {text("accessTokenUrl", "Token URL", { placeholder: "https://provider/oauth/token" })}
      {text("clientId", "Client ID")}
      {text("clientSecret", "Client secret", { placeholder: cfg.grantType === "authorization_code" ? "Optional for public clients" : undefined, secret: true })}
      {text("scope", "Scope", { placeholder: "read write" })}
      {cfg.grantType === "password" && (
        <>
          {text("username", "Username")}
          {text("password", "Password", { secret: true })}
        </>
      )}
      {cfg.grantType === "authorization_code" && (
        <>
          {text("redirectUri", "Redirect URI", {
            placeholder: callback,
            hint: <>Leave empty to use {callback ? <span className="font-mono">{callback}</span> : "Yamlet's callback"}; register it with your provider.</>,
          })}
          <Field label="Code challenge">
            <select className="input max-w-xs" value={cfg.challengeAlgorithm} aria-label="Code challenge method" onChange={(e) => set({ challengeAlgorithm: e.target.value as OAuth2Config["challengeAlgorithm"] })}>
              <option value="S256">SHA-256</option>
              <option value="plain">Plain</option>
            </select>
          </Field>
        </>
      )}
      <Field label="Client authentication">
        <select className="input max-w-xs" value={cfg.clientAuthentication} aria-label="Client authentication" onChange={(e) => set({ clientAuthentication: e.target.value as OAuth2Config["clientAuthentication"] })}>
          <option value="basic">Send as Basic auth header</option>
          <option value="body">Send in the request body</option>
        </select>
      </Field>

      {outcome?.kind === "error" && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-danger-line bg-danger-soft px-4 py-3">
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-13 font-medium text-danger">Could not get a token</p>
            <p className="mt-0.5 font-mono text-12 break-words text-danger-ink">{outcome.message}</p>
          </div>
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 text-danger hover:bg-danger-line" onClick={() => setOutcome(null)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
      {outcome?.kind === "success" && (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-line bg-primary-tint px-4 py-3">
          <CircleCheck size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1 text-13">
            <p className="font-medium text-ink">Access token received at {outcome.at.toLocaleTimeString()}</p>
            <p className="mt-0.5 text-12 text-grey">
              {[
                outcome.tokenType && `Type ${outcome.tokenType}`,
                outcome.expiresIn ? `expires in ${formatExpiry(outcome.expiresIn)}` : "no expiry given",
                outcome.refreshToken && "refresh token stored",
              ]
                .filter(Boolean)
                .join(" · ")}
              . It is saved in the access token field above.
            </p>
          </div>
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 text-muted hover:bg-primary-soft" onClick={() => setOutcome(null)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {busy === "signin" && (
          <>
            <span className="mr-auto text-12 text-muted">Finish signing in in the pop-up window.</span>
            <Button variant="cancel" onClick={() => (cancelled.current = true)}>
              Cancel
            </Button>
          </>
        )}
        <Button icon={busy ? Loader2 : KeyRound} disabled={!!busy} onClick={() => void getToken()} className={busy ? "[&_svg]:spin" : undefined}>
          {busy === "signin" ? "Waiting for sign-in" : busy === "token" ? "Requesting token" : "Get new access token"}
        </Button>
      </div>
    </>
  );
}
