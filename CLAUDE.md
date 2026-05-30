# CLAUDE.md

Guidance for working in the Yamlet codebase.

## What Yamlet is

Yamlet is a local-first, **dark-mode-only** desktop API client for Git-friendly,
YAML-based API collections. Open a workspace folder, browse collections/requests in a
sidebar, edit and send HTTP requests, and view responses — everything persists as plain
YAML on disk.

## Hard rules

- **Never name external API clients** anywhere in source, UI text, comments, namespaces,
  file/class names, or docs. Use Yamlet terminology. (Real user data may live in
  folders named after other clients — that's their data, not ours; don't rename it, but
  don't echo those names in our code/strings.)
- **No emojis anywhere.** All iconography is vector SVG. UI icons are `PathIcon` backed
  by `StreamGeometry` in [Themes/Icons.axaml](src/Yamlet.App/Themes/Icons.axaml); the
  brand mark is the multi-path [Controls/YamletLogo.axaml](src/Yamlet.App/Controls/YamletLogo.axaml).
  Add a new geometry rather than a glyph.
- **Tests live under `src/`** (`src/Yamlet.Tests`), not a top-level `tests/`. The
  solution file is `Yamlet.slnx` (the .NET 10 XML solution format).

## Commands

```bash
dotnet build                              # build solution (Yamlet.slnx)
dotnet run --project src/Yamlet.App       # launch the app
dotnet test src/Yamlet.Tests              # run unit tests

VERSION=1.2.3 ./scripts/build-linux.sh    # build the Linux .deb (Linux host)
pwsh ./scripts/build-windows.ps1          # build the Windows .exe + .msix (Windows host)
```

## Tech stack

- .NET 10 / C# (`ImplicitUsings` + `Nullable` enabled)
- Avalonia UI 12.0.3 (Fluent theme, dark variant) with `Avalonia.Fonts.Inter`
- AvaloniaEdit 12 via `AvaloniaEdit.TextMate` for code-editor surfaces
- CommunityToolkit.Mvvm 8.4 (source-generated `ObservableProperty` / `RelayCommand`)
- YamlDotNet 18 for YAML
- `System.Net.Http.HttpClient` for execution
- xUnit for tests
- No `Avalonia.Diagnostics` — it isn't published for Avalonia 12.x.

## Solution structure

```
src/
  Yamlet.App/
    Models/        Plain domain POCOs (YamletWorkspace, Collection, Folder, Request,
                   Header, QueryParam, RequestBody, Auth, Environment, Variable, Response)
    Services/      Disk + logic: WorkspaceService, CollectionService, RequestFileService,
                   YamlSerializationService, YamlDtos (on-disk shapes + mapping),
                   VariableResolver, RequestExecutor, RequestScriptRunner/Variables,
                   OAuth2TokenService, OAuth2BrowserFlow, DialogService, PathNaming
    Stores/        RecentWorkspaceService (JSON app cache: recent workspaces, per-workspace
                   selected environment + open-tab session + response-layout preference)
    ViewModels/    MVVM: MainWindowViewModel, RequestEditorViewModel, CollectionSettingsViewModel,
                   VariableSetEditorViewModel, RunnerViewModel, OpenTabViewModel,
                   tree node VMs, EditableRowsViewModel
    Views/         Avalonia XAML: MainWindow, RequestEditorView, CollectionSettingsView,
                   VariableSetEditorView, InputDialog, AboutDialog
    Controls/      CodeEditorView (+ IVariableSource, JsonFoldingStrategy), KeyValueGridView,
                   YamletLogo, value converters
    Themes/        Colors.axaml, Icons.axaml, Yamlet.axaml (styles)
  Yamlet.Tests/    xUnit tests
packaging/         .deb assets + windows/ (Inno Setup .iss, AppxManifest, tiles, .ico)
scripts/           build-linux.sh (.deb), build-windows.ps1 (.exe + .msix)
```

## Key architectural decisions

- **Domain models are decoupled from the file format.** The UI binds to view models that
  wrap domain models (`Yamlet.App.Models`); on-disk YAML is described by separate DTOs in
  [YamlDtos.cs](src/Yamlet.App/Services/YamlDtos.cs) with explicit `ToDomain` / `FromDomain`
  mapping. Never bind UI or serialize domain models directly.
- **No DI container.** The object graph is wired by hand in
  [App.axaml.cs](src/Yamlet.App/App.axaml.cs) `ComposeRoot()`. `DialogService` is attached
  to the window afterward (it needs a `Window` for pickers/dialogs).
- **Tabbed work area.** `MainWindowViewModel` owns `OpenTabs` (an
  `ObservableCollection<OpenTabViewModel>`) with a `SelectedTab`; each tab wraps a content
  VM — `RequestEditorViewModel`, `CollectionSettingsViewModel`, `VariableSetEditorViewModel`,
  or the collection `RunnerViewModel`. Selecting a request/collection/environment opens
  (or re-activates) its tab; tabs dedupe by a stable key and can be closed. The active
  tab's `Content` fills a `ContentControl` with implicit `DataTemplate`s mapping VM type →
  view. `CurrentEditor` mirrors the active tab when it's a request editor (e.g. the
  status-bar stacked/side-by-side response layout toggle binds to it).
