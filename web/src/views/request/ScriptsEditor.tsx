import { useRef, useState } from "react";
import { TabButton } from "../../components/Tabs";
import { CodeEditor, type CodeEditorHandle } from "../../editor/CodeEditor";

const PRE_SNIPPETS = [
  { label: "Set an environment variable", code: 'pm.environment.set("name", "value");' },
  { label: "Set a request variable", code: 'pm.variables.set("name", "value");' },
  { label: "Add a header", code: 'pm.request.headers.add({ key: "X-Request-Id", value: pm.variables.replaceIn("{{$guid}}") });' },
  { label: "Log the URL", code: "console.log(pm.request.url);" },
  { label: "Timestamp variable", code: 'pm.variables.set("now", String(Date.now()));' },
];

const POST_SNIPPETS = [
  { label: "Status code is 200", code: 'pm.test("Status code is 200", () => {\n  pm.response.to.have.status(200);\n});' },
  { label: "Response time below 500ms", code: 'pm.test("Response time is below 500ms", () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});' },
  { label: "Body is JSON with a field", code: 'pm.test("Body has an id", () => {\n  const json = pm.response.json();\n  pm.expect(json).to.have.property("id");\n});' },
  { label: "Body contains text", code: 'pm.test("Body contains text", () => {\n  pm.expect(pm.response.text()).to.include("expected");\n});' },
  { label: "Header is present", code: 'pm.test("Content-Type is present", () => {\n  pm.expect(pm.response.headers.get("Content-Type")).to.exist;\n});' },
  { label: "Save a token from the body", code: 'const json = pm.response.json();\npm.environment.set("accessToken", json.access_token);' },
];

export function ScriptsEditor({ pre, post, onChange }: { pre: string; post: string; onChange: (patch: { preRequestScript?: string; postResponseScript?: string }) => void }) {
  const [which, setWhich] = useState<"pre" | "post">(pre || !post ? "pre" : "post");
  const editor = useRef<CodeEditorHandle>(null);
  const value = which === "pre" ? pre : post;
  const set = (v: string) => onChange(which === "pre" ? { preRequestScript: v } : { postResponseScript: v });

  const insert = (code: string) => {
    const view = editor.current?.view();
    if (!view) return set(value ? `${value}\n\n${code}` : code);
    const end = view.state.doc.length;
    const text = (end > 0 ? "\n\n" : "") + code;
    view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length } });
    view.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pb-3">
        <TabButton
          size="sm"
          tabs={[
            { id: "pre", label: "Pre-request", badge: pre.trim() ? <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" /> : null },
            { id: "post", label: "Post-response", badge: post.trim() ? <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" /> : null },
          ]}
          active={which}
          onChange={setWhich}
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line">
          <CodeEditor
            key={which}
            ref={editor}
            fill
            language="javascript"
            value={value}
            onChange={set}
            placeholder={which === "pre" ? "// Runs before the request is sent" : "// Runs after the response arrives. Use pm.test(...) for assertions."}
            ariaLabel={which === "pre" ? "Pre-request script" : "Post-response script"}
          />
        </div>
        <aside className="hidden w-52 shrink-0 overflow-y-auto lg:block" aria-label="Snippets">
          <p className="mb-2 text-11 font-medium tracking-wide text-muted uppercase">Snippets</p>
          <ul className="space-y-0.5">
            {(which === "pre" ? PRE_SNIPPETS : POST_SNIPPETS).map((s) => (
              <li key={s.label}>
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-left text-12 text-primary hover:bg-primary-soft" onClick={() => insert(s.code)}>
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
