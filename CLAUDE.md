# CLAUDE.md

Guidance for working in the Yamlet codebase.

## What Yamlet is

Yamlet is a local-first API client for Git-friendly, YAML-based API collections. It's a
web app: a small Node server (Fastify) that reads and writes a workspace folder on disk
and sends HTTP requests, plus a React UI served from the same origin. Users run it from
the public container image `ghcr.io/piyushdoorwar/yamlet`, mount a folder at
`/workspace`, and open <http://localhost:7878>. A Node CLI (`@piyushdoorwar/yamlet` on npm, command `yamlet`) runs
workspaces headlessly for CI.

The earlier .NET/Avalonia desktop app was replaced by this rewrite; its last commit is
tagged `dotnet-final`.

## Hard rules

- **Never name other API client products** anywhere in source, UI text, comments, test
  names, file names or docs. Use Yamlet terminology; call the import format "v2.1
  collection JSON export". (Real user data may live in folders named after other
  clients; that's their data, so don't rename it, but don't echo those names.)
- **No emojis anywhere.** Icons are SVG: `lucide-react` in the UI, inline SVG on the
  site. The brand mark is [web/src/components/Logo.tsx](web/src/components/Logo.tsx)
  (rounded badge with a "Y" stroke).
- **Commits carry only the user's name.** No co-author trailers or "generated with"
  lines. Work directly on `main` (trunk-based); don't create feature branches.
- **Light theme only: white surfaces, dark-green accent.** Colors are tokens in
  [web/src/styles.css](web/src/styles.css) (`--color-primary: #0e7a43`). Green buttons
  carry white text.

## Commands

```bash
npm install
npm run dev          # server on :7878 (tsx watch) + Vite on :5173 (proxies /api)
                     # if a Yamlet container already owns 7878: PORT=7880 YAMLET_API_PORT=7880 npm run dev
npm test             # all Vitest projects: node (core, server, cli) + web (jsdom)
npm run typecheck    # tsconfig.server.json (core, server, shared, cli) + tsconfig.web.json
npm run build        # vite build -> dist/web, tsc -> dist/server, dist/core, dist/shared
npm start            # node dist/server/src/index.js
npm run build:cli    # esbuild bundle -> cli/dist/yamlet.js
docker build -t yamlet .
```

## Layout

One root `package.json` (ESM, Node 22+) holds the app; `cli/` has its own
`package.json` for publishing.

```
core/src/     UI-free engine (TypeScript, NodeNext: relative imports end in .js)
  models.ts            domain types + factories (newRequest, defaultAuth, ...)
  yamlDtos.ts          on-disk YAML shapes, toDomain/fromDomain, imported-format readers
  workspaceStore.ts    WorkspaceStore: load a workspace, id-based mutations written to disk
  pathNaming.ts        safe, unique file and folder names
  variableResolver.ts  {{var}} resolution, lookup, placeholder scan        (isomorphic)
  dynamicVariables.ts  {{$guid}}, {{$timestamp}}, {{$random*}} catalog    (isomorphic)
  requestBuilder.ts    request + scopes -> BuiltRequest (url, headers, auth, body) (isomorphic)
  codegen.ts           code snippets from a BuiltRequest                  (isomorphic)
  curl.ts              cURL command -> request                            (isomorphic)
  importers.ts         v2.1 collection/environment JSON, OpenAPI/Swagger  (isomorphic)
  cookieJar.ts         cookie storage and matching                         (isomorphic)
  scriptRunner.ts      pre/post scripts in node:vm with the `pm` API
  oauth2.ts            token endpoint calls, PKCE, authorization URL
  requestExecutor.ts   execute(): scripts, build, auth, send via undici, response
  collectionRunner.ts  runCollection(): iterations, data files, bail, live results
  browser.ts           re-exports only the isomorphic modules
server/src/   Fastify app: app.ts (wiring), security.ts, context.ts (open workspaces,
              cookie jars), routes/*.ts (one file per area)
shared/api.ts JSON request/response shapes shared by server and web
web/src/      React 19 + Vite 7 + Tailwind 4 UI
  lib/         api.ts (fetch client), store.ts (zustand app state), ui.ts (modals,
               sidebar), actions.tsx (tree actions), variables.ts, urlSync.ts, tree.ts
  components/  Button, Modal, Dialogs (confirm/prompt), Toast, Menu, Tabs,
               KeyValueTable, AuthEditor, FolderBrowser, FileChooser, Page, Labels
  editor/      CodeEditor (CodeMirror 6) with {{variable}} highlight/peek/autocomplete
  sidebar/     Sidebar, CollectionsTree, EnvironmentsList, HistoryList
  views/       Workbench, TopBar, TabContent, request/*, CollectionView, FolderView,
               EnvironmentView (+ Globals), RunnerView, WelcomeView, EmptyTabs, StatusBar
  modals/      Import, QuickOpen (Ctrl+K), Snippet, Cookies, OpenWorkspace, About, Shortcuts
cli/          `@piyushdoorwar/yamlet` npm package (bin `yamlet`): src/index.ts, build.mjs (esbuild), README.md
site/         static marketing site (GitHub Pages at https://yamlet.piyushdoorwar.com/), no build step
samples/demo  ready-to-run workspace; CI runs it with the CLI
```