- **Sidebar is a single accordion** (COLLECTIONS + ENVIRONMENTS), not an icon rail.
  Globals/History/Settings were intentionally removed from the UI. Selecting an
  environment both opens its editor and makes it the active one for variable resolution.
  The workspace header carries an **info button** (`IconInfo`) that opens
  [AboutDialog](src/Yamlet.App/Views/AboutDialog.axaml) — a modal showing the app version
  (`AssemblyInformationalVersion`), OS/architecture/.NET, and GitHub/Releases links
  (opened via `Process.Start(UseShellExecute)`).
- **App cache is user-local JSON, not workspace YAML.** `RecentWorkspaceService` stores,
  under the user's app-data directory: recent workspace paths, and per workspace — the
  selected environment, the open tabs + active tab (a `WorkspaceSession`), and the
  stacked-vs-side-by-side response layout preference. Open tabs and the selected
  environment are keyed by **stable disk paths** (request/collection source files,
  environment file/name) so the session restores across restarts; missing targets are
  skipped, with a first-environment fallback.
- **Variable precedence** (highest first): request → collection → environment → globals.
  Implemented in [VariableResolver.cs](src/Yamlet.App/Services/VariableResolver.cs) via
  `VariableContext`. Unknown `{{placeholders}}` are left untouched (so missing variables
  are visible, not silently blanked).
