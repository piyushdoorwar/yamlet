# CLAUDE.md

Guidance for working in the Yamlet codebase.

## What Yamlet is

Yamlet is a local-first, **dark-mode-only** desktop API client for Git-friendly,
YAML-based API collections. Open a workspace folder, browse collections/requests in a
sidebar, edit and send HTTP requests, and view responses — everything persists as plain
YAML on disk.

## Hard rules

- **Never use the word "Postman"** anywhere in source, UI text, comments, namespaces,
  file/class names, or docs. Use Yamlet terminology. (Real user data may live in a
  folder literally named `postman/` — that's their data, not ours; don't rename it, but
  don't echo the word in our code/strings.)
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
```

## Tech stack

- .NET 10 / C# (`ImplicitUsings` + `Nullable` enabled)
- Avalonia UI 12.0.3 (Fluent theme, dark variant) with `Avalonia.Fonts.Inter`
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
                   VariableResolver, RequestExecutor, DialogService, PathNaming
    Stores/        RecentWorkspaceService (JSON in app-data)
    ViewModels/    MVVM: MainWindowViewModel, RequestEditorViewModel,
                   VariableSetEditorViewModel, tree node VMs, EditableRowsViewModel
    Views/         Avalonia XAML: MainWindow, RequestEditorView, VariableSetEditorView,
                   InputDialog
    Controls/      KeyValueGridView, YamletLogo, value converters
    Themes/        Colors.axaml, Icons.axaml, Yamlet.axaml (styles)
  Yamlet.Tests/    xUnit tests
```

## Key architectural decisions

- **Domain models are decoupled from the file format.** The UI binds to view models that
  wrap domain models (`Yamlet.App.Models`); on-disk YAML is described by separate DTOs in
  [YamlDtos.cs](src/Yamlet.App/Services/YamlDtos.cs) with explicit `ToDomain` / `FromDomain`
  mapping. Never bind UI or serialize domain models directly.
- **No DI container.** The object graph is wired by hand in
  [App.axaml.cs](src/Yamlet.App/App.axaml.cs) `ComposeRoot()`. `DialogService` is attached
  to the window afterward (it needs a `Window` for pickers/dialogs).
- **MainContent switching.** `MainWindowViewModel.MainContent` holds either a
  `RequestEditorViewModel` (request selected) or a `VariableSetEditorViewModel`
  (environment opened). The main panel is a `ContentControl` with implicit
  `DataTemplate`s mapping VM type → view.
- **Sidebar is a single accordion** (COLLECTIONS + ENVIRONMENTS), not an icon rail.
  Globals/History/Settings were intentionally removed from the UI. Selecting an
  environment both opens its editor and makes it the active one for variable resolution.
- **Variable precedence** (highest first): request → collection → environment → globals.
  Implemented in [VariableResolver.cs](src/Yamlet.App/Services/VariableResolver.cs) via
  `VariableContext`. Unknown `{{placeholders}}` are left untouched (so missing variables
  are visible, not silently blanked).
- **RequestExecutor takes an injected `HttpClient`** so tests use a fake handler.

## On-disk layout

A workspace is a directory (or its `yamlet/` subfolder) containing:

```
collections/<name>/collection.yaml + <request>.yaml + <folder>/<request>.yaml
environments/<name>.yaml
globals/globals.yaml
```

`WorkspaceService.ResolveRoot` treats the picked folder as the root if it already
contains `collections/`+`environments/`, else uses a `yamlet/` subfolder.

## Imported-format compatibility (important)

Real workspaces are often exported from another tool and differ from Yamlet's native
shape. The reader accepts both — see
[imported-yaml-format-compat]: environments `values:`≈`variables:`, rows `disabled:`
(inverse of `enabled:`, via `KeyValueDto.IsEnabled`), bodies `content:`≈`raw:`, headers
as a map *or* list (`RequestDto.Headers` is `object?`, normalized by `ParseHeaders`),
names derived from `*.request.yaml` / `*.environment.yaml` filenames, and `$kind` /
`scripts` / `tests` / dot-directories ignored.

Pre-request / post-response **scripts** are modeled (`YamletRequest.PreRequestScript` /
`PostResponseScript`), shown in the editor's **Scripts** tab, and preserved on save
(written back under `scripts:` as `preRequest` / `afterResponse`). They are NOT executed.

> **Save caveat:** saving writes Yamlet's canonical format. `description`, `scripts`,
> params/headers/url/body/auth are preserved; still-unmodeled keys (`tests`, `$kind`,
> and any other tool-specific fields) are DROPPED.

## Theme conventions

The look follows **Claude's aesthetic**: warm dark (slightly brown-tinted) grey
surfaces, warm off-white text, soft rounded corners (~8–10px), comfortable spacing,
Inter font. **One deliberate swap: the accent is GREEN, not Claude's clay-orange.**

- Dark only; `RequestedThemeVariant` is forced to Dark in
  [App.axaml.cs](src/Yamlet.App/App.axaml.cs).
- Colors/brushes live in [Themes/Colors.axaml](src/Yamlet.App/Themes/Colors.axaml)
  (warm surfaces, text tiers, green `AccentBrush` + `AccentSoftBrush`, per-method and
  per-status colors).
- **Method (GET/POST/…) and status (2xx/3xx/…) colors are the standard mapping but in
  PASTEL / low-saturation tones** (soft green/yellow/blue/purple/red — never bright).
  The source of truth is the two converters in [Controls/](src/Yamlet.App/Controls/)
  (`MethodToBrushConverter`, `StatusCategoryToBrushConverter`); keep the `Color` entries
  in Colors.axaml in sync. Badges pair pastel fills with dark text.
- Shared control styles (compact inputs, buttons, `.accent`/`.ghost`/`.section`/`.title`
  classes, badges, rail icon coloring) live in
  [Themes/Yamlet.axaml](src/Yamlet.App/Themes/Yamlet.axaml).
- **In `Styles` files, reference theme brushes with `DynamicResource`, not
  `StaticResource`** — a `Styles` file can't resolve `StaticResource` against
  `Application.Resources` at build time (it throws at startup). `StaticResource` is fine
  inside Views (controls resolve up the logical tree).
- HTTP method and response-status colors are applied via the converters in
  [Controls/](src/Yamlet.App/Controls/) (`MethodToBrushConverter`,
  `StatusCategoryToBrushConverter`); the VM exposes a status *category* string so it
  stays UI-free.

## MVP scope / not implemented

Implemented: workspace create/open, collection/folder/request create, edit
method/URL/params/headers/raw+JSON body/auth, save & load YAML, send via HttpClient,
response (status/duration/size/headers/body/raw), variable resolution, environment
editing.

Out of scope (for now): scripts/tests execution, collection runner, OAuth, cookies,
multipart/file upload, `form-data`/`x-www-form-urlencoded` sending (selectable but not
sent), code snippets, request history, rename/move/delete from the tree, globals UI,
unknown-field-preserving save.
