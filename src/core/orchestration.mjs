// Switch orchestration for the four PiOMO primary agents.
//
// The factory registers every handler at load time. Until `session_start`
// proves this is the interactive TUI main session (todo 5 `isPrimaryMain`),
// every handler returns immediately: worker/rpc/print sessions own no state
// and never touch the branch, the model or the system prompt.
//
// Ownership (types.d.ts:1770-1959): the extension API `pi` owns
// `setSessionModel`, `setSessionThinkingLevel` and `appendEntry`; the
// extension context `ctx` owns only the live session view (`model`,
// `thinkingLevel`, `modelRegistry`, `sessionManager`, `ui`, ...).
//
// Switch order is fixed: model -> verify -> thinking -> identity entry -> label.
// Identity and tool policy switch immediately; only the model may stay pending
// until the runtime commits the next `model_change`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_IDS, DISPLAY } from '../../contract/constants.mjs';
import { atomicWriteJson } from '../../contract/atomic.mjs';
import { readLaneOverrides } from '../../contract/jsonc.mjs';
import { resolve } from '../../contract/resolve.mjs';
import {
  memoryPath, readMemory, readRoster,
} from '../../contract/schema.mjs';
import { MARKER_BEGIN } from '../gate-adapter/adapter.mjs';
import { installUi } from '../ui/install.mjs';
import { isPrimaryMain } from './gate.mjs';
import {
  createGateMirror, INTERACTIVE_SOURCE, isPlanRequest, isUlwExecute, isUlwExecuteSkillPath,
} from './gate-mirror.mjs';
import { realpathNearestAncestor, verdict } from './policy.mjs';
import { applyOverlay } from './prompt.mjs';
import {
  appendIdentity, initialCursor, isIdentityEntry, reconcileMemory, restoreAgentId,
} from './state.mjs';

export const AGENT_COMMAND = 'agent';
export const AGENT_PICKER_TITLE = '에이전트 선택';
export const ADAPTER_MISSING_NOTICE = '이 세션은 실행 기록 때문에 정식 검토가 잠겨 있어요(게이트 어댑터 미설치). 새 세션에서 계획하세요';
export const STREAMING_EXECUTE_NOTICE = '응답이 끝난 뒤 Enter를 다시 누르면 아틀라스로 실행돼요';

const RING = Object.freeze([...AGENT_IDS]);
const DEFAULT_SESSION_ID = 'default';

const REASON_TEXT = {
  'non-gpt': 'GPT 모델이 없어요',
  'not-found': '모델이 없어요',
  'unauthenticated': '인증이 없어요',
  'ambiguous': '모델 제공자가 모호해요',
  'unknown-agent': '알 수 없는 에이전트예요',
  'no-registry': '모델 레지스트리가 없어요',
};

const BLOCK_KO = {
  prometheus: '프로메테우스는 .omo 계획 문서만 수정할 수 있어요. 코드 수정은 Tab으로 다른 에이전트로 바꾼 뒤 하세요.',
  atlas: '아틀라스는 .omo 폴더 안의 파일만 수정할 수 있어요. 코드 수정은 Tab으로 다른 에이전트로 바꾼 뒤 하세요.',
};
const BLOCK_EN = {
  prometheus: 'Prometheus may only edit .omo plan files.',
  atlas: 'Atlas may only edit files under .omo.',
};

function stripNoticeLine(text) {
  const newline = text.indexOf('\n');
  return newline === -1 ? '' : text.slice(newline + 1);
}

/** Overlay bytes are loaded once, at factory time: each prompt minus its notice line. */
export function loadOverlays() {
  const overlays = {};
  for (const agentId of AGENT_IDS) {
    if (agentId === 'sisyphus') continue;
    try {
      const text = readFileSync(new URL(`../../prompts/${agentId}.md`, import.meta.url), 'utf8');
      overlays[agentId] = stripNoticeLine(text);
    } catch {
      overlays[agentId] = '';
    }
  }
  return overlays;
}

function modelIdOf(model) {
  if (!model || typeof model !== 'object') return null;
  if (typeof model.id === 'string' && model.id.length > 0) return model.id;
  if (typeof model.modelId === 'string' && model.modelId.length > 0) return model.modelId;
  return null;
}

