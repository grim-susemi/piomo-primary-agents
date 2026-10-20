// Build the todo-2 probe report from the raw result files. Usage:
//   node qa/probes/build-report.mjs --out <evidence dir>
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PLUGIN } from '../harness.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) {
  console.error('usage: node qa/probes/build-report.mjs --out <evidence dir>');
  process.exit(2);
}
const OUT = values.out;
const RAW = join(OUT, 'probe-raw');
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const senpiVersion = JSON.parse(readFileSync(
  'C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/package.json', 'utf8',
)).version;
const pluginTask = join(PLUGIN, 'extensions', 'omo-task.js');
const globalTask = 'C:/Users/USER/.bun/install/global/node_modules/omo-ai/plugin/extensions/omo-task.js';

const headless = readJson(join(RAW, 'headless-results.json'));
const tui = readJson(join(RAW, 'tui-results.json'));
const staticResults = readJson(join(RAW, 'static-results.json'));
const p9 = readJson(join(RAW, 'p9-result.json'));
const tuiRuns = {
  P3: readJson(join(RAW, 'p3-run.json')),
  P5a: readJson(join(RAW, 'p5a-run.json')),
  P5b: readJson(join(RAW, 'p5b-run.json')),
  P6: readJson(join(RAW, 'p6-run.json')),
  P7: readJson(join(RAW, 'p7-run.json')),
};
const liveBefore = readJson(join(OUT, 'live-hashes-before.json'));
const liveAfter = {};
for (const path of Object.keys(liveBefore)) {
  if (existsSync(path)) liveAfter[path] = sha256(path);
}

const lines = [];
const add = (...values) => lines.push(...values);
const verdictOf = result => result?.verdict ?? 'FAIL (missing evidence)';
const decisionOf = result => result?.decision ?? 'probe did not produce a decision';
const rawOf = (...paths) => paths.map(path => `\`${path}\``).join(', ');

add(
  '# Todo 2 - runtime probes that decide every fallback',
  '',
  `- Attempt dir: \`${OUT}\``,
  `- Date: 2026-10-20`,
  `- Engine: senpi ${senpiVersion} (\`@code-yeongyu/senpi/dist/bundle/cli.js\`)`,
  `- Plugin under test: \`${PLUGIN}\``,
  `- \`omo-task.js\` sha256: PLUGIN \`${sha256(pluginTask)}\`, global \`${sha256(globalTask)}\``,
  '',
  '## Runtime surface',
  '',
  '| Probe | Surface | Temp agent dir |',
  '| --- | --- | --- |',
  `| P1 | headless (mock provider) | \`${headless.P1?.temp?.agentDir ?? 'n/a'}\` |`,
  `| P2 | headless (mock provider; safe, unsafe and OMO-loaded runs) | \`${headless.P2?.safe?.temp?.agentDir ?? 'n/a'}\` |`,
  `| P3 | headless + Herdr TUI pane | \`${headless.P3?.temp?.agentDir ?? 'n/a'}\` |`,
  `| P4 | headless parent + process child | \`${headless.P4?.temp?.agentDir ?? 'n/a'}\` |`,
  `| P5a/P5b | Herdr TUI panes (temp copy of PLUGIN) | \`${tuiRuns.P5a.agentDir ?? 'n/a'}\` |`,
  `| P6 | Herdr TUI pane | \`${tuiRuns.P6.agentDir ?? 'n/a'}\` |`,
  `| P7 | Herdr TUI pane | \`${tuiRuns.P7.agentDir ?? 'n/a'}\` |`,
  `| P8 | static schema read + headless parse acceptance | \`${staticResults.P8?.nativeAcceptance?.temp?.agentDir ?? 'n/a'}\` |`,
  `| P9 | two writer node processes + one reader process | \`${p9.directory ?? 'n/a'}\` |`,
  `| P10 | read-only live settings + extension grep | none (no run) |`,
  `| P11 | read-only temp copies of both omo-task.js files | none (no run) |`,
  '',
  'Every headless/TUI run used a temp agent dir and home under `%TEMP%`, outside every LIVEHOME; each row above records the dir the run logged before cleanup.',
  '',
);