The web build imports engine modules through the `@core/*` alias (vite.config.ts,
vitest.config.ts, tsconfig.web.json). **Only import isomorphic modules from the UI**
(see `browser.ts`); node-only modules (`node:*`, undici) must stay server-side.

## Key architectural decisions

- **Domain models are decoupled from the file format.** `core/src/models.ts` is what the
  UI and server speak; `yamlDtos.ts` maps to/from on-disk YAML. Never serialize domain
  objects straight to YAML.
- **Each request file is the single source of truth.** A request lives entirely in its
  own `<request>.yaml` (method, url, params, headers, path vars, variables, auth, body,
  scripts, settings, examples, description, `order`). `collection.yaml` is metadata only
  (id, name, description, variables, auth, scripts, `order`). Each folder has a
  `folder.yaml` (name, description, `order`).
- **Tree order is persisted per file** via `order`; ties fall back to filename. After
  structural changes the store renumbers the affected container.
- **Backward compatibility: old and imported formats are read, never written.**
  `yamlDtos.ts` reads legacy `collection.yaml` (info/variable/event), exported
  `.resources/definition.yaml` (variables as a map, auth as a list incl. `oauth2`
  credentials, collection scripts), environments with `values:`, rows with `disabled:`,
  scalar body `content:`, list `content:` for form bodies, headers as a map or list,
  names from `*.request.yaml` / `*.environment.yaml` filenames. Unknown top-level keys
  are preserved on save. Everything is written back in Yamlet's native shape.
- **Variable precedence** (highest first): request, runner data row, collection,
  environment, globals. Unknown `{{placeholders}}` are left untouched so missing
  variables stay visible. `{{$name}}` falls back to dynamic variables (user variables
  win; each occurrence is fresh).
