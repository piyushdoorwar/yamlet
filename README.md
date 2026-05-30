# Yamlet

**Yamlet** is a local-first API client for Git-friendly, YAML-based API collections. Open a
workspace folder, browse collections and requests in a sidebar, edit and send HTTP requests,
and view responses — everything is stored as plain YAML you can commit to version control.

It ships as both a **dark-mode desktop app** (built on **.NET 10** + **Avalonia UI**, runs on
Windows, Linux, and macOS) and a **`yamlet` command-line runner** you can install from NuGet to
execute your collections in CI.

> Everything lives on disk as readable YAML. No account, no cloud, no lock-in.

---

## Features

**Workspaces & storage**
- Create or open a workspace — a folder with `collections/`, `environments/`, and `globals/`.
- Collections, nested folders, and requests are mirrored 1:1 as directories and YAML files.
- Each request is a self-contained file (verb, URL, params, headers, path vars, variables,
  auth, body, scripts, SSL option) and carries its own `order`, so the sidebar arrangement —
  including drag-and-drop reordering — survives reloads and commits cleanly.
- Reads collections exported from other API clients (and their environment exports) for a
  smooth migration; Yamlet always writes its own clean native format.

**Requests**
- Method, URL, query params, headers, path variables, and request-scoped variables.
- Body types: raw, JSON, `x-www-form-urlencoded`, and `multipart/form-data` with **file
  fields** (file picker + `@path` convention).
- Send with the local `HttpClient`; view status, duration, response size, headers, body, and a
  raw request/response snapshot. Per-request send history and generated **cURL** snippets;
  **import** a request by pasting a cURL command.

**Authorization**
- No Auth, Bearer Token, Basic Auth, API Key (header or query), Cookie, and **OAuth 2.0**
  (client-credentials, and authorization-code with PKCE via the system browser).
- Collection-level auth is inherited by requests set to *Inherit*.

**Scripts & variables**
- Pre-request and post-response **JavaScript** per request, plus collection-level scripts that
  run around every request. A compact `pm` API surface (`pm.test`, `pm.expect`,
  `pm.environment.set`, `pm.response.json()`, …) for assertions, request mutation, and chaining.
- `{{variable}}` resolution with precedence (highest first): **request → collection →
  environment → globals**. Unknown placeholders are left intact so missing values are visible.
- **Dynamic variables** (`$guid`, `$timestamp`, `$random*`, …) generated locally — user
  variables always win, each use gets a fresh value, with `$`-triggered autocomplete in editors.
- Inline `{{}}` highlighting with hover-to-peek and click-to-edit in the code/URL editors.

**Workbench**
- Tabbed work area with session restore (open tabs + active tab + selected environment +
  response layout), a single COLLECTIONS / ENVIRONMENTS accordion, collection/folder **runner**
  tabs, and tree rename / move / duplicate / delete.