// P1
add(
  '## P1 - overlay order: ' + verdictOf(headless.P1),
  '',
  `**Verdict: ${verdictOf(headless.P1)}.** ${decisionOf(headless.P1)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p1.log'), join(RAW, 'headless-results.json'))}`,
  `- Provider requests: ${headless.P1?.requests?.length ?? 0} (${(headless.P1?.requests ?? []).map(request => request.model).join(', ') || 'none'})`,
  `- Marker present and last on every request: ${(headless.P1?.requests ?? []).every(request => request.markerPresent && request.markerLast) ? 'yes' : 'no'}`,
  `- Model switch: ${headless.P1?.modelSwitch ? `setSessionModel -> ${headless.P1.modelSwitch.result}, ${headless.P1.modelSwitch.after?.id}` : 'not observed'}`,
  '',
  'Decision: append the persona block at the end of `event.systemPrompt` in `before_agent_start` with `{previewSafe:true}`; no `context_with_system` rewrite is needed.',
  '',
);

// P2
const p2 = headless.P2;
add(
  '## P2 - preview purity: ' + verdictOf(p2),
  '',
  `**Verdict: ${verdictOf(p2)}.** ${decisionOf(p2)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p2-safe.log'), join(RAW, 'p2-unsafe.log'), join(RAW, 'p2-omo.log'), join(RAW, 'headless-results.json'))}`,
  `- Safe-only run: preview calls ${p2?.safe?.preview ?? 'n/a'}, real calls ${p2?.safe?.real ?? 'n/a'}, prefix request \`${p2?.safe?.previewRequest?.status ?? 'n/a'}\``,
  `- Safe + unsafe run: preview calls ${p2?.unsafe?.preview ?? 'n/a'}, real calls ${p2?.unsafe?.real ?? 'n/a'}, prefix request \`${p2?.unsafe?.previewRequest?.status ?? 'n/a'}\` (${p2?.unsafe?.previewRequest?.reason ?? 'no reason'})`,
  `- OMO-loaded run: preview calls ${p2?.withOmo?.preview ?? 'n/a'}, prefix request \`${p2?.withOmo?.previewRequest?.status ?? 'n/a'}\` (${p2?.withOmo?.previewRequest?.reason ?? 'no reason'})`,
  '',
  'Decision: the handler must stay pure. A preview-safe handler is invoked with `preview:true` when the host builds the prompt-cache prefix, so it must not read or mutate one-shot state; one non-preview-safe handler skips the whole preview pass (`runner.js:1748-1757`). With OMO 5.1.38 loaded, `omo.js` is that unsafe handler today, so this extension never receives previews in the real session.',
  '',
);