- **Dynamic variables** (Postman-style `$guid`, `$timestamp`, `$random*`, …) are our own
  implementation in [DynamicVariables.cs](src/Yamlet.App/Services/DynamicVariables.cs) — no
  faker dependency. `VariableResolver` falls back to `DynamicVariables.TryGenerate` when a
  `{{$name}}` placeholder isn't a user variable, so **user variables always win** and each
  occurrence generates a **fresh** value (matching Postman). Scripts get
  `pm.variables.replaceIn('{{$randomFirstName}}')` (and `pm.replaceIn`) wired in
  [RequestScriptRunner.cs](src/Yamlet.App/Services/RequestScriptRunner.cs). In
  `CodeEditorView`, typing `$` pops an autocomplete list of the full catalog; dynamic
  placeholders highlight as defined (amber) and hover-peek shows their description +
  example instead of the editable inspector (they aren't settable).
- **Every sent request includes Yamlet's default user agent.** `RequestExecutor` always
  sends `User-Agent: Yamlet/1.0.0`; the request Headers tab shows it as a locked row,
  and saved request YAML does not persist or allow overriding that generated header.
- **Code editor surfaces use `CodeEditorView`** — an AvaloniaEdit `TextEditor` (not a
  plain TextBox) with line numbers, JSON beautify, and **JSON code folding**. It renders
  API-client-style `{{variable}}` highlighting (amber when the placeholder resolves in the
  active scopes, red when undefined) with **hover-to-peek** the value and **click-to-edit**
  (writes to the active environment), via the `IVariableSource` the request editor
  implements. The URL box gets the same hover peek. Keep new JSON/script text areas on
  this shared control. The response panel is condensed: a Body/Headers/Raw dropdown on one
  summary line.
- **Collection auth incl. OAuth 2.0.** A collection's auth applies to requests whose auth
  is `Inherit`. `YamletAuth.OAuth2` supports **client-credentials** (token fetched + cached
  from the token endpoint by [OAuth2TokenService](src/Yamlet.App/Services/OAuth2TokenService.cs),
  attached as a Bearer header or `access_token` query per `addTokenTo`) and
  **authorization-code with PKCE** (interactive via
  [OAuth2BrowserFlow](src/Yamlet.App/Services/OAuth2BrowserFlow.cs): system browser + a
  loopback `HttpListener` redirect). Credential fields resolve `{{variables}}` at send
  time; the "Get New Access Token" button in collection settings drives acquisition. Token
  HTTP uses the executor's injected `HttpClient`, so it's testable.
- **Collection-level scripts** (`YamletCollection.PreRequestScript` / `PostResponseScript`)
  run around every request via `RequestScriptRunner` — collection pre before the request's
  pre, collection post after. Collection-script errors are swallowed (a failing test
  assertion must not fail the send); request-script errors still abort the send.
- **RequestExecutor takes an injected `HttpClient`** so tests use a fake handler.
- **Each request file is the single source of truth; collection.yaml is metadata only.**
  A request lives entirely in its own `<request>.yaml` (`RequestDto`, written by
  `RequestFileService`) — verb, url, params, headers, path vars, variables, auth (incl.
  cookie), body, scripts, ssl, **and its `order`**. `collection.yaml` is written by
  `CollectionService.SaveCollectionAsync` as a lean Yamlet-native `CollectionDto` (id, name,
  variables, auth, scripts, `order`) — it does **not** embed requests. Each folder carries a
  small `folder.yaml` (`FolderDto`: name + `order`). This is our own format, not Postman, so
  `RequestEditorViewModel`'s auto-save only writes the request file (no collection rebuild).
- **Tree order is persisted per file.** `YamletRequest.Order` / `YamletFolder.Order` /
  `YamletCollection.Order` survive reloads: the loader sorts each container's requests by
  request `order` and its folders by `folder.yaml` `order` (ties fall back to filename, a
  stable sort, so pre-`order` files load unchanged). After any structural change (create,
  move, duplicate, reorder), the VM calls `CollectionService.SaveContainerOrderAsync(collection,
  folder)`, which renumbers that container's direct children and rewrites the affected request
  files / `folder.yaml`s. Deletes intentionally leave gaps (harmless — the next op renumbers).
- **Backward compat: old formats still read, never written.** `YamlDtos.cs` retains the
  Postman reader DTOs (`PostmanInfoDto`, `PostmanVariableDto`, `PostmanEventDto`, `PostmanAuthDto`,
  `PostmanScriptDto`) so `CollectionMetadataDto` loads existing Postman v2.1 `collection.yaml`
  and imported `.resources/definition.yaml`; `PostmanAuthDto` reads both the Postman list
  format (`bearer: [{key: token, value: …}]`) and the flat Yamlet fields. The Postman *writer*
  DTOs (`PostmanCollectionFileDto`, `PostmanItemDto`, `PostmanRequestDto`, `PostmanUrlDto`,
  `PostmanBodyDto`, …) were removed. Existing/imported workspaces migrate to the native shape
  on the next save. (Environments are still written in Postman format — see below.)
- **Form-data body fields support file attachments.** `KeyValueRowViewModel` carries
  `FormDataValueType` / `IsFile` to toggle between text and file mode. `IDialogService`
  exposes `PickFileAsync`; the result is stored with a `@` prefix in the value (matching
  cURL `--form` convention). `RequestEditorViewModel` accepts `IDialogService` and
  exposes `SelectBodyFileCommand` for the file-picker button in the form-data template.
- **URL highlight overlay.** The URL `TextBox` has `Foreground="Transparent"` so an
  overlaid `TextBlock` (`UrlHighlightText`) renders all visible text. Plain text `Run`
  objects are added without an explicit `Foreground` so they inherit the TextBlock's
  `Foreground="{DynamicResource TextPrimaryBrush}"` at render time; variable spans get
  explicit amber/red brushes. Never set an explicit foreground on plain-text runs —
  it bypasses the dynamic resource and breaks light-mode-style changes.
- **App version in About dialog.** `AboutDialog` reads `AssemblyInformationalVersionAttribute`
  (stripping the `+githash` suffix). The csproj sets `<Version>0.0.0-dev</Version>` as the
  local-dev default; CI passes `-p:Version=$VERSION -p:InformationalVersion=$VERSION` to
  `dotnet publish`, overriding it with the real release version.

## On-disk layout

A workspace is a directory (or its `yamlet/` subfolder) containing:

```
collections/<name>/collection.yaml + <request>.yaml + <folder>/folder.yaml + <folder>/<request>.yaml
environments/<name>.yaml
globals/globals.yaml
```

`WorkspaceService.ResolveRoot` treats the picked folder as the root if it already
contains `collections/`+`environments/`, else uses a `yamlet/` subfolder.

**`collection.yaml` is written as a lean Yamlet-native `CollectionDto`** (id, name,
variables, auth, scripts, `order`) — requests are **not** embedded; each request is its own
`<request>.yaml` and each folder has a `folder.yaml` (name + `order`). On load,
`CollectionMetadataDto` accepts this native shape **and** the legacy Postman v2.1 shape
(and imported `.resources/definition.yaml`) for backward compatibility — old files migrate
to the native shape on next save. **Environments are still written as `PostmanEnvironmentDto`**
(Postman environment format with `_postman_variable_scope: environment` and `values:` list).

## Packaging / distribution

Three installable artifacts, all built by CI in
[.github/workflows/build-artifacts.yml](.github/workflows/build-artifacts.yml) on push
to `main`, manual dispatch, and `v*` tags (tags also attach the files to a GitHub
release). Every build is **self-contained** (`dotnet publish --self-contained`), so the
target machine needs no separate .NET runtime.

- **Linux `.deb`** — [scripts/build-linux.sh](scripts/build-linux.sh): publishes
  `linux-x64`, assembles it under `/opt/yamlet` with a `/usr/bin/yamlet` launcher, a
  `.desktop` entry and icon, then packages with `dpkg-deb`. Output:
  `yamlet_<version>_amd64.deb`.
- **Windows installer `.exe`** — [scripts/build-windows.ps1](scripts/build-windows.ps1)
  publishes `win-x64` and compiles an installer with Inno Setup
  ([packaging/windows/yamlet.iss](packaging/windows/yamlet.iss); ISCC is preinstalled on
  the `windows-latest` runner). Output: `yamlet_<version>_win-x64_setup.exe`.
- **Windows `.msix`** — the same script's `New-MsixPackage` stages
  [packaging/windows/AppxManifest.xml](packaging/windows/AppxManifest.xml) plus the tile
  PNGs in `packaging/windows/Assets/` into the publish output and runs `MakeAppx pack`
  (from the Windows SDK). Output: `yamlet_<version>_win-x64.msix`.

Conventions / gotchas:

- **Version** flows via the `VERSION` env var (Linux) / `-p:Version -p:InformationalVersion`
  (Windows) and is derived by the workflow from the tag (`v1.2.3` → `1.2.3`), the dispatch
  input, or `0.0.0-dev`. The csproj sets `<Version>0.0.0-dev</Version>` as the local-dev
  default so `dotnet run` shows a meaningful value instead of the SDK default `1.0.0`.
  MSIX requires a numeric `X.X.X.X` identity version, so any pre-release suffix is
  stripped (`1.2.3-beta` → `1.2.3.0`).
- The **`.msix` is produced unsigned** (`MakeAppx pack` only). Sign it before
  distributing outside the Store; `AppxManifest.xml`'s `Publisher` (`CN=…`) must match
  the signing certificate's subject.
- **Brand artwork is generated, not hand-drawn**, from the YamletLogo green "Y" mark:
  [packaging/windows/yamlet.ico](packaging/windows/yamlet.ico) (the `.exe` icon, wired
  via `<ApplicationIcon>` in the csproj — ignored on non-Windows publishes) and the
  `packaging/windows/Assets/*.png` MSIX tiles. Regenerate them if the mark changes.
- Build output lands under `artifacts/` (gitignored).

### Marketing site (GitHub Pages)

A static site lives in [site/](site/) (home / releases / privacy pages, warm-dark + green
theme matching the app; green buttons keep **white** text). It's deployed by
[.github/workflows/static.yml](.github/workflows/static.yml) and the releases page is
generated from GitHub releases by
[.github/scripts/generate-site-releases.js](.github/scripts/generate-site-releases.js)
into `releases.json`.

## Imported-format compatibility (important)

Real workspaces are often exported from another tool and differ from Yamlet's native
shape. The reader accepts both — see
[imported-yaml-format-compat]: environments `values:`≈`variables:`, rows `disabled:`
(inverse of `enabled:`, via `KeyValueDto.IsEnabled`), scalar body `content:`≈`raw:`,
list-valued `content:` for `form-data`/`x-www-form-urlencoded` maps to Yamlet form fields,
headers as a map *or* list
(`RequestDto.Headers` is `object?`, normalized by `ParseHeaders`), names derived from
`*.request.yaml` / `*.environment.yaml` filenames, and unknown top-level keys preserved
when saving.

A collection's metadata may live in a native `collection.yaml` (now written as a lean
Yamlet-native `CollectionDto` — see above) **or** an exported `.resources/definition.yaml`
(`CollectionDefinitionDto`): collection `variables` as a name→value **map**, `auth` as a
**list** of schemes (incl. `oauth2` with a `credentials:` block → `OAuth2CredentialsDto`),
and collection-scope `scripts`. When both files exist the definition is applied first and
`collection.yaml` overrides only what it specifies (merge-friendly `ApplyTo`), so a
collection with only `.resources/` still loads its name, variables, OAuth2 auth and scripts.
On load, the shared `CollectionMetadataDto` accepts the native Yamlet flat fields AND the
legacy Postman `info`/`variable`/`event` fields, so existing/imported workspaces round-trip
without migration.

