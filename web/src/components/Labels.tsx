import clsx from "clsx";

const METHOD_CLASS: Record<string, string> = {
  GET: "text-m-get",
  POST: "text-m-post",
  PUT: "text-m-put",
  PATCH: "text-m-patch",
  DELETE: "text-m-delete",
  QUERY: "text-m-query",
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
  success: "bg-s-success text-s-success-ink",
  redirect: "bg-s-redirect text-s-redirect-ink",
  client: "bg-s-client text-s-client-ink",
  server: "bg-s-server text-s-server-ink",
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
