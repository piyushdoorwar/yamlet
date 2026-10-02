# @piyushdoorwar/yamlet

Run [Yamlet](https://github.com/piyushdoorwar/yamlet) API collections from the command
line, for example in CI. It fails the build when a request errors, returns a status
outside 2xx/3xx, or a `pm.test` assertion fails.

## Install

```bash
npm install -g @piyushdoorwar/yamlet
# or run without installing
npx @piyushdoorwar/yamlet run ./my-workspace
```

It installs the `yamlet` command. Requires Node.js 22 or newer.

## Usage

```bash
yamlet run <workspace> [options]
```

`<workspace>` is a Yamlet workspace folder (it contains `collections/` and
`environments/`), or its parent: the same folder you open in the app. Requests run in
tree order, collection by collection. Pre-request and post-response scripts run, and
`pm.test` assertions are counted.

| Option | Meaning |
|---|---|
| `-e, --env <name\|file>` | Environment to use: a name from the workspace (`dev`) or a path to an environment YAML file |
| `-g, --globals <file>` | Use these globals instead of the workspace's |
| `-c, --collection <name>` | Only run this collection (repeat for several) |
| `-n, --iterations <n>` | Run everything `n` times |
| `-d, --data <file>` | CSV (with a header row) or JSON array of objects; one iteration per row. Values are available as `{{column}}` and `pm.iterationData.get("column")` |
| `--delay <ms>` | Wait between requests |
| `--bail` | Stop after the first failing request |
| `-r, --reporter <name>` | `table` (default), `json` or `junit` |
| `-o, --out <file>` | Write the `json` / `junit` report to a file |
| `--no-color` | Plain output (also honors `NO_COLOR`) |

The exit code is `0` when every request passed and `1` otherwise.

```bash
yamlet run ./api --env dev
yamlet run ./api --env environments/staging.yaml --collection Payments --bail
yamlet run ./api --env dev --data users.csv --reporter junit --out yamlet-results.xml
```

## GitHub Actions

```yaml
- uses: actions/setup-node@v5
  with:
    node-version: 24
- name: API tests
  run: npx --yes @piyushdoorwar/yamlet run ./api --env ci --reporter junit --out yamlet-results.xml
- name: Publish results
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: yamlet-results
    path: yamlet-results.xml
```

## License

MIT
