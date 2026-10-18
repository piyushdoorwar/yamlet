// Machine-wide settings (timeouts, proxy, certificates) in <dataDir>/settings.json.
// They describe this machine, not the API, so they never go into the workspace.
import { promises as fs } from "node:fs";
import path from "node:path";
import { type AppSettings, defaultAppSettings, defaultNetworkSettings, type NetworkSettings } from "./models.js";

export const SETTINGS_FILE = "settings.json";

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Fills gaps and drops junk so a hand-edited or older file still loads. */
export function normalizeSettings(raw: unknown, defaults: AppSettings = defaultAppSettings()): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>;
  const n = (r.network ?? {}) as Partial<NetworkSettings>;
  const d = defaultNetworkSettings();
  const mode = n.proxy?.mode;
  return {
    timeoutMs: num(r.timeoutMs, defaults.timeoutMs),
    maxResponseMb: num(r.maxResponseMb, defaults.maxResponseMb),
    network: {
      verifySsl: typeof n.verifySsl === "boolean" ? n.verifySsl : d.verifySsl,
      http2: n.http2 !== false,
      caCertificatePaths: Array.isArray(n.caCertificatePaths) ? n.caCertificatePaths.map(str).filter(Boolean) : [],
      clientCertificates: Array.isArray(n.clientCertificates)
        ? n.clientCertificates
            .map((c) => ({ host: str(c?.host).trim(), certPath: str(c?.certPath), keyPath: str(c?.keyPath), pfxPath: str(c?.pfxPath), passphrase: str(c?.passphrase) }))
            .filter((c) => c.host)
        : [],
      proxy: {
        mode: mode === "none" || mode === "custom" || mode === "system" ? mode : d.proxy.mode,
        url: str(n.proxy?.url).trim(),
        bypass: str(n.proxy?.bypass),
      },
    },
  };
}

/** Throws a readable message when settings can't work. */
export function validateSettings(s: AppSettings): void {
  const p = s.network.proxy;
  if (p.mode === "custom") {
    let url: URL;
    try {
      url = new URL(p.url);
    } catch {
      throw new Error("Enter the proxy as a URL, e.g. http://proxy.local:8080");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("The proxy URL must start with http:// or https://");
  }
  for (const c of s.network.clientCertificates) {
    if (!c.pfxPath && !(c.certPath && c.keyPath)) throw new Error(`The certificate for ${c.host} needs a certificate and key file, or a PFX file.`);
  }
}

export class SettingsFile {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly filePath: string | undefined,
    private current: AppSettings,
    private readonly defaults: AppSettings,
  ) {}

  /** Loads `<dataDir>/settings.json`; without a data folder settings live in memory. */
  static async open(dataDir: string | undefined, defaults: AppSettings = defaultAppSettings()): Promise<SettingsFile> {
    if (!dataDir) return new SettingsFile(undefined, defaults, defaults);
    const filePath = path.join(dataDir, SETTINGS_FILE);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      raw = undefined;
    }
    return new SettingsFile(filePath, normalizeSettings(raw, defaults), defaults);
  }

  get(): AppSettings {
    return structuredClone(this.current);
  }

  /** Validates, stores and returns the cleaned settings. */
  async save(next: unknown): Promise<AppSettings> {
    const clean = normalizeSettings(next, this.defaults);
    validateSettings(clean);
    this.current = clean;
    if (this.filePath) {
      const file = this.filePath;
      const write = async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        // Owner-only: it can hold a proxy password and certificate passphrases.
        await fs.writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(tmp, file);
      };
      this.queue = this.queue.then(write, write);
      await this.queue;
    }
    return this.get();
  }
}