Pre-request / post-response **scripts** are modeled (`YamletRequest.PreRequestScript` /
`PostResponseScript`), shown in the editor's **Scripts** tab, preserved on save
(written back under `scripts:` as `preRequest` / `afterResponse`), and executed during
request sends. Script execution is per request and uses a short-lived JavaScript runtime
with a compact `pm` surface for variables, request mutation, tests, and response access.
`pm.environment.set`, `pm.collectionVariables.set`, and `pm.globals.set` mutate the live
selected environment / collection / globals and persist those scopes after the send.

> **Save behavior:** saving writes Yamlet's canonical format for modeled fields, while
> preserving unknown top-level YAML keys from the original file (for example `$kind` or
> `tests`). Unknown nested keys inside modeled blocks may still be normalized away.

## Theme conventions

The look follows **Claude's aesthetic**: warm dark (slightly brown-tinted) grey
surfaces, warm off-white text, soft rounded corners (~8–10px), comfortable spacing,
Inter font. **One deliberate swap: the accent is GREEN, not Claude's clay-orange.**

- Dark only; `RequestedThemeVariant` is forced to Dark in
  [App.axaml.cs](src/Yamlet.App/App.axaml.cs).
- Colors/brushes live in [Themes/Colors.axaml](src/Yamlet.App/Themes/Colors.axaml)
  (warm surfaces, text tiers, green `AccentBrush` + `AccentSoftBrush`, per-method and
  per-status colors).
