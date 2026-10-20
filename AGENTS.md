# House rules for piomo-primary-agents

## Module boundaries

- Unit-tested modules never import the SDK. `contract/`, `src/core/` and `src/ui/` import only Node built-ins and each other.
- `@earendil-works/pi-coding-agent` is imported only under `src/host/`. The same applies to `@code-yeongyu/senpi`: host and SDK access lives under `src/host/`, never in a unit-tested module.
- `contract/` stays pure ESM: only `node:fs`, `node:path` and `node:crypto`.

## Build

- `dist/` is committed so the package installs without a build.
- `dist/` must always equal a fresh `npm run build` of `src/`, `contract/` and `prompts/`; `test/scaffold.test.mjs` proves it.
- `npm run check` runs the unit tests first, then the build.

## QA isolation

- Every QA run uses a temporary agent dir and a temporary home under `os.tmpdir()`.
- `qa/harness.mjs` refuses `LIVEHOME`, `C:/Users/USER/.omo`, `C:/Users/USER/.omo-original` and `C:/Users/USER/.somo` for both the agent dir and the home, including trailing-slash and backslash spellings.
- QA uses the local mock provider only. No real credentials are copied or printed.
- Stop every process you start. Keep evidence under `.omo/evidence/`, never inside this repository.