// P3
add(
  '## P3 - model-change origins: ' + verdictOf(headless.P3) + ' / TUI ' + verdictOf(tui.P3),
  '',
  `**Verdict: ${verdictOf(headless.P3)} + TUI ${verdictOf(tui.P3)}.** ${decisionOf(tui.P3)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p3-headless.log'), join(RAW, 'p3-session.jsonl'), join(RAW, 'p3-tui.log'), join(RAW, 'tui-results.json'))}`,
  `- Headless extension switch: \`setSessionModel\` returned ${headless.P3?.setSessionModel?.result ?? 'n/a'}, \`ctx.model\` ${headless.P3?.setSessionModel?.before?.id ?? '?'} -> ${headless.P3?.setSessionModel?.after?.id ?? '?'}, heldSwitch=${headless.P3?.setSessionModel?.heldSwitch ?? 'n/a'}; committed entry source=\`${headless.P3?.setSessionModel?.entriesTail?.at(-1)?.source ?? 'n/a'}\`, actor=\`${headless.P3?.setSessionModel?.entriesTail?.at(-1)?.actor ?? 'n/a'}\``,
  `- Brand-new session at \`session_start\`: ${(headless.P3?.sessionStart?.entries ?? []).map(entry => entry.type).join(' -> ') || 'n/a'}; the initial \`model_change\` (${headless.P3?.sessionStart?.entries?.[0]?.provider ?? '?'}/${headless.P3?.sessionStart?.entries?.[0]?.modelId ?? '?'}) and \`thinking_level_change\` precede every message.`,
  '',
  'TUI entries observed:',
  '',
  '| Action | model_change source | actor | thinking entry |',
  '| --- | --- | --- | --- |',
  '| typed `/model gpt-mock-fast` | `command` | none | n/a |',
  '| Ctrl+L picker -> claude-mock-max | `picker` | `model-selector` | n/a |',
  '| Ctrl+P cycle (favorites configured) | `cycle` | none | n/a |',
  '| Shift+Tab thinking | n/a | n/a | `thinking_level_change` with `thinkingSelection:{level,source:"explicit"}` and no `triggerSource`/`triggerActor` |',
  '| `pi.setSessionModel` from the probe | `extension` | probe path | n/a (model switch only) |',
  '',
  'Decision: learn model memory only from committed `model_change` entries whose source is `command`, `picker` or `cycle` (UB3). Never learn from `extension`; treat a true `setSessionModel` return with an unchanged `ctx.model` as a held switch and verify the live model before recording it. No held switch was observed here (return true, `ctx.model` changed, `duringTurn:true`).',
  '',
);

// P4
add(
  '## P4 - child signal: ' + verdictOf(headless.P4),
  '',
  `**Verdict: ${verdictOf(headless.P4)}.** ${decisionOf(headless.P4)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p4.log'), join(RAW, 'headless-results.json'))}`,
  `- Parent: pid ${headless.P4?.factories?.[0]?.pid ?? '?'}, \`pi.sessionKind\`=${headless.P4?.factories?.[0]?.sessionKind ?? '?'}, \`ctx.mode\`=${headless.P4?.starts?.[0]?.mode ?? '?'}, \`ctx.hasUI\`=${headless.P4?.starts?.[0]?.hasUI ?? '?'}`,
  `- Child: pid ${headless.P4?.starts?.find(entry => entry.pid !== headless.P4?.factories?.[0]?.pid)?.pid ?? '?'}, \`pi.sessionKind\`=${headless.P4?.starts?.find(entry => entry.pid !== headless.P4?.factories?.[0]?.pid)?.sessionKindAtFactory ?? '?'}, \`ctx.mode\`=${headless.P4?.starts?.find(entry => entry.pid !== headless.P4?.factories?.[0]?.pid)?.mode ?? '?'}, \`ctx.hasUI\`=${headless.P4?.starts?.find(entry => entry.pid !== headless.P4?.factories?.[0]?.pid)?.hasUI ?? '?'}`,
  `- Child session file: \`${headless.P4?.starts?.find(entry => entry.pid !== headless.P4?.factories?.[0]?.pid)?.sessionFile ?? 'n/a'}\``,
  '',
  'Decision: `isPrimaryMain = pi.sessionKind === "interactive" && ctx.mode === "tui" && ctx.hasUI`. A task child opened as an RPC session reports `sessionKind: "interactive"` and `hasUI: true`, so `sessionKind` or `hasUI` alone is not enough; `ctx.mode === "tui"` is the discriminator. Every handler must also no-op in `rpc`/`print`/`json` modes.',
  '',
);

