# Sample workspaces

A ready-to-run Yamlet workspace for trying the app and the `yamlet` CLI. It hits the
public, no-auth [JSONPlaceholder](https://jsonplaceholder.typicode.com) API, so it needs
network access but no secrets.

## `demo/`

```
demo/
  collections/jsonplaceholder/
    collection.yaml        # collection metadata (name, id, a collection variable)
    list-posts.yaml        # GET  {{baseUrl}}/posts        (order 0)
    get-post.yaml          # GET  {{baseUrl}}/posts/{{postId}}  (order 1)
    create-post.yaml       # POST {{baseUrl}}/posts        (order 2, JSON body)
    users/
      folder.yaml          # folder metadata (name, order)
      list-users.yaml      # GET  {{baseUrl}}/users
  environments/dev.yaml    # baseUrl -> https://jsonplaceholder.typicode.com
  globals/globals.yaml     # appName -> Yamlet
```

Each request carries `pm.test` assertions, so it doubles as a CLI smoke test.

### Run it with the CLI

```bash
# from the repo root, using the CLI built from source:
npm run build:cli
node cli/dist/yamlet.js run samples/demo --env dev

# or with the published CLI:
npx @piyushdoorwar/yamlet run samples/demo --env dev
```

Expect every request to pass (exit code `0`).

### Open it in the app

```bash
docker run --rm -p 127.0.0.1:7878:7878 -v "$PWD/samples/demo:/workspace" ghcr.io/piyushdoorwar/yamlet:latest
```

Then open <http://localhost:7878>. The app and the CLI share the same engine, so what runs
in CI is what you see in the UI.

### In CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) builds the CLI from source and runs
this workspace on every push.
