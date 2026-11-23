# piomo-primary-agents

> **한국어 요약:** senpi TUI에서 Tab으로 Sisyphus와 Hephaestus를 전환하고, 승인된 계획의 실행 책임자에 따라 실행 역할을 고르는 확장입니다. 자세한 설명서는 [README.ko.md](README.ko.md)에 있습니다.

A senpi (pi) extension for three selectable primary agents. Tab toggles Sisyphus and Hephaestus; `/ulw-execute` applies the execution lead declared in the approved plan. Atlas is retired from new selection. It acts only in the main TUI session.

The Korean README is the main guide. This page is the short English version.

## Use

**Switch with Tab.** Tab toggles Sisyphus and Hephaestus. From Prometheus it returns to Sisyphus. If Hephaestus is unavailable, Sisyphus stays active and a notice appears. `/agent` can select Sisyphus, Hephaestus or Prometheus; `/agent atlas` is refused because Atlas is retired.

`/skill:ulw-plan` no longer switches roles: the request goes straight to the Native skill. `/ulw-execute` or `/skill:ulw-execute` selects one plan, reads its `Execution lead:` field, applies that role and model, verifies the live session, and only then forwards the same plan name to the Native execution skill. With no selectable plan it forwards the Native `/skill:ulw-plan` bootstrap request once and executes nothing.

Tab stays a completion key when:
- the autocomplete list is open;
- the token before the cursor looks like a path or command (starts with `/ . ~ @`, contains `/` or `\`, or starts with a drive like `C:`);
- a response is streaming or a switch is in flight (you get one "can't switch while responding" notice and nothing changes).

Everything else switches. A trailing dot or a time like `10:30` counts as plain text.

**Read the label.** The line under the input looks like `▌ Hephaestus  gpt-6.1-sol-fast · medium   Tab 전환`. The bar and name use the agent's colour, then the model id and thinking level. `(대기)` after the model means the change applies on the next turn. On narrow screens the `Tab 전환` hint goes first, then the model id is shortened with `…`.

**`/agent [name]`.** Without a name it opens a picker of available agents. With a name (case-insensitive) it switches directly; an unknown name shows the valid names.

**Per-agent model memory.** Pick a model with `/model` while on an agent and that agent keeps it, across sessions too. Files:
- memory: `<agentDir>/primary-agents/memory/<agentId>.json` (written by this extension only)
- lanes and pins: `<agentDir>/primary-agents/roster.json` (written by the board only)

Memory for the current roster `rev` wins, then the roster pin, then the lane default. Unpinned Sisyphus uses the settings main model before its lane. A fresh session applies matching memory; it does not reapply a main model the host already started with. Model and thinking picks remember the roster revision at selection time. Changing a pin or resetting memory on the board bumps `rev`, which makes old memory stale.

The Windows switcher does not bump roster `rev`, so changes made there cannot override existing matching memory. Use the board to reset memory or change the pin. Unusable higher-priority candidates show their model, registration/authentication reason and the actual substitute once per session. File warnings appear once per code and file. Only Muse models may use `opencode-go` through a lane; explicit memory, pins and main selections keep their own priority, and other providers remain available.

**Prometheus is preset-only.** Prometheus keeps its display name and provider/model/thinking preset. It has no prompt overlay, no PiOMO tool policy and no input rewrite; plain text is sent unchanged, and `/skill:ulw-plan` is the way to start a plan. With the recorded `plan-review-unlock` policy, review remains available after execution and another execution does not relock it. Explicit owner requests and actual plan artifacts remain required. The optional gate adapter is only needed for the earlier execution-locking policy and is not installed automatically. Install, removal, rollback and the omo-update routine (Korean): [docs/gate-adapter.ko.md](docs/gate-adapter.ko.md).

**Execution handoff.** `/ulw-execute <plan>` reads `Execution lead: sisyphus|hephaestus` and `Execution rationale:` from the plan's TL;DR. Missing fields keep the legacy Sisyphus default; a single field, an unknown role or an empty reason blocks execution. Multiple plans open one selection question, and an explicit name that does not exist never falls through to another plan. Immediately before forwarding, the router stores the plan's normalized path, SHA-256 and body; the first `task`/`workflow` delegation is allowed only after the Native skill's own `read` returns those exact bytes. A missing read, a different plan read, a changed body, a changed role/model or a changed plan file blocks the delegation and requires a new explicit execution. A second execute submission while one is being routed is consumed with a notice.

**Atlas retirement.** New Atlas selection, its prompt and its return-on-completion behavior are gone. A resumed legacy Atlas session keeps its work IDs and checkpoints and continues as Sisyphus; `/agent atlas` is refused.

## Install and uninstall

Install with the installer, from this repo:

```
node scripts/install.mjs --agent-dir <agentDir>
```

It builds `dist/` and requires `git status --porcelain -- dist` to be empty, then copies `dist/` to `<agentDir>/primary-agents/integration/generation-NNNNNN/` (the next free number, existing generations are never overwritten). It writes `current.json` and the shim `<agentDir>/extensions/omo-primary-agents.js`, both by temp file and rename. Add `--dry-run` to print the plan without writing anything. Start a new senpi session after installing.

The installer refuses the live agent dir unless `--live` is given, refuses a `settings.json` that already loads this repo through `packages` or `extensions`, and refuses a shim it did not write. `dist/` is committed, so no build step is needed by you.

Uninstall: `node scripts/install.mjs --agent-dir <agentDir> --uninstall`. It removes only the shim and `current.json`; generations stay. To drop the memory too, delete `<agentDir>/primary-agents/memory/`. The extension never writes `omo.jsonc`.

The older `packages` line in `settings.json` (add this repo path to the `packages` array) also works, but do not combine it with the shim: remove that entry before installing the shim.

Developer check:

```
npm test
```

Expect every test to pass with `# fail 0` at the end.

## Troubleshooting

- **Tab doesn't switch.** The token before the cursor looks like a path, a response is streaming, or another extension owns the editor (then the label is missing too). Type a space and retry, wait, or use `/agent`.
- **Hephaestus is missing or skipped.** Hephaestus uses GPT models only. Log in to a ChatGPT subscription (or OpenAI) account in senpi and start a new session.

## What was verified, and what wasn't

Original evidence and the October 21 recovery candidate have different scopes. Candidate verification is not a live installation:
- S12, the live install run with a real model, was not run. It belongs to the todo 16 install.
- The wide-width check (S3) ran at 155 cells, not 200. That's the widest Herdr pane.
- The former board defects were repaired; two independent reviews and 252 captures passed on the same frontend sources. The later inventory source fingerprint update is not presented as a new full visual review.
- The candidate exposes extension-owned memories read-only; missing files show a dash. The board never writes those memory files.
- Literal equality with the original bundle baseline remains false. The owner-approved original-plus-recorded-patches comparison reconciled 9,062 entries with no unexplained differences.
- Real temporary TUI verification confirms the current policy: missing owner requests or plan artifacts are refused; a plain-language Prometheus replan is admitted; an active child reports to the same parent; another execution does not relock review. Final audits and live installation remain separate.

## Licence

[LICENSE](LICENSE), [NOTICE](NOTICE), [LICENSES/SUL-1.0.md](LICENSES/SUL-1.0.md)