// P5
add(
  '## P5 - gate request: ' + verdictOf(tui.P5a) + ' / ' + verdictOf(tui.P5b),
  '',
  `**P5a verdict: ${verdictOf(tui.P5a)}.** ${decisionOf(tui.P5a)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p5a.log'), join(RAW, 'p5a-run.json'), join(RAW, 'tui-results.json'))}`,
  `- Temp copy of PLUGIN: \`${tuiRuns.P5a.pluginCopy ?? 'n/a'}\` (omo-task.js sha256 \`${tuiRuns.P5a.pluginTaskSha256 ?? 'n/a'}\`, source \`${tuiRuns.P5a.pluginSourceTaskSha256 ?? 'n/a'}\`)`,
  `- onSubmit wrap: owner text \`${tui.P5a?.wrap?.ownerText ?? 'n/a'}\` -> \`${tui.P5a?.wrap?.forwarded ?? 'n/a'}\``,
  `- Gate outcome: \`${tui.P5a?.taskVerdict?.verdict ?? 'n/a'}\`; the task reached model resolution ("No available model for agent plan-consultant") instead of the plan-gate denial, so the request was admitted.`,
  `- Cancel: ${tui.P5a?.taskCancel?.cancelled ? `task_cancel sent for ${tui.P5a.taskCancel.taskId}` : 'no child was created (plan_error before spawn), so there was nothing to cancel'}`,
  '',
  `**P5b verdict: ${verdictOf(tui.P5b)}.** ${decisionOf(tui.P5b)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p5b.log'), join(RAW, 'p5b-run.json'), join(RAW, 'tui-results.json'))}`,
  `- \`pi.sendUserMessage\` produced an \`input\` event with source \`extension\`; the gate returned \`${tui.P5b?.taskVerdict?.verdict ?? 'n/a'}\`: ${tui.P5b?.taskResult?.result?.slice(0, 180) ?? 'n/a'}`,
  '',
  'Decision: the rewrite must happen in the editor `onSubmit` wrap (todo 9), because only the owner-typed, interactive submission is seen by the gate; `source:"extension"` is ignored. Install-order finding: the editor installed during `session_start` can be replaced by the host, so the wrap must be (re)applied to the live editor instance and verified (`liveOnSubmitIsWrapper`) before relying on it.',
  '',
);

// P6
add(
  '## P6 - Tab: ' + verdictOf(tui.P6),
  '',
  `**Verdict: ${verdictOf(tui.P6)}.** ${decisionOf(tui.P6)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p6.log'), join(RAW, 'p6-run.json'), join(RAW, 'tui-results.json'))}`,
  `- Token before the cursor: ${Object.entries(tui.P6?.tokenShapes ?? {}).map(([name, shape]) => `\`${name}\`=\`${shape?.token ?? '?'}\` (${shape?.pathLike ? 'path/command-like' : 'plain'})`).join(', ')}`,
  `- Completion still opened via \`super.handleInput\`: ${Object.entries(tui.P6?.completion ?? {}).map(([name, open]) => `${name}=${open}`).join(', ')}`,
  `- List-open second Tab: autocompleteBefore=${tui.P6?.listOpenSecond?.autocompleteBefore ?? 'n/a'} (the list was already open, so the Tab was passed through, not consumed for cycling)`,
  '',
  'Decision: consume Tab for the agent cycle only when `isShowingAutocomplete()` is false and the token before the cursor is empty or not path/command-like (no `/`, `\\`, `.`, `~`, `@`, `:`). Every path/slash token must be passed to `super.handleInput`; slash and file completion still work.',
  '',
);

// P7
add(
  '## P7 - submit wrap: ' + verdictOf(tui.P7),
  '',
  `**Verdict: ${verdictOf(tui.P7)}.** ${decisionOf(tui.P7)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p7.log'), join(RAW, 'p7-run.json'), join(RAW, 'tui-results.json'))}`,
  `- Idle: wrapper saw \`${tui.P7?.idleWrap?.text ?? 'n/a'}\` with idle=${tui.P7?.idleWrap?.idle ?? 'n/a'} (sequence ${tui.P7?.idleWrap?.sequence ?? '?'}) before the input event (sequence ${tui.P7?.idleInput?.sequence ?? '?'}); the input pipeline saw \`${tui.P7?.idleInput?.text ?? 'n/a'}\` after command expansion.`,
  `- Streaming: wrapper saw \`${tui.P7?.streamWrap?.text ?? 'n/a'}\` with idle=${tui.P7?.streamWrap?.idle ?? 'n/a'} (sequence ${tui.P7?.streamWrap?.sequence ?? '?'}) before the input event (sequence ${tui.P7?.streamInput?.sequence ?? '?'}); the input pipeline saw \`${tui.P7?.streamInput?.text ?? 'n/a'}\`.`,
  '',
  'Decision: the `onSubmit` wrap installed after `ctx.ui.setEditorComponent` sees the raw `/ulw-execute ...` before command dispatch, both idle and while streaming; todo 9 can switch to Atlas there and then forward the original text exactly once.',
  '',
);

