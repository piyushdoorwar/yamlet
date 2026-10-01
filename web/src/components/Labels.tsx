import clsx from "clsx";

const METHOD_CLASS: Record<string, string> = {
  GET: "text-m-get",
  POST: "text-m-post",
  PUT: "text-m-put",
  PATCH: "text-m-patch",
  DELETE: "text-m-delete",
};

const SHORT: Record<string, string> = { DELETE: "DEL", OPTIONS: "OPT", PATCH: "PATCH" };

export function methodClass(method: string): string {
  return METHOD_CLASS[method.toUpperCase()] ?? "text-m-other";
}

/** HTTP method as plain bold uppercase text in its method color. */
export function MethodLabel({ method, short, className }: { method: string; short?: boolean; className?: string }) {
  const m = method.toUpperCase();
  return <span className={clsx("font-mono text-[10.5px] font-bold tracking-wide", methodClass(m), className)}>{short ? (SHORT[m] ?? m) : m}</span>;
}

export function statusCategory(status: number): "success" | "redirect" | "client" | "server" | "none" {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "redirect";
  if (status >= 400 && status < 500) return "client";
  if (status >= 500) return "server";
  return "none";
}

const STATUS_CLASS = {
  success: "bg-[#e3f4e9] text-[#0b5c33]",
  redirect: "bg-[#e3ecfa] text-[#1a4c97]",
  client: "bg-[#fbefd9] text-[#7a4a00]",
  server: "bg-[#fde4e9] text-[#8f0620]",
  none: "bg-line-soft text-grey",
};

export function StatusPill({ status, text }: { status: number; text?: string }) {
  return (
    <span className={clsx("inline-flex items-center rounded-md px-2 py-0.5 text-12 font-medium", STATUS_CLASS[statusCategory(status)])}>
      {status > 0 ? status : "Error"}
      {text ? ` ${text}` : ""}
    </span>
  );
}
