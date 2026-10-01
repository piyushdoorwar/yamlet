import type { Auth, AuthType, OAuth2Config, Variable } from "@core/models";
import { KeyRound, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CodeEditor, type VariableSource } from "../editor/CodeEditor";
import { api, errorMessage } from "../lib/api";
import { useStore } from "../lib/store";
import { Button } from "./Button";
import { useToast } from "./Toast";

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

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid items-start gap-1.5 md:grid-cols-[180px_1fr] md:gap-4">
      <span className="pt-2 text-13 text-grey">{label}</span>
      <div>
        {children}
        {hint && <p className="mt-1 text-11 text-muted">{hint}</p>}
      </div>
    </div>
  );
}

function VarInput({ value, onChange, variables, placeholder, label }: { value: string; onChange: (v: string) => void; variables?: VariableSource; placeholder?: string; label: string }) {
  return (
    <div className="rounded-md border border-line bg-white px-2.5 focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--color-primary-soft)]">
      <CodeEditor singleLine value={value} onChange={onChange} variables={variables} placeholder={placeholder} ariaLabel={label} />
    </div>
  );
}

export function AuthEditor({ auth, onChange, allowInherit, variables, collectionId, requestVariables, inheritedLabel }: Props) {
  const set = (patch: Partial<Auth>) => onChange({ ...auth, ...patch });
  const setO = (patch: Partial<OAuth2Config>) => onChange({ ...auth, oauth2: { ...auth.oauth2, ...patch } });
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
          <VarInput label="Token" value={auth.token} onChange={(token) => set({ token })} variables={variables} placeholder="{{accessToken}}" />
        </Field>
      )}

      {auth.type === "basic" && (
        <>
          <Field label="Username">
            <VarInput label="Username" value={auth.username} onChange={(username) => set({ username })} variables={variables} />
          </Field>
          <Field label="Password">
            <VarInput label="Password" value={auth.password} onChange={(password) => set({ password })} variables={variables} />
          </Field>
        </>
      )}

      {auth.type === "apikey" && (
        <>
          <Field label="Key">
            <VarInput label="Key name" value={auth.apiKeyName} onChange={(apiKeyName) => set({ apiKeyName })} variables={variables} placeholder="X-API-Key" />
          </Field>
          <Field label="Value">
            <VarInput label="Key value" value={auth.apiKeyValue} onChange={(apiKeyValue) => set({ apiKeyValue })} variables={variables} />
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

function OAuth2Fields({ cfg, set, variables, collectionId, requestVariables }: { cfg: OAuth2Config; set: (p: Partial<OAuth2Config>) => void; variables?: VariableSource; collectionId?: string; requestVariables?: Variable[] }) {
  const toast = useToast();
  const environmentId = useStore((s) => s.environmentId);
  const callback = useStore((s) => s.info?.oauthCallbackUrl);
  const [busy, setBusy] = useState(false);

  const getToken = async () => {
    setBusy(true);
    try {
      const body = { config: cfg, collectionId, environmentId, requestVariables };
      if (cfg.grantType === "authorization_code") {
        const { authUrl, state } = await api.authorize(body);
        const popup = window.open(authUrl, "yamlet-oauth", "width=520,height=720");
        if (!popup) throw new Error("The browser blocked the sign-in window. Allow pop-ups for Yamlet and try again.");
        const deadline = Date.now() + 5 * 60_000;
        let closedChecks = 0;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          const status = await api.authorizeStatus(state);
          if (status.status === "done") {
            set({ accessToken: status.token.accessToken, refreshToken: status.token.refreshToken ?? cfg.refreshToken });
            toast.success("Access token received");
            return;
          }
          if (status.status === "error") throw new Error(status.error);
          // After the window closes, allow a couple of polls for the token exchange to land.
          if (popup.closed && ++closedChecks > 2) throw new Error("The sign-in window was closed before authorization finished.");
          if (Date.now() > deadline) throw new Error("Timed out waiting for authorization.");
        }
      } else {
        const token = await api.fetchToken(body);
        set({ accessToken: token.accessToken, refreshToken: token.refreshToken ?? cfg.refreshToken });
        toast.success("Access token received", token.expiresIn ? `Expires in ${token.expiresIn}s` : undefined);
      }
    } catch (err) {
      toast.error("Could not get a token", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const text = (key: keyof OAuth2Config, label: string, placeholder?: string, hint?: ReactNode) => (
    <Field label={label} hint={hint}>
      <VarInput label={label} value={String(cfg[key] ?? "")} onChange={(v) => set({ [key]: v } as Partial<OAuth2Config>)} variables={variables} placeholder={placeholder} />
    </Field>
  );

  return (
    <>
      <div className="rounded-lg border border-line bg-[#fafbfa] p-4">
        <Field label="Access token" hint="Used for every request with this auth. Fetched below, or paste one.">
          <VarInput label="Access token" value={cfg.accessToken} onChange={(accessToken) => set({ accessToken })} variables={variables} />
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
      {cfg.grantType === "authorization_code" && text("authUrl", "Auth URL", "https://provider/authorize")}
      {text("accessTokenUrl", "Token URL", "https://provider/oauth/token")}
      {text("clientId", "Client ID")}
      {text("clientSecret", "Client secret", cfg.grantType === "authorization_code" ? "Optional for public clients" : undefined)}
      {text("scope", "Scope", "read write")}
      {cfg.grantType === "password" && (
        <>
          {text("username", "Username")}
          {text("password", "Password")}
        </>
      )}
      {cfg.grantType === "authorization_code" && (
        <>
          {text("redirectUri", "Redirect URI", callback, <>Leave empty to use {callback ? <span className="font-mono">{callback}</span> : "Yamlet's callback"}; register it with your provider.</>)}
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
      <div className="flex justify-end">
        <Button icon={busy ? Loader2 : KeyRound} disabled={busy} onClick={() => void getToken()} className={busy ? "[&_svg]:spin" : undefined}>
          Get new access token
        </Button>
      </div>
    </>
  );
}
