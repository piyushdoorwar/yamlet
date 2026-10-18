// multipart/form-data encoding, shared by request bodies and pm.sendRequest.
import { randomBytes } from "node:crypto";

/** Quotes a multipart parameter (RFC 7578: escape quotes and line breaks). */
const partParam = (s: string) => s.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** A multipart/form-data body: text parts may carry a Content-Type, files are typed by name. */
export function encodeMultipart(parts: { key: string; value: string | Buffer; fileName?: string; contentType?: string }[], boundary = `----YamletBoundary${randomBytes(12).toString("hex")}`): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${partParam(p.key)}"`;
    if (p.fileName !== undefined) head += `; filename="${partParam(p.fileName)}"`;
    head += "\r\n";
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