function providerOf(model) {
  return typeof model?.provider === 'string' && model.provider.length > 0 ? model.provider : null;
}

function isAgentId(value) {
  return typeof value === 'string' && AGENT_IDS.includes(value);
}

function nextAgent(agentId) {
  const index = RING.indexOf(agentId);
  return RING[(index === -1 ? 0 : index + 1) % RING.length];
}

function reasonText(reason) {
  return REASON_TEXT[reason] ?? '사용할 수 없어요';
}

function unavailableNotice(agentId, reason) {
  return `${DISPLAY[agentId]}는 지금 사용할 수 없어요(${reasonText(reason)}).`;
}

/**
 * Live model lookup: `resolve` returns the normalized provider/id, but
 * `setSessionModel` needs the registry's model object.
 */
export function findModel(ctx, provider, modelId) {
  const registry = ctx?.modelRegistry;
  if (!registry || typeof modelId !== 'string') return null;
  if (provider && typeof registry.find === 'function') {
    const found = registry.find(provider, modelId);
    const list = Array.isArray(found) ? found : [found];
    const match = list.find(model => model && providerOf(model) === provider && modelIdOf(model) === modelId);
    if (match) return match;
  }
  const available = typeof registry.getAvailable === 'function' ? registry.getAvailable() : [];
  return available.find(model => modelIdOf(model) === modelId
    && (provider === null || provider === undefined || providerOf(model) === provider)) ?? null;
}

/** Adapter handed to `resolve` (contract/resolve.mjs): find + auth check. */
export function registryAdapter(registry) {
  const available = () => (typeof registry?.getAvailable === 'function' ? registry.getAvailable() : []);
  return {
    find(provider, modelId) {
      if (typeof provider === 'string' && provider.length > 0) {
        if (typeof registry?.find === 'function') return registry.find(provider, modelId);
        return available().find(model => providerOf(model) === provider && modelIdOf(model) === modelId);
      }
      return available().filter(model => modelIdOf(model) === modelId);
    },
    hasAuth(provider) {
      return available().some(model => providerOf(model) === provider);
    },
  };
}

const SUBMIT_WRAPPED = Symbol('piomo-submit-wrapper');

function createSubmitWrapBase(Base, handler) {
  return class SubmitWrappedEditor extends Base {
    constructor(...args) {
      super(...args);
      let hostSubmit = null;
      let wrapper = null;
      Object.defineProperty(this, 'onSubmit', {
        configurable: true,
        enumerable: true,
        get: () => {
          if (typeof hostSubmit !== 'function') return hostSubmit;
          // The host's composer-activity observer reads this getter, installs a
          // temporary wrapper and restores the value it read in a finally block.
          // Returning a fresh wrapper for our own wrapper would grow a chain on
          // every keystroke and, because the wrapper used to read the mutable
          // hostSubmit, recurse into itself on submit.
          if (hostSubmit[SUBMIT_WRAPPED] === true) return hostSubmit;
          if (wrapper === null || wrapper.hostSubmit !== hostSubmit) {
            const captured = hostSubmit;
            wrapper = (text, details) => handler(this, captured, text, details);
            wrapper[SUBMIT_WRAPPED] = true;
            wrapper.hostSubmit = captured;
          }
          return wrapper;
        },
        set: (value) => {
          hostSubmit = value;
          wrapper = null;
        },
      });
    }
  };
}

/**
 * @param {object} pi extension API
 * @param {{overlays?: Record<string,string>, mirror?: object, EditorBase?: Function}} [options]
 */
