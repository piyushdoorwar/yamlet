# Yamlet

**A local-first API client for Git-friendly YAML collections, running in your browser.**

Yamlet keeps every request, folder, environment and global as a small, readable YAML
file on your disk. Open a folder, send requests, write tests, run collections, and
commit the whole thing to Git next to your code. There's no account, no cloud sync and
no telemetry. The app runs from a container on your machine, and your files stay where
they are.

Website: <https://yamlet.piyushdoorwar.com/>

## Run it

```bash
docker run -d --pull always --name yamlet -p 127.0.0.1:7878:7878 -v .:/workspace -v yamlet-data:/data ghcr.io/piyushdoorwar/yamlet
```

Then open <http://localhost:7878>. The folder you mount at `/workspace` is your
workspace. If it isn't one yet, Yamlet offers to set it up (it creates `collections/`,
`environments/` and `globals/`).

The `yamlet-data` volume holds private app state outside your workspace: variable values
you keep local (see below) and the Chrome extension pairing. Keep the same
`-v yamlet-data:/data` whenever you recreate the container (for example after an update);
without it each new container starts with an empty `/data`, local values are gone and the
extension has to pair again.

**Install as an app.** With the container running, open Yamlet at
<http://localhost:7878> and use your browser's **Install app** option (or **Add to Home
Screen** on mobile). The installed app uses the Yamlet logo and opens in its own window.
Keep the container running to use your workspaces and send requests. If you access
Yamlet from another device, serve it over HTTPS for browser installation.

**Chrome cookie sync.** The optional Yamlet Interceptor extension syncs cookies from sites you approve into Yamlet. It works with the published image started as above. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/yamlet-interceptor/ojnilooocnngdafipgchmlnaldpejaei) (to try local changes, load the `extension/` folder with **Load unpacked** in `chrome://extensions` instead). Open **Cookies** from Yamlet's status bar, choose **Pair extension**, and confirm in the window the extension opens (or choose **Use a code instead** and paste it into the extension popup). Open a site, choose **Allow and sync this site**, and inspect the cookies in Yamlet. Approved sites refresh while Chrome is running. The `/data` volume keeps pairing across container recreation; if it is lost, the extension pairs again by itself while a Yamlet tab is open; cookie values remain in memory and are refreshed from Chrome. For another host port, enter that `http://localhost:<port>/` address in the extension popup. See [extension/README.md](extension/README.md) for packaging and test details.

| Task | Command |
|---|---|
| Stop / start | `docker stop yamlet` / `docker start yamlet` |
| Update | `docker rm -f yamlet`, then run the same command again: `--pull always` fetches the newest image (keep `-v yamlet-data:/data`) |
| A specific version | `ghcr.io/piyushdoorwar/yamlet:1.2.3` |
| Older Docker (before 23) | Use `-v "$PWD:/workspace"` instead of `-v .:/workspace` |
| Another port | `-p 127.0.0.1:9000:7878` and set `-e YAMLET_PUBLIC_URL=http://localhost:9000` |

**Calling APIs on your own machine.** Inside the container, `localhost` is the container
itself. Use `http://host.docker.internal:<port>` instead (on Linux, add
`--add-host=host.docker.internal:host-gateway` to `docker run`), or run with
`--network host -e HOST=127.0.0.1` and drop the `-p` flag. Keep `-e HOST=127.0.0.1`:
with host networking, the container's default `0.0.0.0` would expose Yamlet to your
whole network.

**File ownership.** The container runs as uid 1000. If your user has a different uid,
add `--user "$(id -u):$(id -g)"` so files Yamlet writes belong to you.

> Yamlet has no login: anyone who can reach the port can read and write the mounted
> folder and send requests from your machine. Keep the `127.0.0.1:` prefix on `-p`.

## Features

- **Plain files, one per request.** Collections are folders and each request is its own
  `<Name>.request.yaml`. Diffs and reviews stay small, and the layout is the local
  collection format other v2.1-compatible clients read and write, so one Git folder works
  in both.
- **Tabs, tree and quick open.** Drag and drop to reorder or move, rename inline,
  duplicate, Ctrl+K to jump to any request. Open tabs come back when you reload.