- **Method (GET/POST/DEL/…) and status (2xx/3xx/…) colors are the standard mapping but
  in PASTEL / low-saturation tones** (soft green/yellow/blue/purple/red — never bright).
  The source of truth is the two converters in [Controls/](src/Yamlet.App/Controls/)
  (`MethodToBrushConverter`, `StatusCategoryToBrushConverter`); keep the `Color` entries
  in Colors.axaml in sync. HTTP method labels are plain uppercase bold text colored by
  method, without a box. Status labels keep pastel fills with dark text.
- Shared control styles (compact inputs, buttons, `.accent`/`.ghost`/`.section`/`.title`
  classes, badges, rail icon coloring) live in
  [Themes/Yamlet.axaml](src/Yamlet.App/Themes/Yamlet.axaml). **Scrollbars are thin
  (~9px) with green (`AccentBrush`) thumbs app-wide** — styled there, not per-view. The
  collections tree disables horizontal scrolling and trims long names with an ellipsis
  (no horizontal scrollbar); tree rows show a soft-green (`AccentSoftBrush`) hover and a
  solid-green selected state.
- **The Send action is an SVG paper-plane** (`IconSend`), rendered as a *stroked* `Path`
  (white stroke), not a filled `PathIcon` — its geometry is outline-based.
- **In `Styles` files, reference theme brushes with `DynamicResource`, not
  `StaticResource`** — a `Styles` file can't resolve `StaticResource` against
  `Application.Resources` at build time (it throws at startup). `StaticResource` is fine
  inside Views (controls resolve up the logical tree).
- HTTP method and response-status colors are applied via the converters in
  [Controls/](src/Yamlet.App/Controls/) (`MethodToBrushConverter`,
  `StatusCategoryToBrushConverter`); the VM exposes a status *category* string so it
  stays UI-free.

## Implemented scope

Implemented: workspace create/open, collection/folder/request create, collection auth
including **OAuth 2.0** (client-credentials + authorization-code/PKCE), edit
method/URL/params/headers/body/auth, raw/JSON/form-data/x-www-form-urlencoded sending,
multipart text and **file** fields (file picker, `@path` curl convention),
request **and** collection-level scripts, save & load YAML in **Yamlet's native format**
(self-contained per-request files with persisted `order`; metadata-only `collection.yaml`;
per-folder `folder.yaml`) while still **reading** legacy Postman v2.1 and exported
`.resources/definition.yaml` collections (environments are still written in Postman format),
top-level unknown YAML key preservation, send via HttpClient, condensed response
(status/duration/size + Body/Headers/Raw dropdown), generated cURL snippets, per-request
send history, variable resolution with inline `{{}}` highlighting / hover-peek / click-edit,
Postman-style dynamic variables (`$guid`/`$timestamp`/`$random*`) with `$`-triggered
autocomplete, JSON code folding, environment editing, multiple **tabs** with session restore
(open tabs + active tab + environment + response layout), collection/folder **runner** tabs,
tree rename/move/duplicate/delete actions, and `.deb`/`.exe`/`.msix` packaging.

Still intentionally out of product scope: team/cloud sync, mock servers, hosted API docs,
and collaboration features.