**CLI** — see [below](#cli-running-collections-in-ci).

**Packaging** — self-contained Linux `.deb`, Windows `.exe` installer, and `.msix`, built by CI.

---

## CLI: running collections in CI

Install the `yamlet` tool from NuGet and run a whole workspace headlessly — it sends every
request in order, runs your `pm.test` assertions, and exits non-zero on failure, so it gates a
CI job directly.

```bash
dotnet tool install --global Yamlet.Cli

yamlet run ./my-workspace --env environments/dev.yml
```

```yaml
# .github/workflows/api-tests.yml
- name: Install Yamlet
  run: dotnet tool install --global Yamlet.Cli
- name: Run API tests
  run: yamlet run . --env environments/dev.yml
```

A run **fails** (exit `1`) on a transport error, a non-2xx/3xx status, or any failed assertion.
Output is a colored, box-drawn results table — resolved URL, status, per-request time, and
tests passed/total — followed by a failures section and a summary with the total run time.

```
┌────────┬────────┬──────────────────────────────────────┬─────────┬────────┬───────┐
│ Result │ Method │ URL                                  │ Status  │   Time │ Tests │
├────────┼────────┼──────────────────────────────────────┼─────────┼────────┼───────┤
│ PASS   │ GET    │ https://api.example.com/health       │ 200 OK  │  42 ms │   1/1 │
│ FAIL   │ GET    │ https://api.example.com/users        │ 200 OK  │  51 ms │   1/2 │
└────────┴────────┴──────────────────────────────────────┴─────────┴────────┴───────┘
```

Options: `--env <file>`, `--globals <file>`, `--bail` (stop at first failure), `--no-color`.
A ready-to-run example workspace lives in [`samples/`](samples/).

---

## On-disk layout

A workspace is a directory (or its `yamlet/` subfolder):

```
yamlet/
  collections/
    my-api/
      collection.yaml        # collection metadata: name, variables, auth, scripts
      get-status.yaml        # a request directly inside the collection (order: 0)
      users/
        folder.yaml          # folder metadata: name + order
        get-users.yaml        # a request inside the "users" folder
        create-user.yaml
  environments/
    local.yaml
    prod.yaml
  globals/
    globals.yaml
```

`collection.yaml` holds only collection-level metadata — requests are **not** embedded; each
request is its own file and is the single source of truth.

### Request file example

```yaml
id: "request-guid"
name: "Get Users"
order: 0
method: "GET"
url: "{{baseUrl}}/users"
queryParams:
  - key: "page"
    value: "1"
    description: "Page number"
    enabled: true
headers:
  - key: "Accept"
    value: "application/json"
    enabled: true
auth:
  type: "bearer"
  token: "{{token}}"
body:
  type: "none"
scripts:
  - type: afterResponse
    code: |
      pm.test('status is 200', () => pm.expect(pm.response.code).to.equal(200));
```

### Environment file example

```yaml
id: "environment-guid"
name: "Local"
variables:
  - key: "baseUrl"
    value: "http://localhost:5000"
    enabled: true
```

---

## Project structure

```
Yamlet/
  src/
    Yamlet.Core/        # UI-free library: domain models + all logic/IO services
      Models/           # workspace, collection, folder, request, auth, …
      Services/         # YAML IO, request executor, scripts, variables, OAuth2,
                        #   CollectionRunner (the headless run engine), …
    Yamlet.App/         # Avalonia desktop app (references Yamlet.Core)
      ViewModels/ Views/ Controls/ Themes/ Stores/
    Yamlet.Tests/       # xUnit unit tests
  cli/
    Yamlet.Cli/         # the `yamlet` dotnet tool (references Yamlet.Core)
  samples/              # a ready-to-run example workspace
  packaging/  scripts/  # installer assets and build scripts
```

The desktop app and the CLI share `Yamlet.Core`, so what runs in CI is exactly what you see in
the UI. The on-disk YAML format is mapped to/from internal domain models by a dedicated
serialization layer, so the UI never binds directly to the file format.

---

## Running locally

Requires the **.NET 10 SDK**.

```bash
# desktop app
dotnet run --project src/Yamlet.App

# CLI against the bundled sample workspace
dotnet run --project cli/Yamlet.Cli -- run samples/demo --env samples/demo/environments/dev.yaml

# tests
dotnet test src/Yamlet.Tests
```

---

## Status

Yamlet is well past its initial MVP: the desktop client and a publishable CI runner share a
single core, requests round-trip through a clean native YAML format with persisted ordering,
and OAuth2, scripting, runners, dynamic variables, and imported-format compatibility are all in
place.

Still intentionally out of product scope: team/cloud sync, mock servers, hosted API docs, and
collaboration features.

---

## Tech stack

- .NET 10 / C#
- Avalonia UI (Fluent dark theme) + AvaloniaEdit
- CommunityToolkit.Mvvm
- YamlDotNet
- Jint (JavaScript engine for request scripts)
- `System.Net.Http.HttpClient`
- xUnit for tests
