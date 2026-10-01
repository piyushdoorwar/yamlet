/** An error carrying the HTTP status a route should answer with. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function toHttpError(err: unknown): { statusCode: number; message: string } {
  if (err instanceof HttpError) return { statusCode: err.statusCode, message: err.message };
  const e = (err ?? {}) as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (e.code === "ENOENT") return { statusCode: 404, message: String(e.message ?? "Not found") };
  if (e.code === "EEXIST") return { statusCode: 409, message: String(e.message ?? "Already exists") };
  const status = typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
  return { statusCode: status, message: typeof e.message === "string" && e.message ? e.message : "Unexpected error" };
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `${what} not found`);
}
