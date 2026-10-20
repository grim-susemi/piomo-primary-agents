# piomo-primary-agents

> **한국어 요약:** senpi TUI에서 Sisyphus, Hephaestus, Prometheus, Atlas 네 메인 에이전트를 Tab으로 바꿔 쓰는 확장입니다. 입력창 아래 라벨, 에이전트별 모델 기억, Prometheus/Atlas 쓰기 제한, 말로 하는 계획 요청을 제공합니다. 자세한 설명서는 [README.ko.md](README.ko.md)에 있습니다.

A senpi (pi) extension that lets you switch between four primary agents with one Tab press: Sisyphus, Hephaestus, Prometheus and Atlas. It does nothing in worker (child) sessions; it only acts in the main TUI session.

The Korean README is the main guide. This page is the short English version.

## Use

**Switch with Tab.** Press Tab in the input. You get the next agent in the order Sisyphus, Hephaestus, Prometheus, Atlas, and the label updates. Agents that can't be used are skipped with a notice.

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

Without memory the lane default applies. Changing a pin or resetting memory on the board bumps the roster `rev`, which makes the old memory file stale.

**Prometheus planning.** On Prometheus, just ask in plain words ("plan the login screen rework"). That opens the ulw-plan flow and its review without typing a command; `/skill:ulw-plan` also works. Re-planning in the same session after ulw-execute needs the gate adapter. Without it, Prometheus only shows a notice that re-planning is locked. The adapter isn't installed live yet; that happens only in the owner-authorized step (todo 16).

**Limits.**
- Prometheus may only change `.md` files under `<cwd>/.omo/`, runs a small read/plan bash allowlist, and delegates only to read-only agents.
- Atlas may only change files under `<cwd>/.omo/`.
- Sisyphus and Hephaestus are unrestricted.

Known residuals, left on purpose: the limits are per tool, so a direct file write from inside an eval cell isn't blocked; Atlas bash is open.

## Install and uninstall

Install: add this repo's path to the `packages` array in your agent dir's `settings.json` (back the file up first), then start a new senpi session.

```json
{
  "packages": [
    "C:\\Users\\USER\\orca\\projects\\piomo-primary-agents"
  ]
}
```

`dist/` is committed, so no build step is needed. Uninstall: remove that line and start a new session. To drop the memory too, delete `<agentDir>/primary-agents/memory/`. The extension never writes `omo.jsonc`.

Developer check:

```
npm test
```

Expect every test to pass with `# fail 0` at the end.

## Troubleshooting

- **Tab doesn't switch.** The token before the cursor looks like a path, a response is streaming, or another extension owns the editor (then the label is missing too). Type a space and retry, wait, or use `/agent`.
- **Hephaestus is missing or skipped.** Hephaestus uses GPT models only. Log in to a ChatGPT subscription (or OpenAI) account in senpi and start a new session.

## What was verified, and what wasn't

From the todo 11, 13 and 14 evidence:
- S12, the live install run with a real model, was not run. It belongs to the todo 16 install.
- The wide-width check (S3) ran at 155 cells, not 200. That's the widest Herdr pane.
- The board profiles view (todo 13) closed with 5 open defects: loading skeleton, `:active` states, select ellipsis, dark-theme disabled contrast, dark-theme error captures.
- The live `/profiles/state` doesn't expose the extension-owned memory files, so the read-only memory cell shows a dash in live use.
- The installed SENPI bundle drifted after the todo 1 baseline, so the todo 14 bundle-identity criterion is unmet (environmental).

## Licence

[LICENSE](LICENSE), [NOTICE](NOTICE), [LICENSES/SUL-1.0.md](LICENSES/SUL-1.0.md)
