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
docker run -d --name yamlet -p 127.0.0.1:7878:7878 -v "$PWD:/workspace" -v yamlet-data:/data ghcr.io/piyushdoorwar/yamlet:latest
```

Then open <http://localhost:7878>. The folder you mount at `/workspace` is your
workspace. If it isn't one yet, Yamlet offers to set it up (it creates `collections/`,
`environments/` and `globals/`).

The `yamlet-data` volume holds private app state outside your workspace, such as the
Chrome extension pairing. Keep the same `-v yamlet-data:/data` whenever you recreate the
container (for example after an update); without it each new container starts with an
empty `/data` and the extension has to pair again.

**Install as an app.** With the container running, open Yamlet at
<http://localhost:7878> and use your browser's **Install app** option (or **Add to Home
Screen** on mobile). The installed app uses the Yamlet logo and opens in its own window.
Keep the container running to use your workspaces and send requests. If you access
Yamlet from another device, serve it over HTTPS for browser installation.

**Chrome cookie sync.** The optional Yamlet Interceptor extension syncs cookies from sites you approve into Yamlet. It works with the published image started as above. Until it is listed in the Chrome Web Store, load it from this repository. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension/` folder of a clone of this repository. Open **Cookies** from Yamlet's status bar, choose **Pair extension**, and confirm in the window the extension opens (or choose **Use a code instead** and paste it into the extension popup). Open a site, choose **Allow and sync this site**, and inspect the cookies in Yamlet. Approved sites refresh while Chrome is running. The `/data` volume keeps pairing across container recreation; if it is lost, the extension pairs again by itself while a Yamlet tab is open; cookie values remain in memory and are refreshed from Chrome. For another host port, enter that `http://localhost:<port>/` address in the extension popup. See [extension/README.md](extension/README.md) for packaging and test details.

| Task | Command |
|---|---|
| Stop / start | `docker stop yamlet` / `docker start yamlet` |
| Update | `docker pull ghcr.io/piyushdoorwar/yamlet:latest`, then `docker rm -f yamlet` and run the same command again (keep `-v yamlet-data:/data`) |
| A specific version | `ghcr.io/piyushdoorwar/yamlet:1.2.3` |
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

- **Plain files, one per request.** Collections are folders, folders have a tiny
  `folder.yaml`, and each request is its own `.yaml` file. Diffs and reviews stay small.
- **Tabs, tree and quick open.** Drag and drop to reorder or move, rename inline,
  duplicate, Ctrl+K to jump to any request. Open tabs come back when you reload.
- **Variables.** Request, collection, environment and global scopes, with
  `{{variable}}` highlighting. Hover a variable to see its value and edit it in place.
  Dynamic values such as `{{$guid}}`, `{{$timestamp}}` and `{{$randomEmail}}` are built
  in; type `{{$` for the full list.
- **Requests.** Every HTTP method, including the new `QUERY` (a safe method with a body), or
  any custom verb. Query and `:path` params, headers, and bodies as JSON, XML, text, HTML,
  form-data (with files), urlencoded, GraphQL or binary. Per-request timeout, redirects
  and SSL settings. Paste a cURL command into the URL box to import it.
- **Auth.** Bearer, Basic, API key, cookie, and OAuth 2.0 (client credentials, password,
  or authorization code with PKCE), set per request or inherited from the collection.
- **Scripts and tests.** Pre-request and post-response JavaScript at request and
  collection level, using a `pm` API (`pm.environment.set`, `pm.test`, `pm.expect`,
  `pm.response.json()` and more), with built-in snippets.
- **Responses.** Pretty, raw and preview (HTML or images), headers, cookies, test
  results, a console, timings and size. Save a response as an example.
- **Collection runner.** Run a collection or folder with iterations, a delay, and a
  CSV or JSON data file. Results stream in live.
- **Import.** cURL, OpenAPI 3 / Swagger 2 (JSON or YAML), and v2.1 collection and
  environment JSON exports.
- **Code snippets.** cURL, raw HTTP, JavaScript fetch, Node axios, Python requests, Go,
  C#, Java, PHP, PowerShell and Ruby.
- **Cookies and history.** A cookie jar shared across requests, and a per-workspace
  history of what you sent.

## Workspace layout

```
my-workspace/
  collections/
    jsonplaceholder/
      collection.yaml        # name, variables, auth, scripts
      list-posts.yaml        # one request per file
      users/
        folder.yaml          # name + order
        list-users.yaml
  environments/
    dev.yaml
  globals/
    globals.yaml
  files/                     # files attached to form-data / binary bodies
```

A request file looks like this:

```yaml
id: demo-create-post
name: Create Post
order: 2
method: POST
url: '{{baseUrl}}/posts'
body:
  type: json
  raw: |
    { "title": "Yamlet", "userId": {{$randomInt}} }
scripts:
  - type: afterResponse
    code: |
      pm.test('status is 201', () => pm.expect(pm.response.code).to.equal(201));
```

Try [samples/demo](samples/demo): mount it with `-v "$PWD/samples/demo:/workspace"`.

## CLI for CI

The `yamlet` CLI runs a workspace headlessly. It fails the build when a request errors,
returns a non-2xx/3xx status, or a `pm.test` assertion fails.

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
| `YAMLET_TIMEOUT_MS` | `30000` | Default request timeout |
| `YAMLET_INTERCEPTOR_DATA_DIR` | `/data` in the container | Private pairing state; mount a persistent volume for container recreation |

## Releases

Pushes to `main` are tested but not published. Pushing a `v1.2.3` tag publishes the
`1.2.3` / `1.2` / `1` / `latest` images, the `@piyushdoorwar/yamlet` CLI on npm, and a
GitHub release. Pre-release tags such as `v1.3.0-beta.1` publish only that exact version
(npm tag `next`) and leave `latest` alone.

The last version of the earlier .NET desktop app is tagged `dotnet-final`.

## License

[MIT](LICENSE)
