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
# from the repo root, using the project directly:
dotnet run --project cli/Yamlet.Cli -- run samples/demo --env samples/demo/environments/dev.yaml

# or, once the tool is installed (dotnet tool install --global Yamlet.Cli):
yamlet run samples/demo --env samples/demo/environments/dev.yaml
```

Expect every request to pass (exit code `0`).

### Open it in the app

```bash
dotnet run --project src/Yamlet.App
```

Then open the `samples/demo` folder — the app and CLI share the same loaders, so what runs
in CI is what you see in the UI.

### In CI

[.github/workflows/verify-samples.yml](../.github/workflows/verify-samples.yml) installs the
latest published `Yamlet.Cli` from nuget.org and runs this workspace on every push —
dogfooding the released tool exactly as a consumer would.
