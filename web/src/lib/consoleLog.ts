// The app-wide console: every request sent in this browser session, with its script logs.
import type { KeyValue, YamletResponse } from "@core/models";
import { create } from "zustand";
import { keys, readJson, writeJson } from "./storage";

export type LogLevel = "log" | "warn" | "error";

export interface ConsoleLog {
  level: LogLevel;
  text: string;
}

export interface ConsoleEntry {
  id: string;
  at: number;
  requestName: string;
  method: string;
  url: string;
  status: number;
  reasonPhrase: string;
  durationMs: number;
  sizeBytes: number;
  /** Set when no response came back. */
  error?: string;
  incomplete?: string;
  requestHeaders: KeyValue[];
  requestBody?: string;
  responseHeaders: KeyValue[];
  /** Clipped to keep the console light; the full body is in the response panel. */
  responseBody: string;
  binary: boolean;
  logs: ConsoleLog[];
}

/** Older entries drop off past this many. */
const MAX_ENTRIES = 300;
/** Bodies are kept up to this many characters. */
export const CONSOLE_BODY_CHARS = 32 * 1024;

const clip = (text: string | undefined) => (text && text.length > CONSOLE_BODY_CHARS ? `${text.slice(0, CONSOLE_BODY_CHARS)}\n[... ${text.length - CONSOLE_BODY_CHARS} more characters]` : (text ?? ""));

/** Script output arrives as plain lines; warnings and errors carry a prefix. */
export function parseLog(line: string): ConsoleLog {
  const m = /^\[(warn|error)\]\s?/.exec(line);
  return m ? { level: m[1] as LogLevel, text: line.slice(m[0].length) } : { level: "log", text: line };
}

export function entryFromResponse(requestName: string, r: YamletResponse): ConsoleEntry {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    requestName,
    method: r.method,
    url: r.resolvedUrl,
    status: r.statusCode,
    reasonPhrase: r.reasonPhrase,
    durationMs: r.durationMs,
    sizeBytes: r.sizeBytes,
    ...(r.isError ? { error: r.errorMessage ?? "Request failed." } : {}),
    ...(r.incomplete ? { incomplete: r.incomplete } : {}),
    requestHeaders: r.requestHeaders,
    requestBody: clip(r.requestBody),
    responseHeaders: r.headers,
    responseBody: r.bodyEncoding === "base64" ? "" : clip(r.body),
    binary: r.bodyEncoding === "base64",
    logs: r.scriptLogs.map(parseLog),
  };
}

interface ConsoleState {
  entries: ConsoleEntry[];
  open: boolean;
  add: (entry: ConsoleEntry) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

export const useConsole = create<ConsoleState>((set) => ({
  entries: [],
  open: readJson<boolean>(keys.consoleOpen, false),
  add: (entry) => set((s) => ({ entries: [...s.entries, entry].slice(-MAX_ENTRIES) })),
  clear: () => set({ entries: [] }),
  setOpen: (open) => {
    writeJson(keys.consoleOpen, open);
    set({ open });
  },
}));