- **Requests are built once, in the engine.** `requestBuilder.ts` turns a request and
  its scopes into a `BuiltRequest`. The executor sends it; the UI's code snippets
  render it. Auth inheritance (`inherit` uses the collection's auth) lives there.
- **Every request sends `User-Agent: Yamlet/<version>`** (the running build's version, set
  at startup with `setYamletVersion`; `dev` in development). Shown as a locked row in the
  Headers tab; not persisted.
- **Scripts** run in `node:vm` with a timeout: collection pre, request pre, send,
  request post, collection post. Request-script errors abort the send;
  collection-script errors are logged and swallowed. `pm.test` results are always
  captured (shown in the Tests tab, counted by the runner and CLI). Variable changes from
  `pm.environment/collectionVariables/globals.set` are persisted by the server after
  the send.
- **OAuth 2.0**: client credentials and password grants are fetched by the server
  (`/api/oauth2/token`). Authorization code + PKCE: the UI opens the provider in a popup,
  the provider redirects to `/api/oauth2/callback` (`YAMLET_PUBLIC_URL` sets the base),
  and the UI polls `/api/oauth2/authorize/status`.
- **Attachments live in the workspace.** Form-data file fields and binary bodies
  reference a path relative to the workspace root; uploads from the browser are copied
  into `<workspace>/files/`.
- **Cookies** are kept per open workspace in memory (`CookieJar`), sent on matching
  requests, and managed from the Cookies modal.
- **UI state lives in the browser.** Open tabs, active tab, chosen environment, request
  history, response layout and recent workspaces are in `localStorage`
  (`web/src/lib/storage.ts`); workspace content is always on disk. Request edits
  auto-save (debounced) to the request's file; Ctrl+S flushes.
- **The server has no login**, so it only answers its owner's browser
  ([server/src/security.ts](server/src/security.ts)): loopback `Host` only (plus
  `YAMLET_ALLOWED_HOSTS`), `Origin` must match `Host`, non-GET requests need the
  `x-yamlet: 1` header, strict CSP, no framing. The folder browser and file paths are
  confined to `YAMLET_BROWSE_ROOT` (`/workspace` in the container). The documented
  `docker run` publishes on `127.0.0.1` only.
- **Container `localhost`.** Inside Docker, `localhost` is the container. The response
  panel suggests `host.docker.internal` / `--network host` when such a request fails.

## On-disk layout

```
<workspace>/collections/<name>/collection.yaml
<workspace>/collections/<name>/<request>.yaml
<workspace>/collections/<name>/<folder>/folder.yaml + <request>.yaml
<workspace>/environments/<name>.yaml
<workspace>/globals/globals.yaml
<workspace>/files/                 # attachments
```

`WorkspaceStore.resolveRoot` treats the picked folder as the root if it contains
`collections/` and `environments/`, else uses its `yamlet/` subfolder.

## UI conventions

- Tokens in `styles.css` `@theme`: `primary` (#0e7a43), `primary-hover`, `primary-soft`
  (12% tint for hovers and badges), `primary-tint`, `ink`, `body`, `grey`, `muted`,
  `line`, `line-soft`, `canvas`, `danger`. Fonts: DM Sans and JetBrains Mono.
- Shared classes: `.btn` + `.btn-primary | .btn-cancel | .btn-delete | .btn-ghost`
  (+ `.btn-sm`), `.input`, `.label`, `.check`, `.kv-table`. Scrollbars are thin and
  green app-wide.
- Method labels are bold uppercase text colored by method (`--color-m-*`), with no box.
  The method menu lists `HTTP_METHODS` (including QUERY, the safe method with a body)
  plus "Custom method…" for any valid token.
  Status pills use soft fills with dark text.
- Sidebar: white panel with the wordmark, a workspace switcher, a segmented control
  (Collections / Environments / History) and a tree whose selected row is solid green
  with white text.
- Status bar (`views/StatusBar.tsx`) under the workbench: Cookies, Interceptor pairing
  state, the response layout toggle (below / right), shortcuts and About with the version.
- Text editing surfaces use `CodeEditor` (CodeMirror 6): JSON/JS/XML/HTML/YAML modes,
  folding, `{{variable}}` coloring (amber when defined, red when not), hover peek with
  in-place "Set" (writes to the active environment), `{{` and `{{$` autocomplete.
  Single-line mode is used for the URL bar and table cells.
- Avoid `?? []` inside zustand selectors (a new array each call loops renders); use a
  module-level empty constant.

## Distribution

- [.github/workflows/ci.yml](.github/workflows/ci.yml): typecheck, test, build, run
  `samples/demo` with the CLI. It never publishes anything.
- [.github/workflows/release.yml](.github/workflows/release.yml): on `v*` tags (the only
  thing that publishes), push the multi-arch `X.Y.Z` / `X.Y` / `X` / `latest` images
  (pre-release tags get only their exact version), publish the CLI to npm as `@piyushdoorwar/yamlet` (needs the `NPM_TOKEN` secret;
  the bare name `yamlet` is refused by npm as too close to `yaml`),
  and create the GitHub release.
- [.github/workflows/static.yml](.github/workflows/static.yml): deploys `site/` to Pages
  on site changes and after each Release run; the releases page is generated by
  [.github/scripts/generate-site-releases.cjs](.github/scripts/generate-site-releases.cjs).
- The GHCR package must be set to **public** once in its package settings.

## Out of scope

Team/cloud sync, mock servers, hosted docs, accounts and collaboration features.