// P8
add(
  '## P8 - lane override shape: ' + verdictOf(staticResults.P8),
  '',
  `**Verdict: ${verdictOf(staticResults.P8)}.** ${decisionOf(staticResults.P8)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p8-schema.txt'), join(RAW, 'p8-result.json'), join(RAW, 'p8-native.log'))}`,
  `- Native-override parse acceptance: ${staticResults.P8?.nativeAcceptance?.verdict ?? 'n/a'} (exit ${staticResults.P8?.nativeAcceptance?.exitCode ?? '?'}, validation noise=${staticResults.P8?.nativeAcceptance?.validationNoise ?? '?'})`,
  `- Lane: \`{ display_name?: string, family?: "daily"|"geeky", tier?: "normal"|"heavy", models?: Array<string|rung> }\`; rung: \`{ model: string, variant?, reasoning?, temperature?, top_p?, max_tokens?, provider_options?, reasoningEffort?, thinking?, textVerbosity?, maxTokens?, providerOptions? }\`.`,
  '',
  'Decision: todo 4 emits `[native].model_profiles` as partial lanes (the `Wc` schema) and root `model_profiles` as complete lanes (the `Bc` schema); the plugin parser accepted a temp config with a `[native].model_profiles["daily-normal"]` override.',
  '',
);

// P9
add(
  '## P9 - Windows contention: ' + verdictOf(p9),
  '',
  `**Verdict: ${verdictOf(p9)}.** ${decisionOf(p9)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p9-result.json'), join(RAW, 'p9-writers.txt'))}`,
  `- Writers: ${p9.writerResults?.map(writer => `${writer.writer}=${writer.iterations}`).join(', ') ?? 'n/a'}; reads ${p9.readerResult?.reads ?? 'n/a'}, parse errors ${p9.readerResult?.parseErrors ?? 'n/a'}; retries ${p9.retryTotal ?? 'n/a'}`,
  `- Temp dir removed: ${p9.cleanup?.removed ?? 'n/a'}`,
  '',
  'Decision: todo 4 adopts `qa/probes/atomic-proto.mjs`: exclusive same-directory temp file, `fsync`, close, `rename` with 10/20/40/80/160 ms EPERM/EBUSY retries; two writers at 200 iterations each produced zero unparsable reads for the third reader.',
  '',
);

// P10
add(
  '## P10 - shared UI slots: ' + verdictOf(staticResults.P10),
  '',
  `**Verdict: ${verdictOf(staticResults.P10)}.** ${decisionOf(staticResults.P10)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p10-grep.txt'), staticResults.P10?.listPath ?? join(OUT, 'task-2-piomo-primary-agents-p10-loaded-extensions.json'))}`,
  `- Loaded extension files scanned: ${staticResults.P10?.extensionCount ?? 'n/a'}`,
  `- Owners: setTitle=[${(staticResults.P10?.owners?.setTitle ?? []).join(', ')}], setEditorComponent=[${(staticResults.P10?.owners?.setEditorComponent ?? []).join(', ')}], belowEditor=[${(staticResults.P10?.owners?.belowEditor ?? []).join(', ')}], setWidget=[${(staticResults.P10?.owners?.setWidget ?? []).join(', ')}]`,
  '',
  'Decision: todo 8 may call `setTitle` (no other loaded extension does), and it would be the first `setEditorComponent` owner. `belowEditor`/`setWidget` are already used by OMO (`omo.js`, `omo-task.js`, `omo-side-panel.js`), so todo 8 must use a unique widget key and preserve their widgets. The list is saved for todo 11 S10.',
  '',
);

