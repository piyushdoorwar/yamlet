// Connection pools for outgoing requests.
import { Agent } from "undici";

// When a host resolves to several addresses, Node tries them in turn and gives
// each only 250 ms by default. Over Docker networking or a slow link a healthy
// TLS host (e.g. behind a CDN) can miss that window on every address and fail
// with ETIMEDOUT / ENETUNREACH. Give each address a realistic window instead;
// the request's own timeout still bounds the whole exchange.
const ATTEMPT_TIMEOUT_MS = 2500;

let standard: Agent | undefined;
let insecure: Agent | undefined;

export function defaultAgent(): Agent {
  return (standard ??= new Agent({ autoSelectFamily: true, autoSelectFamilyAttemptTimeout: ATTEMPT_TIMEOUT_MS }));
}

/** For requests with "skip SSL verification" on. */
export function insecureAgent(): Agent {
  return (insecure ??= new Agent({ autoSelectFamily: true, autoSelectFamilyAttemptTimeout: ATTEMPT_TIMEOUT_MS, connect: { rejectUnauthorized: false } }));
}