export function createOrchestrator(pi, options = {}) {
  if (!pi || typeof pi.on !== 'function') {
    throw new TypeError('createOrchestrator requires the ExtensionAPI (pi.on)');
  }

  const overlays = options.overlays ?? loadOverlays();
  const mirror = options.mirror ?? createGateMirror();
  const injectedBase = options.EditorBase;

  let active = false;
  let ctxRef = null;
  let agentDir = null;
  let homeDir = null;
  let roster = null;
  let memories = {};
  let laneOverrides = {};
  let current = 'sisyphus';
  let cursor = initialCursor('sisyphus');
  let sessionId = DEFAULT_SESSION_ID;
  let adapterPresent = false;
  let adapterNoticeSent = false;
  let uiRefresh = null;
  let pendingModel = null;
  let switching = 0;
  let chain = Promise.resolve();
  let scaffoldPath = null;
  const nonGptNotices = new Set();
  const ownEntryIds = new Set();
  const pendingThinking = new Map();

  function notify(ctx, message, type = 'info') {
    const target = ctx ?? ctxRef;
    try {
      target?.ui?.notify?.(message, type);
    } catch {
      // A closed UI must not break a session-level decision.
    }
  }

  function sessionKey() {
    const fromContext = ctxRef?.sessionManager?.getSessionId?.();
    if (typeof fromContext === 'string' && fromContext.length > 0) return fromContext;
    return sessionId;
  }

  function getBranch() {
    const branch = ctxRef?.sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : [];
  }

  function liveIdle(ctx) {
    if (typeof ctx?.isIdle !== 'function') return true;
    return ctx.isIdle() !== false;
  }

  function liveMatches(provider, modelId) {
    const model = ctxRef?.model;
    return providerOf(model) === provider && modelIdOf(model) === modelId;
  }

  function refresh() {
    try {
      uiRefresh?.();
    } catch {
      // The label is cosmetic; a failed render must not undo a committed switch.
    }
  }

  function computeAvailability() {
    const registry = ctxRef?.modelRegistry;
    if (!registry) {
      return Object.fromEntries(AGENT_IDS.map(agentId => [agentId, { unavailable: true, reason: 'no-registry' }]));
    }
    const adapter = registryAdapter(registry);
    const result = {};
    for (const agentId of AGENT_IDS) {
      result[agentId] = resolve({
        agentId,
        roster,
        memory: memories[agentId] ?? null,
        laneOverrides,
        registry: adapter,
      });
    }
    return result;
  }

  function rosterRev(agentId) {
    const rev = roster?.agents?.[agentId]?.rev;
    return Number.isInteger(rev) ? rev : 0;
  }

  function fallbackModel(agentId) {
    if (agentId === current) {
      return { provider: providerOf(ctxRef?.model), modelId: modelIdOf(ctxRef?.model) };
    }
    return null;
  }

  function writeMemoryUpdate(update) {
    if (update.agentId === 'hephaestus' && update.kind === 'model'
      && !String(update.model?.modelId ?? '').startsWith('gpt-')) {
      if (!nonGptNotices.has(update.entryId)) {
        nonGptNotices.add(update.entryId);
        notify(ctxRef, 'Hephaestus는 GPT 모델만 기억해요. 이번 세션에서만 적용돼요.', 'warning');
      }
      return;
    }

    let model;
    if (update.kind === 'model') {
      model = update.model;
    } else {
      model = memories[update.agentId]?.model ?? fallbackModel(update.agentId);
    }
    if (!model || typeof model.modelId !== 'string' || model.modelId.length === 0) {
      if (update.kind === 'thinking') pendingThinking.set(update.agentId, update.thinking);
      return;
    }

    let thinking;
    if (update.kind === 'thinking') thinking = update.thinking;
    else if (pendingThinking.has(update.agentId)) thinking = pendingThinking.get(update.agentId);
    else thinking = memories[update.agentId]?.thinking ?? null;

    if (update.kind === 'model') pendingThinking.delete(update.agentId);

    const value = {
      v: 1,
      agentId: update.agentId,
      model: { provider: model.provider ?? null, modelId: model.modelId },
      thinking: thinking ?? null,
      rosterRev: rosterRev(update.agentId),
      updatedAt: new Date().toISOString(),
    };
    if (!agentDir) return;
    try {
      atomicWriteJson(memoryPath(agentDir, update.agentId), value);
      memories[update.agentId] = value;
    } catch (error) {
      notify(ctxRef, `모델 기억을 저장하지 못했어요: ${error.message}`, 'warning');
    }
  }

  function reconcileMemoryNow() {
    if (!active || !roster) return;
    const branch = getBranch();
    const result = reconcileMemory(branch, cursor);
    cursor = result.cursor;
    for (const update of result.updates) {
      // A switch writes its own model and thinking entries before the identity
      // entry. Those entries are ours, not the owner teaching an agent; learning
      // them would attribute the new agent's model to the old one.
      if (ownEntryIds.has(update.entryId)) continue;
      writeMemoryUpdate(update);
    }
  }

  function refreshContext() {
    if (!agentDir) return;
    const rosterRead = readRoster(agentDir);
    roster = rosterRead.roster;
    const next = {};
    for (const agentId of AGENT_IDS) next[agentId] = readMemory(agentDir, agentId).memory;
    memories = next;
  }

  function completePending() {
    if (pendingModel === null) return false;
    const branch = getBranch();
    let committed = false;
    for (let index = pendingModel.fromIndex; index < branch.length; index += 1) {
      const entry = branch[index];
      if (entry?.type === 'model_change'
        && entry.provider === pendingModel.provider
        && entry.modelId === pendingModel.modelId) {
        committed = true;
        break;
      }
    }
    if (!committed && !liveMatches(pendingModel.provider, pendingModel.modelId)) return false;
    pendingModel = null;
    refresh();
    return true;
  }

  function detectAdapter(ctx) {
    const paths = Array.isArray(ctx?.loadedExtensionPaths) ? ctx.loadedExtensionPaths : [];
    const file = paths.find(path => /omo-task\.js$/i.test(String(path)));
    if (!file) return false;
    try {
      return readFileSync(file, 'utf8').includes(MARKER_BEGIN);
    } catch {
      return false;
    }
  }

  function detectScaffoldPath(ctx) {
    const paths = Array.isArray(ctx?.loadedExtensionPaths) ? ctx.loadedExtensionPaths : [];
    for (const path of paths) {
      let directory = dirname(String(path));
      for (let depth = 0; depth < 4; depth += 1) {
        const candidate = join(directory, 'skills', 'ulw-plan', 'scripts', 'scaffold-plan.mjs');
        if (existsSync(candidate)) return candidate;
        directory = dirname(directory);
      }
    }
    return null;
  }

  function observeUlwExecute() {
    mirror.ulwExecute(sessionKey());
    if (adapterPresent || adapterNoticeSent) return;
    adapterNoticeSent = true;
    notify(ctxRef, ADAPTER_MISSING_NOTICE, 'warning');
  }

  /**
   * The host records `setSessionThinkingLevel` as an explicit thinking pick, so
   * its entry is indistinguishable from the owner's Shift+Tab after the fact.
   * Mark the entries this extension created and never learn them as memory.
   */
  function setSessionThinking(level) {
    if (typeof level !== 'string' || level.length === 0) return;
    const before = getBranch().length;
    pi.setSessionThinkingLevel(level);
    const branch = getBranch();
    for (let index = before; index < branch.length; index += 1) {
      const entry = branch[index];
      if (entry?.type === 'thinking_level_change' && typeof entry.id === 'string') {
        ownEntryIds.add(entry.id);
      }
    }
  }

  async function applySessionModel(resolved, ctx) {
    const model = findModel(ctx, resolved.provider, resolved.modelId);
    if (!model) {
      notify(ctx, `${DISPLAY[current]} 모델을 찾지 못했어요.`, 'warning');
      return false;
    }
    let ok = false;
    try {
      ok = await pi.setSessionModel(model);
    } catch (error) {
      notify(ctx, `모델을 바꾸지 못했어요: ${error.message}`, 'warning');
      return false;
    }
    if (ok === false) {
      notify(ctx, `모델을 바꾸지 못했어요: ${resolved.provider}/${resolved.modelId}`, 'warning');
      return false;
    }
    if (typeof resolved.thinking === 'string') setSessionThinking(resolved.thinking);
    return true;
  }

  function blockReason(agentId, detail) {
    const ko = BLOCK_KO[agentId];
    const en = BLOCK_EN[agentId];
    if (ko && en) return `${ko} / ${en} (${detail})`;
    return `이 도구는 이 에이전트에게 막혀 있어요. / This tool is blocked for this agent. (${detail})`;
  }

  async function doSwitch(targetId, switchOptions) {
    completePending();
    refreshContext();
    reconcileMemoryNow();

    if (targetId === current) return { switched: false, reason: 'same' };

    const availability = computeAvailability();
    let destination = targetId;
    let resolved = availability[destination];

    if (switchOptions.source === 'tab' && resolved?.unavailable) {
      const skipped = [];
      let candidate = destination;
      for (let step = 0; step < AGENT_IDS.length; step += 1) {
        if (!availability[candidate]?.unavailable) break;
        skipped.push(candidate);
        candidate = nextAgent(candidate);
      }
      if (skipped.length >= AGENT_IDS.length || availability[candidate]?.unavailable) {
        notify(ctxRef, `사용할 수 있는 에이전트가 없어요(${skipped.map(id => DISPLAY[id]).join(', ')}).`, 'warning');
        return { switched: false, reason: 'unavailable' };
      }
      notify(
        ctxRef,
        `${skipped.map(id => unavailableNotice(id, availability[id].reason)).join(' ')} ${DISPLAY[candidate]}로 전환했어요.`,
        'info',
      );
      destination = candidate;
      resolved = availability[destination];
    }

    if (resolved?.unavailable) {
      notify(ctxRef, unavailableNotice(destination, resolved.reason), 'warning');
      return { switched: false, reason: 'unavailable' };
    }

    const model = findModel(ctxRef, resolved.provider, resolved.modelId);
    if (!model) {
      notify(ctxRef, `${DISPLAY[destination]} 모델을 찾지 못했어요.`, 'warning');
      return { switched: false, reason: 'model-not-found' };
    }

    let ok = false;
    try {
      ok = await pi.setSessionModel(model);
    } catch (error) {
      notify(ctxRef, `모델을 바꾸지 못했어요: ${error.message}`, 'warning');
    }
    if (ok === false) {
      notify(ctxRef, `모델을 바꾸지 못했어요: ${resolved.provider}/${resolved.modelId}`, 'warning');
    }

    // Verify the live model. A true return with an unchanged ctx.model is a
    // held switch: the label stays pending until the runtime commits it. A
    // false return is a failed switch, not a held one.
    const matches = liveMatches(resolved.provider, resolved.modelId);
    const held = ok !== false && !matches;
    pendingModel = held
      ? { provider: resolved.provider, modelId: resolved.modelId, fromIndex: 0 }
      : null;

    if (typeof resolved.thinking === 'string') setSessionThinking(resolved.thinking);

    appendIdentity(pi, destination);
    current = destination;

    if (held) pendingModel.fromIndex = getBranch().length;
    refresh();
    return { switched: true, agentId: destination, pending: held };
  }

  function switchTo(targetId, switchOptions = {}) {
    if (!isAgentId(targetId)) {
      notify(ctxRef, `알 수 없는 에이전트예요: ${String(targetId)}`, 'warning');
      return Promise.resolve({ switched: false, reason: 'unknown-agent' });
    }
    if (!active) return Promise.resolve({ switched: false, reason: 'inactive' });

    switching += 1;
    const run = chain.then(
      () => doSwitch(targetId, switchOptions),
      () => doSwitch(targetId, switchOptions),
    );
    chain = run.then(() => undefined, () => undefined);
    return run
      .catch((error) => {
        notify(ctxRef, `에이전트 전환 실패: ${error.message}`, 'error');
        return { switched: false, reason: 'error', error };
      })
      .finally(() => {
        switching -= 1;
      });
  }

  async function installSessionUi(ctx) {
    const Base = injectedBase ?? null;

    const SubmitBase = typeof Base === 'function'
      ? createSubmitWrapBase(Base, (editor, hostSubmit, text, details) => handleSubmit(editor, hostSubmit, text, details, ctx))
      : null;

    const state = {
      snapshot: () => ({
        agentId: current,
        modelId: modelIdOf(ctx.model),
        thinking: ctx.thinkingLevel,
        pending: pendingModel !== null,
      }),
      isStreaming: () => !liveIdle(ctx),
      isSwitchInFlight: () => switching > 0,
      onCycle: () => {
        void switchTo(nextAgent(current), { source: 'tab' }).catch(() => undefined);
      },
      onThinkingIntent: () => {
        completePending();
        reconcileMemoryNow();
      },
      EditorBase: SubmitBase,
      notify: (message, type) => notify(ctx, message, type),
    };

    const installed = installUi(ctx, state);
    uiRefresh = installed.refresh;
    return installed;
  }

  async function handleSubmit(editor, hostSubmit, text, details, ctx) {
    if (!active) {
      hostSubmit?.(text, details);
      return;
    }
    ctxRef = ctx;
    completePending();
    reconcileMemoryNow();

    if (isUlwExecute(text)) {
      observeUlwExecute();
      if (!liveIdle(ctx)) {
        notify(ctx, STREAMING_EXECUTE_NOTICE, 'info');
        editor?.setText?.(text);
        return;
      }
      try {
        await switchTo('atlas', { source: 'submit' });
      } finally {
        hostSubmit?.(text, details);
      }
      return;
    }

    if (isPlanRequest(text)) {
      mirror.planRequest(sessionKey());
      hostSubmit?.(text, details);
      return;
    }

    if (current === 'prometheus' && !text.startsWith('/') && mirror.needsPlanRewrite(sessionKey())) {
      mirror.planRequest(sessionKey());
      const rewritten = `/skill:ulw-plan ${text}`;
      // The host expands the submitted text from the editor's live content, so
      // update the editor before handing the rewritten command to the host.
      editor?.setText?.(rewritten);
      hostSubmit?.(rewritten, details);
      editor?.setText?.('');
      return;
    }

    hostSubmit?.(text, details);
  }

  async function onSessionStart(event, ctx) {
    ctxRef = ctx;
    active = isPrimaryMain({ sessionKind: pi.sessionKind, mode: ctx?.mode, hasUI: ctx?.hasUI });
    if (!active) return;

    agentDir = typeof ctx.agentDir === 'string' ? ctx.agentDir : null;
    homeDir = agentDir ? dirname(agentDir) : null;
    sessionId = ctx.sessionManager?.getSessionId?.() ?? DEFAULT_SESSION_ID;
    adapterPresent = detectAdapter(ctx);
    adapterNoticeSent = false;
    scaffoldPath = detectScaffoldPath(ctx);
    ownEntryIds.clear();

    refreshContext();
    laneOverrides = homeDir ? readLaneOverrides(homeDir).overrides : {};

    const branch = getBranch();
    const reason = event?.reason;
    current = reason === 'new' ? 'sisyphus' : restoreAgentId(branch);
    cursor = initialCursor(current);
    // Startup entries are not the owner teaching an agent: advance the cursor
    // without writing memory (never record memory in session_start).
    cursor = reconcileMemory(branch, cursor).cursor;
    pendingModel = null;

    const fresh = reason !== 'resume' && reason !== 'reload' && reason !== 'fork'
      && !branch.some(entry => entry?.type === 'message' || isIdentityEntry(entry));
    // Availability is computed for every agent at session start; hephaestus is
    // available only when resolve finds a GPT model for its lane.
    const availability = computeAvailability();
    if (fresh) {
      const resolved = availability[current];
      if (resolved && !resolved.unavailable) await applySessionModel(resolved, ctx);
    }

    if (ctx.mode === 'tui') {
      try {
        await installSessionUi(ctx);
      } catch (error) {
        notify(ctx, `에이전트 라벨을 설치하지 못했어요: ${error.message}`, 'warning');
      }
    }
  }

  function onInput(event, ctx) {
    if (!active) return;
    ctxRef = ctx;
    if (event?.source === INTERACTIVE_SOURCE) {
      const observed = mirror.observeInput(sessionKey(), event.text, event.source);
      if (observed.execute) {
        if (!adapterPresent && !adapterNoticeSent) {
          adapterNoticeSent = true;
          notify(ctx, ADAPTER_MISSING_NOTICE, 'warning');
        }
      }
    }
    completePending();
    reconcileMemoryNow();
  }

  function onModelSelect() {
    if (!active) return;
    // Staged only: reconciliation at input/Tab/before_agent_start/shutdown
    // decides what the owner actually taught.
    completePending();
  }

  function onBeforeAgentStart(event, ctx) {
    if (!active) return undefined;
    if (!event?.preview) {
      ctxRef = ctx;
      completePending();
      reconcileMemoryNow();
    }
    // Sisyphus is the host's own agent today. Returning a systemPrompt - even
    // the untouched base - marks it modified and drops the host's MCP
    // post-processing. Only the three overlay agents replace the prompt.
    if (current === 'sisyphus') return undefined;
    return { systemPrompt: applyOverlay(event?.systemPrompt ?? '', current, overlays) };
  }

  function onToolCall(event, ctx) {
    if (!active) return undefined;
    ctxRef = ctx;
    const cwdReal = realpathNearestAncestor(ctx?.cwd ?? process.cwd()) ?? ctx?.cwd ?? process.cwd();
    let toolSchemas = null;
    try {
      toolSchemas = typeof pi.getAllTools === 'function' ? pi.getAllTools() : null;
    } catch {
      toolSchemas = null;
    }
    const result = verdict(event?.toolName, event?.input, {
      agentId: current,
      cwdReal,
      toolSchemas,
      scaffoldPath,
    });
    if (result && result.block) {
      return { block: true, reason: blockReason(current, result.reason) };
    }
    return undefined;
  }

  function onToolResult(event, ctx) {
    if (!active) return;
    ctxRef = ctx;
    if (event?.isError) return;
    const path = event?.input?.path ?? event?.input?.file_path;
    if (!isUlwExecuteSkillPath(path)) return;
    observeUlwExecute();
  }

  function onSessionShutdown() {
    if (!active) return;
    completePending();
    reconcileMemoryNow();
    mirror.forget(sessionKey());
    active = false;
  }

  pi.on('session_start', onSessionStart);
  pi.on('input', onInput);
  pi.on('model_select', onModelSelect);
  pi.on('before_agent_start', onBeforeAgentStart, { previewSafe: true });
  pi.on('tool_call', onToolCall);
  pi.on('tool_result', onToolResult);
  pi.on('session_shutdown', onSessionShutdown);

  if (typeof pi.registerCommand === 'function') {
    pi.registerCommand(AGENT_COMMAND, {
      description: 'Switch the active primary agent',
      argumentHint: '[name]',
      handler: async (args, ctx) => {
        if (!active) return;
        ctxRef = ctx;
        refreshContext();
        reconcileMemoryNow();
        const availability = computeAvailability();
        const availableIds = AGENT_IDS.filter(agentId => !availability[agentId]?.unavailable);
        const availableNames = availableIds.map(agentId => DISPLAY[agentId]);
        const argument = String(args ?? '').trim();

        if (argument.length === 0) {
          const choice = await ctx.ui.select(AGENT_PICKER_TITLE, availableNames);
          if (choice === undefined || choice === null) return;
          const picked = AGENT_IDS.find(agentId => agentId === choice || DISPLAY[agentId] === choice);
          if (picked) await switchTo(picked, { source: 'command' });
          return;
        }

        const match = AGENT_IDS.find(agentId => agentId.toLowerCase() === argument.toLowerCase()
          || DISPLAY[agentId].toLowerCase() === argument.toLowerCase());
        if (!match) {
          const allNames = AGENT_IDS.map(agentId => DISPLAY[agentId]).join(', ');
          notify(ctx, `알 수 없는 에이전트예요: ${argument}. 사용 가능: ${allNames}`, 'warning');
          return;
        }
        await switchTo(match, { source: 'command' });
      },
    });
  }

  return {
    switchTo,
    settled: () => chain,
    get current() { return current; },
    get active() { return active; },
    snapshot: () => ({
      agentId: current,
      modelId: modelIdOf(ctxRef?.model),
      thinking: ctxRef?.thinkingLevel,
      pending: pendingModel !== null,
    }),
    availability: () => computeAvailability(),
  };
}
