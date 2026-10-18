import type { Completion } from "@codemirror/autocomplete";

const fn = (label: string, detail: string, apply?: string): Completion => ({ label, detail, type: "function", apply: apply ?? label });
const prop = (label: string, detail: string): Completion => ({ label, detail, type: "property" });

/** Script-editor suggestions for the `pm` API. */
export const PM_COMPLETIONS: Completion[] = [
  fn("pm.test", "Define a named test", 'pm.test("name", () => {\n  \n});'),
  fn("pm.expect", "Assertion", "pm.expect()"),
  fn("pm.environment.get", "Environment variable", 'pm.environment.get("")'),
  fn("pm.environment.set", "Set environment variable", 'pm.environment.set("", "")'),
  fn("pm.environment.unset", "Remove environment variable", 'pm.environment.unset("")'),
  fn("pm.collectionVariables.get", "Collection variable", 'pm.collectionVariables.get("")'),
  fn("pm.collectionVariables.set", "Set collection variable", 'pm.collectionVariables.set("", "")'),
  fn("pm.globals.get", "Global variable", 'pm.globals.get("")'),
  fn("pm.globals.set", "Set global variable", 'pm.globals.set("", "")'),
  fn("pm.variables.get", "Variable from any scope", 'pm.variables.get("")'),
  fn("pm.variables.set", "Set request-scope variable", 'pm.variables.set("", "")'),
  fn("pm.variables.replaceIn", "Resolve {{placeholders}}", 'pm.variables.replaceIn("")'),
  fn("pm.iterationData.get", "Runner data-file value", 'pm.iterationData.get("")'),
  prop("pm.request.url", "Request URL"),
  prop("pm.request.method", "Request method"),
  fn("pm.request.headers.add", "Add a header", 'pm.request.headers.add({ key: "", value: "" })'),
  fn("pm.request.headers.upsert", "Add or replace a header", 'pm.request.headers.upsert({ key: "", value: "" })'),
  fn("pm.request.headers.remove", "Remove a header", 'pm.request.headers.remove("")'),
  prop("pm.response.code", "Status code"),
  prop("pm.response.status", "Status text"),
  prop("pm.response.responseTime", "Response time (ms)"),
  fn("pm.response.json", "Parsed JSON body", "pm.response.json()"),
  fn("pm.response.text", "Body as text", "pm.response.text()"),
  fn("pm.response.headers.get", "Response header", 'pm.response.headers.get("")'),
  fn("pm.response.to.have.status", "Assert status", "pm.response.to.have.status(200)"),
  fn("console.log", "Log to the response console", "console.log()"),
  fn("JSON.parse", "Parse JSON", "JSON.parse()"),
  fn("JSON.stringify", "Serialize JSON", "JSON.stringify()"),
  fn("pm.execution.skipRequest", "Don't send this request (pre-request script)", "pm.execution.skipRequest()"),
  fn("pm.execution.setNextRequest", "Runner: run this request next, or null to stop", 'pm.execution.setNextRequest("")'),
  fn("pm.response.to.have.jsonSchema", "Assert the JSON body matches a schema", "pm.response.to.have.jsonSchema(schema)"),
  fn("CryptoJS.HmacSHA256", "HMAC-SHA256 (crypto-js)", 'CryptoJS.HmacSHA256("message", "secret").toString(CryptoJS.enc.Base64)'),
  fn("CryptoJS.SHA256", "SHA-256 hash (crypto-js)", 'CryptoJS.SHA256("").toString()'),
  fn("CryptoJS.MD5", "MD5 hash (crypto-js)", 'CryptoJS.MD5("").toString()'),
  fn("Buffer.from", "Bytes from text or base64", 'Buffer.from("", "utf8").toString("base64")'),
];
