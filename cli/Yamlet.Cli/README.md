# Yamlet CLI

Run [Yamlet](https://github.com/piyushdoorwar/yamlet) API collections headlessly — for
example in CI — and fail the build when a request errors or a `pm.test` assertion fails.

## Install

```bash
dotnet tool install --global Yamlet.Cli
```

## Usage

```bash
yamlet run <workspace> [--env <file>] [--globals <file>] [--bail]
```

`<workspace>` is a Yamlet workspace folder (containing `collections/` and `environments/`,
or its parent — the same folder you open in the app). Every request in every collection is
sent in tree order; pre/request and post/response scripts run, and `pm.test` assertions are
evaluated.

```bash
yamlet run ./my-workspace --env environments/dev.yml
```

`--env` accepts an environment YAML file path or the name of an environment already in the
workspace. `--globals` overrides the workspace globals. `--bail` stops at the first failure.

## Exit code

`0` when every request returned a 2xx/3xx status **and** every `pm.test` passed; `1`
otherwise — so it gates a CI job directly.

## GitHub Actions

```yaml
- name: Install Yamlet
  run: dotnet tool install --global Yamlet.Cli

- name: Run API tests
  run: yamlet run . --env environments/dev.yml
```
