# Yamlet

**Yamlet** is a local-first desktop API client for Git-friendly, YAML-based API
collections. It lets you open a workspace folder, browse collections and requests in a
sidebar, edit and send HTTP requests, and view responses — all stored as plain YAML
files you can commit to version control.

Yamlet is dark-mode only and built with **.NET 10** and **Avalonia UI**, so it runs on
Windows, Linux, and macOS.

> Everything lives on disk as readable YAML. No account, no cloud, no lock-in.

---

## Features (MVP)

- **Workspaces** — create a new Yamlet workspace or open an existing one. Yamlet
  manages a `yamlet/` folder containing `collections/`, `environments/`, and
  `globals/`.
- **Collections, folders, and requests** — organize requests into collections and
  nested folders, all mirrored as directories and files on disk.
- **Request editing** — method, URL, query params, headers, raw/JSON body,
  authorization, and request-scoped variables.
- **Authorization** — No Auth, Bearer Token, Basic Auth, and API Key (header or query).
- **Send requests** — execute requests with the local `HttpClient` and view the
  status code, duration, response size, headers, body, and raw output.
- **Variable resolution** — `{{variableName}}` placeholders are resolved with the
  following precedence (highest first):
  1. Request variables
  2. Collection variables
  3. Selected environment variables
  4. Globals
- **YAML persistence** — collections and requests are saved as a clean,
  diff-friendly folder/file structure.

---

## On-disk layout

A workspace is a `yamlet/` directory:

```
yamlet/
  collections/
    my-api/
      collection.yaml      # collection metadata + variables
      users/
        get-users.yaml     # a request inside the "users" folder
        create-user.yaml
      get-status.yaml      # a request directly inside the collection
  environments/
    local.yaml
    prod.yaml
  globals/
    globals.yaml
```

### Request file example

```yaml
id: "request-guid"
name: "Get Users"
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
  type: "none"
body:
  type: "none"
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
    Yamlet.App/         # Avalonia desktop application
      Models/           # Domain models (workspace, collection, request, …)
      Services/         # Workspace/collection/request IO, YAML, executor, variables
      Stores/           # Local persistence (recent workspaces)
      ViewModels/       # MVVM view models
      Views/            # Avalonia views (XAML)
      Controls/         # Reusable controls and value converters
      Themes/           # Dark theme colors and styles
    Yamlet.Tests/       # xUnit unit tests
  README.md
```

The on-disk YAML format is mapped to/from internal domain models by a dedicated
serialization layer, so the UI never binds directly to the file format.

---

## Running locally

Requires the **.NET 10 SDK**.

```bash
# from the repository root
dotnet restore
dotnet run --project src/Yamlet.App
```

### Running the tests

```bash
dotnet test src/Yamlet.Tests
```

---

## Current limitations

The MVP intentionally leaves the following out of scope:

- Script and test execution (pre-request / post-response)
- Collection runner
- OAuth flows and cookie management
- Multipart / file-upload bodies (only raw and JSON bodies are sent)
- `form-data` and `x-www-form-urlencoded` bodies are selectable and persisted but not
  yet sent
- Generated code snippets
- Request history (the History rail section is a placeholder)
- Renaming/moving/deleting tree items from the UI
- Editing environments and globals from the UI (they are loaded and used at send time)
- Team, cloud, or remote sync; mock servers; API documentation generation

---

## Roadmap

- Edit environments and globals in-app
- Rename, move, and delete collections, folders, and requests
- Request history with replay
- Full body support (`form-data`, `x-www-form-urlencoded`, file uploads)
- Authorization inheritance from folders and collections
- Pre-request and post-response scripting
- A collection runner

---

## Tech stack

- .NET 10 / C#
- Avalonia UI (Fluent dark theme)
- CommunityToolkit.Mvvm
- YamlDotNet
- `System.Net.Http.HttpClient`
- xUnit for tests
