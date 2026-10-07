import clsx from "clsx";
import { Cookie, Info, Keyboard, PanelBottom, PanelRight } from "lucide-react";
import { useEffect } from "react";
import { refreshInterceptorStatus, useInterceptorExtension, useInterceptorPaired } from "../lib/interceptor";
import { useStore } from "../lib/store";
import { useUi } from "../lib/ui";

const item = "inline-flex h-6 items-center gap-1.5 rounded px-1.5 text-grey transition-colors hover:bg-primary-soft hover:text-primary";

/** Keeps the pairing state current: on workspace change, on focus and once a minute. */
function useInterceptorStatusPolling(rootPath: string | undefined) {
  useEffect(() => {
    if (!rootPath) return;
    void refreshInterceptorStatus();
    const refresh = () => void refreshInterceptorStatus();
    const timer = setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [rootPath]);
}

/** The thin bar under the workbench: cookies and extension state, layout, help. */
export function StatusBar() {
  const rootPath = useStore((s) => s.workspace?.rootPath);
  const version = useStore((s) => s.info?.version);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const setModal = useUi((s) => s.setModal);
  const paired = useInterceptorPaired((s) => s.paired);
  const extension = useInterceptorExtension();
  useInterceptorStatusPolling(rootPath);

  // Only worth a mention once the extension is around or has been paired.
  const interceptor = paired ? "Interceptor connected" : extension ? "Interceptor not paired" : null;

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-line bg-white px-2 text-11">
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" className={item} onClick={() => setModal({ kind: "cookies" })}>
          <Cookie size={13} aria-hidden /> Cookies
        </button>
        {interceptor && (
          <button type="button" className={item} title="Chrome cookie sync" onClick={() => setModal({ kind: "cookies" })}>
            <span className={clsx("h-1.5 w-1.5 rounded-full", paired ? "bg-primary" : "bg-[#c4ccc7]")} aria-hidden />
            {interceptor}
          </button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={item}
          title={layout === "stacked" ? "Response below. Click to show it on the right" : "Response on the right. Click to show it below"}
          aria-label={layout === "stacked" ? "Show response on the right" : "Show response below"}
          onClick={() => setLayout(layout === "stacked" ? "side" : "stacked")}
        >
          {layout === "stacked" ? <PanelBottom size={13} aria-hidden /> : <PanelRight size={13} aria-hidden />}
        </button>
        <button type="button" className={item} title="Keyboard shortcuts (Ctrl /)" onClick={() => setModal({ kind: "shortcuts" })}>
          <Keyboard size={13} aria-hidden />
          <span className="sr-only">Keyboard shortcuts</span>
        </button>
        <button type="button" className={item} title="About Yamlet" onClick={() => setModal({ kind: "about" })}>
          <Info size={13} aria-hidden /> Yamlet {version && version !== "dev" ? `v${version}` : "dev"}
        </button>
      </div>
    </footer>
  );
}
