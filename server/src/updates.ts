// Checks GitHub for a newer stable release, at most once an hour and only when the UI
// asks (so an idle server makes no requests). Turned off for dev builds and with
// YAMLET_UPDATE_CHECK=0.
import { type Dispatcher, request } from "undici";
import type { UpdateInfo } from "../../shared/api.js";

const RELEASES_API = "https://api.github.com/repos/piyushdoorwar/yamlet/releases/latest";
const CHECK_EVERY_MS = 60 * 60 * 1000;

type Semver = [number, number, number, string];

export function parseVersion(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** True when `latest` is a newer version than `current` (a release beats its own pre-releases). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  if (a[3] === b[3]) return false;
  if (!a[3]) return true;
  if (!b[3]) return false;
  return a[3].localeCompare(b[3], undefined, { numeric: true }) > 0;
}

export class UpdateChecker {
  private info: UpdateInfo;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly current: string,
    private readonly enabled: boolean,
    private readonly dispatcher?: Dispatcher,
  ) {
    this.info = { enabled, current, available: false };
  }

  async get(force = false): Promise<UpdateInfo> {
    if (!this.enabled) return this.info;
    const last = this.info.checkedAt ? Date.parse(this.info.checkedAt) : 0;
    if (force || Date.now() - last > CHECK_EVERY_MS) {
      this.inflight ??= this.check().finally(() => (this.inflight = null));
      await this.inflight;
    }
    return this.info;
  }

  private async check(): Promise<void> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await request(RELEASES_API, {
        headers: { accept: "application/vnd.github+json", "user-agent": `Yamlet/${this.current}` },
        dispatcher: this.dispatcher,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      const body = (await res.body.json()) as { tag_name?: string; html_url?: string; published_at?: string };
      if (res.statusCode !== 200 || !body.tag_name) throw new Error(`GitHub answered ${res.statusCode}`);
      const latest = body.tag_name.replace(/^v/, "");
      this.info = {
        enabled: true,
        current: this.current,
        latest,
        available: isNewer(latest, this.current),
        releaseUrl: body.html_url,
        publishedAt: body.published_at,
        checkedAt,
      };
    } catch (err) {
      // Keep the last good answer; just record that this check failed.
      this.info = { ...this.info, checkedAt, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