- **Variables.** Request, environment, collection and global scopes (highest precedence
  first), with case-sensitive names and `{{variable}}` highlighting. Hover a variable to see its value and edit it in place.
  Switch an environment, the collection variables or globals (or a single variable) to
  **Local** to keep values such as tokens on your machine only: the YAML keeps the key with
  a blank value, and the value survives restarts and upgrades in Yamlet's data folder.
  Values that scripts set (a fresh token, say) are current values on your machine: the file
  keeps its initial value, and the table shows both with Reset and Save to file.
  Dynamic values such as `{{$guid}}`, `{{$timestamp}}` and `{{$randomEmail}}` are built
  in; type `{{$` for the full list.
- **Requests.** Every HTTP method, including the new `QUERY` (a safe method with a body), or
  any custom verb. Query and `:path` params, headers, and bodies as JSON, XML, text, HTML,
  form-data (with files), urlencoded, GraphQL (with schema completion and a picker for
  documents with several operations) or binary. Per-request timeout, redirects
  and SSL settings. Paste a cURL command into the URL box to import it.
- **Auth.** Bearer, Basic, Digest, API key, cookie, AWS Signature v4, and OAuth 2.0
  (client credentials, password, authorization code with PKCE, or implicit), set per request or
  inherited from the enclosing folder or collection.
- **Scripts and tests.** Pre-request and post-response JavaScript at request, folder and
  collection level, using a `pm` API (`pm.environment.set`, `pm.test`, `pm.expect`,
  `pm.response.json()`, `pm.response.to.have.jsonSchema()` and more), with built-in
  snippets. `_` (lodash), `CryptoJS`, `Buffer`, `xml2Json()`, and `require()` of `lodash`,
  `crypto-js`, `moment`, `xml2js`, `ajv`, `tv4`, `chai`, `uuid`, `url`, `querystring`, `path`, `util` and
  `events` are available. Older scripts written for the legacy global script API
  (`tests["name"] = ...`, `responseBody`, `responseCode` and its global helper object) still run. In the runner, `pm.execution.setNextRequest()`
  picks what runs next and `pm.execution.skipRequest()` skips a request.
  `pm.cookies.jar()` reads and sets cookies in the workspace jar.
- **Responses.** Pretty, raw and preview (HTML or images), headers, cookies and test
  results. Bodies stream in as they arrive, server-sent events show as a live list, and
  Stop keeps what came in. gzip, deflate and br bodies are decoded. Hover the time for
  DNS, TCP, TLS, waiting and download phases, and the lock for the address, TLS version
  and certificate. Save a response as an example.
- **Console.** Every request you send, with the headers and bodies that went out and came
  back, and the `console.log` output of its scripts (Ctrl+Alt+C).
- **Settings (Ctrl+,).** Default timeout (none unless you set one), maximum response size,
  SSL verification, the system proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) or a custom
  one, extra CA certificates and client certificates per host. Kept in Yamlet's data folder.
- **Collection runner.** Run a collection or folder with iterations, a delay, and a
  CSV or JSON data file. Results stream in live.
- **Import and export.** Import cURL, OpenAPI 3 / Swagger 2 (JSON or YAML), HAR files
  from browser devtools, and v2.1 collection and environment JSON exports, pasted, from a
  file, or from a link; export a collection or environment back to that JSON.
- **Code snippets.** cURL (including Digest and AWS SigV4), HTTPie, wget, raw HTTP,
  JavaScript fetch, Node axios, Python requests, Go, C#, Java, PHP, PowerShell and Ruby.
- **Cookies and history.** A cookie jar per workspace, kept across restarts, where you
  can add and edit cookies; a request can opt out of it. A per-workspace history of what
  you sent: open the request, restore the version you sent, or save it as a new request.

## Workspace layout

```
my-workspace/
  collections/
    JSONPlaceholder/
      .resources/
        definition.yaml      # name, variables, auth, scripts
      List Posts.request.yaml  # one request per file, named after the request
      Users/
        .resources/
          definition.yaml    # order
        List Users.request.yaml
  environments/
    dev.environment.yaml
  globals/
    workspace.globals.yaml
  files/                     # files attached to form-data / binary bodies
```

A request file looks like this:

```yaml
$kind: http-request
url: "{{baseUrl}}/posts"
method: POST
body:
  type: json
  content: |
    { "title": "Yamlet", "userId": {{$randomInt}} }
scripts:
  - type: afterResponse
    code: |
      pm.test('status is 201', () => pm.expect(pm.response.code).to.equal(201));
    language: text/javascript
order: 3000
id: demo-create-post
```

Yamlet-only details (`id`, request variables, settings, saved examples) are extra keys
that other clients ignore. Workspaces from older Yamlet versions (`collection.yaml`,
`folder.yaml`, `<slug>.yaml`) still open; each file moves to this layout when it is next
saved.

Try [samples/demo](samples/demo): mount it with `-v ./samples/demo:/workspace`.

## CLI for CI

The `yamlet` CLI runs a workspace headlessly. It fails the build when a request errors,
a `pm.test` assertion fails, or a request without tests in its own scripts returns a
non-2xx/3xx status (a request that tests itself is judged by its tests, so a test can
expect a 404; collection or folder tests don't excuse a failing status).

```bash
npm install -g @piyushdoorwar/yamlet
yamlet run ./my-workspace --env dev
# or without installing
npx @piyushdoorwar/yamlet run ./my-workspace --env dev
```

See [cli/README.md](cli/README.md) for every option (`--bail`, `--iterations`,
`--data`, `--reporter junit`, …) and a GitHub Actions example.

## Development

Requires Node 22 or newer (24 recommended).

```bash
npm install
npm run dev          # server on :7878 (watch) + Vite UI on :5173 (proxies /api)
npm test             # engine, server, CLI and UI tests (Vitest)
npm run typecheck
npm run build        # dist/web + dist/server
npm start            # serve the built app on 127.0.0.1:7878 (browses your home folder)
npm run build:cli    # bundle the CLI into cli/dist
docker build -t yamlet .
```

```
core/     UI-free engine: models, YAML format, workspace store, variables, request
          builder and executor, scripts, OAuth 2.0, runner, importers, snippets
server/   Fastify API over the engine; serves the built UI
web/      React + Vite + Tailwind UI
shared/   JSON shapes shared by server and UI
cli/      the `@piyushdoorwar/yamlet` npm package (installs the `yamlet` command)
site/     the marketing site (GitHub Pages)
samples/  a ready-to-run workspace
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7878` | Listen port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the container) | Listen address |
| `YAMLET_WORKSPACE` | `/workspace` in the container | Workspace opened on first visit |
| `YAMLET_BROWSE_ROOT` | `/workspace` in the container, else your home folder | The folder browser can't leave this directory |
| `YAMLET_PUBLIC_URL` | `http://localhost:$PORT` | Base URL for the OAuth 2.0 redirect |
| `YAMLET_ALLOWED_HOSTS` | | Extra host names the server answers to (comma-separated) |
| `YAMLET_TIMEOUT_MS` | `0` (none) | Initial default request timeout in ms, until changed in Settings |
| `YAMLET_MAX_RESPONSE_MB` | `50` | Initial maximum response size, until changed in Settings (`0` keeps everything) |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | | Used while Settings is on "Use the system proxy" (the default) |
| `YAMLET_UPDATE_CHECK` | `1` | Set to `0` to stop the hourly check for a newer release on GitHub (only made while the app is open; never in dev builds) |
| `YAMLET_DATA_DIR` | `/data` in the container, else `~/.config/yamlet` | Local variable values (`local-values.json`), Settings (`settings.json`), cookies (`cookies.json`) and extension pairing; mount a persistent volume so they survive container recreation |
| `YAMLET_INTERCEPTOR_DATA_DIR` | `YAMLET_DATA_DIR` | Private pairing state, if it should live elsewhere |

## Releases

Pushes to `main` are tested but not published. Pushing a `v1.2.3` tag publishes the
`1.2.3` / `1.2` / `1` / `latest` images, the `@piyushdoorwar/yamlet` CLI on npm, and a
GitHub release. Pre-release tags such as `v1.3.0-beta.1` publish only that exact version
(npm tag `next`) and leave `latest` alone.

The last version of the earlier .NET desktop app is tagged `dotnet-final`.

## License

[MIT](LICENSE)