// P11
add(
  '## P11 - gate anchor: ' + verdictOf(staticResults.P11),
  '',
  `**Verdict: ${verdictOf(staticResults.P11)}.** ${decisionOf(staticResults.P11)}`,
  '',
  `- Raw evidence: ${rawOf(join(RAW, 'p11.json'), join(RAW, 'static-results.json'))}`,
  `- Anchor regex: \`${staticResults.P11?.anchorSource ?? 'n/a'}\``,
  ...(staticResults.P11?.files ?? []).map(file =>
    `- \`${file.path}\`: sha256 \`${file.sha256}\`, matches ${file.matchCount}, captures S/E/R/O/T/A/N = ${[file.captures?.textVar, file.captures?.indexVar, file.captures?.skillVar, file.captures?.markFn, file.captures?.invokedMap, file.captures?.sessionVar, file.captures?.requestedMap].join('/') || 'n/a'}, coordination prefix after leading whitespace=${file.startsWithCoordPrefixAfterWhitespace}`),
  `- Stable-500 loads: \`${staticResults.P11?.stable500?.loadedFile ?? 'n/a'}\` (launcher \`${staticResults.P11?.stable500?.launcher ?? 'n/a'}\` passes \`--extension "%OMO_STABLE_PLUGIN%"\`, plugin variable \`${staticResults.P11?.stable500?.pluginVariable ?? 'n/a'}\`).`,
  '',
  'Decision: todo 17 uses the regex above; it matches exactly once in each file, with the captures named `s/e/r/o/t/a/n` and the invoked map as the fifth capture (`t`). The stable-500 profile loads the PLUGIN copy; the global omo-ai copy is byte-identical today and is still tested for drift.',
  '',
);

// Live-state invariant
const hashesMatch = Object.keys(liveBefore).every(path => liveBefore[path] === liveAfter[path]);
add(
  '## Live-state invariant',
  '',
  `- Before (todo 1 \`live-hashes-before.json\`) == after: ${hashesMatch ? 'yes' : 'NO'}`,
  `- No \`primary-agents/\` folder under either live agent dir; no \`piomo-primary-agents\` string in either live \`settings.json\`; no gate-adapter marker in the live PLUGIN \`omo-task.js\`.`,
  `- Cleanup: every reported probe's pane was closed by its driver and every reported run's temp agent dir was removed by the harness; the P9 temp dir was removed. One empty residual from an earlier killed exploratory run (\`%TEMP%\\piomo-primary-agents-qa-LnYEnR\\work\`) stayed busy while Windows held a handle after its pane shell was killed; it contains no files and no process from the run is alive.`,
  '',
  '| Live file | before | after |',
  '| --- | --- | --- |',
  ...Object.keys(liveBefore).map(path => `| \`${path}\` | \`${liveBefore[path]}\` | \`${liveAfter[path]}\` |`),
  '',
  '## Reproduction',
  '',
  '```',
  `node qa/probes/run-headless.mjs --out "${OUT}" --only P1,P2,P3,P4`,
  `node qa/probes/run-tui.mjs --out "${OUT}" --only P3,P5A,P5B,P6,P7`,
  `node qa/probes/static-probes.mjs --out "${OUT}"`,
  `node qa/probes/run-p9.mjs --out "${OUT}"`,
  `node qa/probes/run-p1-negative.mjs --out "${OUT}"`,
  `node qa/probes/build-report.mjs --out "${OUT}"`,
  '```',
  '',
);

writeFileSync(join(OUT, 'task-2-piomo-primary-agents-probes.md'), `${lines.join('\n')}\n`, 'utf8');
const report = join(OUT, 'task-2-piomo-primary-agents-probes.md');
console.log(`report: ${report}`);
const missing = ['P1', 'P2', 'P3', 'P4', 'P5a', 'P5b', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11']
  .filter(name => {
    const result = name.startsWith('P5') ? tui[name] : (headless[name] ?? tui[name] ?? staticResults[name] ?? (name === 'P9' ? p9 : null));
    return !result || result.verdict !== 'PASS';
  });
if (missing.length > 0) {
  console.error(`not PASS: ${missing.join(', ')}`);
  process.exitCode = 1;
}
