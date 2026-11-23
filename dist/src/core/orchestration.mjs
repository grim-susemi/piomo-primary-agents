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
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { AGENT_IDS, DISPLAY, SELECTABLE_AGENT_IDS } from '../../contract/constants.mjs';
import { atomicWriteJson } from '../../contract/atomic.mjs';
import { readLaneOverrides } from '../../contract/jsonc.mjs';
import { resolve } from '../../contract/resolve.mjs';
import {
  memoryPath, readMemory, readRoster, rosterPath,
} from '../../contract/schema.mjs';
import { MARKER_BEGIN, hasUnlockedReviewPolicy } from '../gate-adapter/adapter.mjs';
import { installUi } from '../ui/install.mjs';
import { isPrimaryMain } from './gate.mjs';
import {
  createGateMirror, INTERACTIVE_SOURCE, isUlwExecute, isUlwExecuteSkillPath,
} from './gate-mirror.mjs';
import { resolveExecutionLead, selectExecutionPlan } from './execution-plan.mjs';
import {
  beginRead, completeRead, createPlanHandoff, delegationVerdict, handoffBlockReason,
  normalizeText, sha256Bytes,
} from './plan-handoff.mjs';
import { realpathNearestAncestor, verdict } from './policy.mjs';
import { applyOverlay } from './prompt.mjs';
import {
  appendIdentity, initialCursor, isIdentityEntry, reconcileMemory, restoreAgentId,
} from './state.mjs';

export const AGENT_COMMAND = 'agent';
export const AGENT_PICKER_TITLE = '에이전트 선택';
export const ADAPTER_MISSING_NOTICE = '실행 뒤 계획 검토 허용을 확인하지 못했어요. 현재 검토 정책 또는 게이트 어댑터 설정을 확인하세요';
export const STREAMING_EXECUTE_NOTICE = '응답이 끝난 뒤 Enter를 다시 누르면 실행으로 넘어가요';
export const SUBMIT_LOCKED_NOTICE = '같은 세션의 실행 요청을 처리 중이에요. 끝난 뒤 다시 보내 주세요.';
export const EXECUTE_PICKER_TITLE = '실행할 계획 선택';
export const PLAN_BOOTSTRAP_TEXT = '/skill:ulw-plan 실행할 목표를 먼저 확인하고, 승인 요약에 시지푸스 또는 헤파이토스 총괄 한 명과 선택 이유를 제시하세요. 승인 후 완성본 TL;DR 끝에 Execution lead: sisyphus|hephaestus 중 한 값과 Execution rationale: 이유를 각각 한 줄로 기록하세요. 계획 작성 및 검토가 끝나면 /ulw-execute <slug> 명령을 안내하세요.';

const RING = Object.freeze(['sisyphus', 'hephaestus']);
const DEFAULT_SESSION_ID = 'default';

const REASON_TEXT = {
  'non-gpt': 'GPT 모델이 없어요',
  'not-found': '모델이 없어요',
  'unauthenticated': '인증이 없어요',
  'ambiguous': '모델 제공자가 모호해요',
  'unknown-agent': '알 수 없는 에이전트예요',
  'no-registry': '모델 레지스트리가 없어요',
};

function stripNoticeLine(text) {
  const newline = text.indexOf('\n');
  return newline === -1 ? '' : text.slice(newline + 1);
}

/** Overlay bytes are loaded once, at factory time: each prompt minus its notice line. */
export function loadOverlays() {
  const overlays = {};
  // Prometheus keeps only its name and model preset; its prompt overlay is gone.
  for (const agentId of ['hephaestus']) {
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
  let mainModel = null;
  let current = 'sisyphus';
  let submitLock = false;
  let pendingHandoff = null;
  let cursor = initialCursor('sisyphus');
  let sessionId = DEFAULT_SESSION_ID;
  let adapterPresent = false;
  let adapterNoticeSent = false;
  let uiRefresh = null;
  let pendingModel = null;
  let switching = 0;
  let chain = Promise.resolve();
  const nonGptNotices = new Set();
  const ownEntryIds = new Set();
  const pendingThinking = new Map();
  const pendingUpdates = [];
  const warningKeys = new Set();

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

  function fileWarning(warning, file) {
    if (!warning) return;
    const key = JSON.stringify([warning.code, file]);
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    notify(ctxRef, `${warning.code}: ${warning.message}`, 'warning');
  }

  function resolveAgent(agentId, adapter) {
    const agent = roster.agents[agentId];
    const injected = agentId === 'sisyphus' && !agent.pin && mainModel !== null;
    const effective = injected
      ? { ...roster, agents: { ...roster.agents, [agentId]: { ...agent, pin: mainModel } } }
      : roster;
    // A nonempty, impossible lane prevents the immutable resolver from walking
    // builtin chains. Memory and explicit choices never pass through the guard.
    const sentinel = { [agent.lane]: { models: [{ model: '\0piomo-no-lane' }] } };
    const memory = memories[agentId] ?? null;
    let resolved = resolve({ agentId, roster: effective, memory, laneOverrides: sentinel, registry: adapter });
    if (injected && resolved.origin === 'pin') resolved = { ...resolved, origin: 'main' };
    const skipped = [];
    const candidates = [];
    if (memory?.rosterRev === agent.rev) candidates.push(['memory', memory.model]);
    if (effective.agents[agentId].pin) {
      candidates.push([injected ? 'main' : 'pin', effective.agents[agentId].pin]);
    }
    for (const [candidate, model] of candidates) {
      // Probe only the real candidate: resolve aggregates lane failures, so an
      // artificial non-GPT sentinel would mask a GPT candidate's actual reason.
      const probe = resolve({
        agentId,
        roster: { ...roster, agents: { ...roster.agents, [agentId]: { ...agent, pin: null } } },
        memory: null,
        laneOverrides: { [agent.lane]: { models: [{
          model: model.modelId, providers: model.provider ? [model.provider] : [],
        }] } },
        registry: adapter,
      });
      if (!probe.unavailable) break;
      let reason = probe.reason;
      if (reason === 'non-gpt') {
        const found = adapter.find(model.provider, model.modelId);
        const matches = Array.isArray(found) ? found : [found];
        if (!matches.some(match => match && (!model.provider || providerOf(match) === model.provider))) {
          reason = 'not-found';
        }
      }
      skipped.push({ candidate, model, reason: reason === 'not-found' ? 'unregistered' : reason });
    }
    if (resolved.unavailable) {
      const guarded = {
        ...adapter,
        find(provider, modelId) {
          const found = adapter.find(provider, modelId);
          const allowed = model => {
            if (providerOf(model) !== 'opencode-go' || /^muse(?:-|$)/i.test(modelId)) return true;
            skipped.push({
              candidate: 'lane', model: { provider: 'opencode-go', modelId }, reason: 'Muse-only lane',
            });
            return false;
          };
          return Array.isArray(found) ? found.filter(allowed) : (found && allowed(found) ? found : null);
        },
      };
      resolved = resolve({
        agentId,
        roster: { ...roster, agents: { ...roster.agents, [agentId]: { ...agent, pin: null } } },
        memory: null, laneOverrides, registry: guarded,
      });
    }
    for (const { candidate, model, reason } of skipped) {
      const name = `${model.provider ?? '?'}/${model.modelId}`;
      const key = JSON.stringify([agentId, candidate, name, reason]);
      if (warningKeys.has(key)) continue;
      warningKeys.add(key);
      const used = resolved.unavailable ? 'no usable model' : `${resolved.provider}/${resolved.modelId}`;
      notify(ctxRef, `${DISPLAY[agentId]} ${candidate} ${name}: ${reason}; using ${used}. Check the model registration, authentication or board selection.`, 'warning');
    }
    return resolved;
  }

  function computeAvailability() {
    const registry = ctxRef?.modelRegistry;
    if (!registry) {
      return Object.fromEntries(AGENT_IDS.map(agentId => [agentId, { unavailable: true, reason: 'no-registry' }]));
    }
    const adapter = registryAdapter(registry);
    const result = {};
    for (const agentId of AGENT_IDS) {
      result[agentId] = resolveAgent(agentId, adapter);
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
      rosterRev: update.rosterRev,
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
      const index = branch.findIndex(entry => entry.id === update.entryId);
      const stagedIndex = pendingUpdates.findLastIndex(pending => pending.agentId === update.agentId
        && pending.kind === update.kind && pending.fromIndex <= index);
      const staged = stagedIndex === -1 ? null : pendingUpdates.splice(stagedIndex, 1)[0];
      writeMemoryUpdate({ ...update, rosterRev: staged?.rosterRev ?? rosterRev(update.agentId) });
    }
  }

  function stageSelection(kind) {
    // Capture the board revision before the host commits this selection. A
    // later board edit must invalidate it even if reconciliation happens later.
    const read = readRoster(agentDir);
    roster = read.roster;
    fileWarning(read.warning, rosterPath(agentDir));
    pendingUpdates.push({ agentId: current, kind, rosterRev: rosterRev(current), fromIndex: getBranch().length });
  }

  function refreshContext() {
    if (!agentDir) return;
    const rosterRead = readRoster(agentDir);
    roster = rosterRead.roster;
    fileWarning(rosterRead.warning, rosterPath(agentDir));
    const next = {};
    for (const agentId of AGENT_IDS) {
      const read = readMemory(agentDir, agentId);
      next[agentId] = read.memory;
      fileWarning(read.warning, memoryPath(agentDir, agentId));
    }
    memories = next;
    const file = join(agentDir, 'settings.json');
    mainModel = null;
    try {
      const settings = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof settings.defaultModel === 'string' && settings.defaultModel.length > 0) {
        const slash = settings.defaultModel.indexOf('/');
        mainModel = slash > 0
          ? { provider: settings.defaultModel.slice(0, slash), modelId: settings.defaultModel.slice(slash + 1), thinking: settings.defaultThinkingLevel ?? null }
          : { provider: settings.defaultProvider ?? null, modelId: settings.defaultModel, thinking: settings.defaultThinkingLevel ?? null };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') fileWarning({ code: 'SETTINGS_INVALID', message: `${file}: ${error.message}` }, file);
    }
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
      const text = readFileSync(file, 'utf8');
      return text.includes(MARKER_BEGIN) || hasUnlockedReviewPolicy(text);
    } catch {
      return false;
    }
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
    return `이 도구는 ${DISPLAY[agentId] ?? agentId}에게 막혀 있어요. / This tool is blocked for this agent. (${detail})`;
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
      for (let step = 0; step < RING.length; step += 1) {
        if (!availability[candidate]?.unavailable) break;
        skipped.push(candidate);
        candidate = nextAgent(candidate);
      }
      if (skipped.length >= RING.length || availability[candidate]?.unavailable) {
        notify(ctxRef, `사용할 수 있는 에이전트가 없어요(${skipped.map(id => DISPLAY[id]).join(', ')}).`, 'warning');
        return { switched: false, reason: 'unavailable' };
      }
      if (candidate === current) {
        notify(ctxRef, unavailableNotice(destination, resolved.reason), 'info');
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
      // IS-4: Hephaestus is entered only on GPT. A refused or thrown switch
      // leaves the previous non-GPT model live, so entering would install the
      // Hephaestus identity and overlay on a non-GPT model.
      if (destination === 'hephaestus') {
        notify(ctxRef, `모델을 바꾸지 못했어요: ${error.message}`, 'warning');
        return { switched: false, reason: 'model-switch-failed' };
      }
      notify(ctxRef, `모델을 바꾸지 못했어요: ${error.message}`, 'warning');
    }
    if (ok === false) {
      if (destination === 'hephaestus') {
        notify(ctxRef, `모델을 바꾸지 못했어요: ${resolved.provider}/${resolved.modelId}`, 'warning');
        return { switched: false, reason: 'model-switch-failed' };
      }
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
        const leavingWorkflow = !RING.includes(current);
        const target = leavingWorkflow ? 'sisyphus' : nextAgent(current);
        void switchTo(target, { source: 'tab' }).catch(() => undefined);
      },
      onThinkingIntent: () => {
        completePending();
        reconcileMemoryNow();
        stageSelection('thinking');
      },
      EditorBase: SubmitBase,
      notify: (message, type) => notify(ctx, message, type),
    };

    const installed = installUi(ctx, state);
    uiRefresh = installed.refresh;
    return installed;
  }

  const slashed = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase();

  function planSlugs(cwd) {
    try {
      return readdirSync(join(cwd, '.omo', 'plans'), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => entry.name.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  }

  function boulderPlans(cwd, id) {
    let works;
    try {
      works = JSON.parse(readFileSync(join(cwd, '.omo', 'boulder.json'), 'utf8'))?.works;
    } catch {
      return { active: [], paused: [] };
    }
    if (!works || typeof works !== 'object' || Array.isArray(works)) return { active: [], paused: [] };
    const own = `senpi:${id}`;
    const active = new Set();
    const paused = new Set();
    for (const work of Object.values(works)) {
      if (!work || typeof work !== 'object') continue;
      if (!Array.isArray(work.session_ids) || !work.session_ids.includes(own)) continue;
      const rawName = typeof work.plan_name === 'string' && work.plan_name.length > 0
        ? work.plan_name
        : (typeof work.active_plan === 'string' && work.active_plan.length > 0
          ? basename(work.active_plan, '.md') : null);
      const planName = typeof rawName === 'string' ? rawName.replace(/\.md$/i, '') : null;
      if (!planName) continue;
      if (work.status === 'active') active.add(planName);
      else if (work.status === 'paused') paused.add(planName);
    }
    return { active: [...active].sort(), paused: [...paused].sort() };
  }

  function parseExecute(text) {
    const command = ['/skill:ulw-execute', '/ulw-execute']
      .find(prefix => text === prefix || text.startsWith(`${prefix} `));
    if (!command) return null;
    const rest = text.slice(command.length).trim();
    const tokens = rest.length === 0 ? [] : rest.split(/\s+/);
    let nameIndex = -1;
    for (let index = 0; index < tokens.length; index += 1) {
      if (!tokens[index].startsWith('-')) { nameIndex = index; break; }
    }
    const name = nameIndex === -1 ? null : tokens[nameIndex];
    const options = nameIndex === -1 ? tokens : tokens.filter((_, index) => index !== nameIndex);
    return { command, name, options };
  }

  function planPath(cwd, slug) {
    const raw = join(cwd, '.omo', 'plans', `${slug}.md`);
    const normalized = realpathNearestAncestor(raw) ?? resolvePath(raw);
    let bytes;
    try {
      bytes = readFileSync(raw);
    } catch {
      return null;
    }
    const text = normalizeText(bytes.toString('utf8'));
    return { raw, path: normalized, text, sha256: sha256Bytes(bytes) };
  }

  function planTextAt(path) {
    try {
      return sha256Bytes(readFileSync(path));
    } catch {
      return null;
    }
  }

  function isPlanPath(candidate, cwd) {
    if (typeof candidate !== 'string') return false;
    const normalized = slashed(realpathNearestAncestor(candidate) ?? resolvePath(candidate));
    const dir = slashed(realpathNearestAncestor(join(cwd, '.omo', 'plans')) ?? resolvePath(join(cwd, '.omo', 'plans')));
    return normalized.startsWith(`${dir}/`) && normalized.endsWith('.md');
  }

  function executeBlockedNotice(selection) {
    if (selection.reason === 'explicit-not-found') {
      return '명시한 계획을 찾지 못했어요. 다른 계획으로 대체하지 않았어요.';
    }
    if (selection.reason === 'explicit-duplicate') {
      return '같은 이름의 계획이 여러 개라 실행하지 않았어요.';
    }
    return `계획 선택을 막았어요(${selection.reason}).`;
  }

  function observeHandoffReadCall(event, ctx) {
    if (!pendingHandoff) return;
    const input = event?.input ?? {};
    const path = input.path ?? input.file_path;
    if (typeof path !== 'string') return;
    const cwd = ctx?.cwd ?? process.cwd();
    const samePath = slashed(realpathNearestAncestor(path) ?? resolvePath(path))
      === slashed(pendingHandoff.path);
    const planRead = !samePath && isPlanPath(path, cwd);
    const action = beginRead(pendingHandoff, {
      toolCallId: event?.toolCallId,
      input,
      samePath,
      isPlan: planRead,
    });
    if (action === 'other' && planRead) {
      notify(ctx, handoffBlockReason('other-plan-read'), 'warning');
    }
  }

  function observeHandoffReadResult(event, ctx) {
    if (!pendingHandoff || !pendingHandoff.reads.has(event?.toolCallId)) return;
    const parts = Array.isArray(event?.content) ? event.content : [];
    const text = parts
      .filter(part => part && part.type === 'text' && part.audience !== 'model')
      .map(part => part.text ?? '')
      .join('\n');
    const result = completeRead(pendingHandoff, {
      toolCallId: event?.toolCallId,
      text,
      details: event?.details,
    });
    if (!result.ok && result.reason === 'body-mismatch') {
      notify(ctx, handoffBlockReason('body-mismatch'), 'warning');
    }
  }

  function handoffDelegationBlock(ctx) {
    if (!pendingHandoff) return null;
    const live = {
      role: current,
      provider: providerOf(ctx?.model),
      modelId: modelIdOf(ctx?.model),
      thinking: ctx?.thinkingLevel ?? null,
    };
    const block = delegationVerdict(pendingHandoff, {
      live,
      fileSha: planTextAt(pendingHandoff.path),
    });
    if (!block) return null;
    const reason = handoffBlockReason(pendingHandoff.reason ?? 'read-required');
    notify(ctx, reason, 'warning');
    return { block: true, reason };
  }

  async function handleSubmit(editor, hostSubmit, text, details, ctx) {
    if (!active) {
      hostSubmit?.(text, details);
      return;
    }
    ctxRef = ctx;
    completePending();
    reconcileMemoryNow();

    if (!isUlwExecute(text)) {
      hostSubmit?.(text, details);
      return;
    }
    if (!liveIdle(ctx)) {
      notify(ctx, STREAMING_EXECUTE_NOTICE, 'info');
      editor?.setText?.(text);
      return;
    }
    if (submitLock) {
      notify(ctx, SUBMIT_LOCKED_NOTICE, 'info');
      return;
    }
    submitLock = true;
    const original = text;
    try {
      const parsed = parseExecute(original);
      if (!parsed) {
        hostSubmit?.(original, details);
        return;
      }
      const cwd = ctx?.cwd ?? process.cwd();
      const boulder = boulderPlans(cwd, sessionKey());
      const selection = selectExecutionPlan({
        explicitName: parsed.name,
        activePlans: boulder.active,
        pausedPlans: boulder.paused,
        availablePlans: planSlugs(cwd),
      });
      if (selection.kind === 'new') {
        // No selectable plan: hand the Native plan bootstrap the literal request once.
        editor?.setText?.(PLAN_BOOTSTRAP_TEXT);
        hostSubmit?.(PLAN_BOOTSTRAP_TEXT, details);
        editor?.setText?.('');
        return;
      }
      if (selection.kind === 'blocked') {
        notify(ctx, executeBlockedNotice(selection), 'warning');
        editor?.setText?.(original);
        return;
      }
      let slug = selection.slug;
      if (selection.kind === 'choose') {
        const choice = await ctx?.ui?.select?.(EXECUTE_PICKER_TITLE, selection.candidates);
        if (typeof choice !== 'string' || !selection.candidates.includes(choice)) {
          notify(ctx, '계획 선택을 취소해 실행하지 않았어요.', 'info');
          editor?.setText?.(original);
          return;
        }
        slug = choice;
      }
      const plan = planPath(cwd, slug);
      if (!plan) {
        notify(ctx, `계획 파일을 읽지 못했어요: ${slug}`, 'warning');
        editor?.setText?.(original);
        return;
      }
      const lead = resolveExecutionLead(plan.text);
      if (!lead.ok) {
        notify(ctx, `계획의 실행 책임자 선언이 무효예요(${lead.reason}). 실행하지 않았어요.`, 'warning');
        editor?.setText?.(original);
        return;
      }
      const resolved = computeAvailability()[lead.lead];
      if (!resolved || resolved.unavailable) {
        notify(ctx, `${DISPLAY[lead.lead]} 역할의 모델을 사용할 수 없어 실행을 넘기지 않았어요.`, 'warning');
        editor?.setText?.(original);
        return;
      }
      const switched = await switchTo(lead.lead, { source: 'submit' });
      if ((!switched.switched && switched.reason !== 'same') || switched.pending) {
        notify(ctx, `${DISPLAY[lead.lead]} 역할·모델을 적용하지 못해 실행을 넘기지 않았어요.`, 'warning');
        editor?.setText?.(original);
        return;
      }
      if (switched.reason === 'same') {
        // The role already matches; still make sure the live model and thinking
        // are the ones this role resolves to before handing the plan over.
        const applied = await applySessionModel(resolved, ctx);
        if (!applied) {
          notify(ctx, `${DISPLAY[lead.lead]} 역할·모델을 적용하지 못해 실행을 넘기지 않았어요.`, 'warning');
          editor?.setText?.(original);
          return;
        }
      }
      if (current !== lead.lead
        || !liveMatches(resolved.provider, resolved.modelId)
        || (typeof resolved.thinking === 'string' && ctx.thinkingLevel !== resolved.thinking)) {
        notify(ctx, '역할·모델이 실제 세션에 적용되지 않아 실행을 넘기지 않았어요.', 'warning');
        editor?.setText?.(original);
        return;
      }
      const final = planPath(cwd, slug);
      if (!final || final.sha256 !== plan.sha256 || final.path !== plan.path) {
        notify(ctx, '계획 파일이 실행 직전에 바뀌어 실행을 넘기지 않았어요. 새 /ulw-execute 요청으로 다시 확인하세요.', 'warning');
        editor?.setText?.(original);
        return;
      }
      pendingHandoff = createPlanHandoff({
        sessionId: sessionKey(),
        path: final.path,
        text: final.text,
        sha256: final.sha256,
        role: lead.lead,
        provider: resolved.provider,
        modelId: resolved.modelId,
        thinking: typeof resolved.thinking === 'string' ? resolved.thinking : ctx.thinkingLevel,
      });
      const command = `${parsed.command} ${slug}${parsed.options.length > 0 ? ` ${parsed.options.join(' ')}` : ''}`;
      editor?.setText?.(command);
      hostSubmit?.(command, details);
      editor?.setText?.('');
    } finally {
      submitLock = false;
    }
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
    ownEntryIds.clear();
    pendingUpdates.length = 0;
    warningKeys.clear();

    refreshContext();
    const lanes = homeDir ? readLaneOverrides(homeDir) : { overrides: {}, warning: null };
    laneOverrides = lanes.overrides;
    fileWarning(lanes.warning, join(homeDir ?? '', 'omo.jsonc'));

    const branch = getBranch();
    const reason = event?.reason;
    current = reason === 'new' ? 'sisyphus' : restoreAgentId(branch);
    if (current === 'atlas') {
      // Atlas is retired from new selection. A resumed legacy session keeps its
      // work IDs and checkpoints; the role moves to the legacy default.
      current = 'sisyphus';
      try {
        appendIdentity(pi, 'sisyphus');
      } catch {
        // A host without appendEntry still gets the in-memory migration.
      }
    }
    submitLock = false;
    pendingHandoff = null;
    cursor = initialCursor(current);
    // Startup entries are not the owner teaching an agent: advance the cursor
    // without writing memory (never record memory in session_start).
    cursor = reconcileMemory(branch, cursor).cursor;
    pendingModel = null;

    const fresh = reason !== 'resume' && reason !== 'reload' && reason !== 'fork'
      && !branch.some(entry => entry?.type === 'message' || isIdentityEntry(entry));
    const registry = ctxRef?.modelRegistry;
    if (fresh && registry) {
      const resolved = resolveAgent(current, registryAdapter(registry));
      if (!resolved.unavailable
        && (resolved.origin !== 'main' || !liveMatches(resolved.provider, resolved.modelId))) {
        // With no configured choice, preserve the host's startup default.
        if (mainModel || roster.agents[current].pin || memories[current]) await applySessionModel(resolved, ctx);
      }
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

  function onModelSelect(event) {
    if (!active) return;
    // Staged only: reconciliation at input/Tab/before_agent_start/shutdown
    // decides what the owner actually taught.
    completePending();
    if (event?.source === 'extension' || event?.source === 'rpc') return;
    stageSelection('model');
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
    // post-processing. Only Hephaestus keeps an overlay; Prometheus keeps its
    // name and model preset but no prompt of its own.
    if (current === 'sisyphus' || !overlays[current]) return undefined;
    return { systemPrompt: applyOverlay(event?.systemPrompt ?? '', current, overlays) };
  }

  function onToolCall(event, ctx) {
    if (!active) return undefined;
    ctxRef = ctx;
    const name = String(event?.toolName ?? '');
    if (pendingHandoff) {
      if (name === 'read') {
        observeHandoffReadCall(event, ctx);
      } else if (name === 'task' || name === 'workflow') {
        const blocked = handoffDelegationBlock(ctx);
        if (blocked) return blocked;
      }
    }
    const result = verdict(name, event?.input, { agentId: current });
    if (result && result.block) {
      return { block: true, reason: blockReason(current, result.reason) };
    }
    return undefined;
  }

  function onToolResult(event, ctx) {
    if (!active) return;
    ctxRef = ctx;
    if (event?.isError) {
      if (pendingHandoff && event?.toolName === 'read') pendingHandoff.reads.delete(event.toolCallId);
      if (pendingHandoff && pendingHandoff.status === 'delegated'
        && (event?.toolName === 'task' || event?.toolName === 'workflow')) {
        // A failed delegation does not discard the check: the retry must pass
        // the same read, hash and role checks again.
        pendingHandoff.status = 'verified';
      }
      return;
    }
    if (pendingHandoff && event?.toolName === 'read') observeHandoffReadResult(event, ctx);
    // The handoff check stays until the first real delegation succeeds; a
    // failed delegation keeps the evidence so a retry still has to match it.
    if (pendingHandoff && pendingHandoff.status === 'delegated'
      && (event?.toolName === 'task' || event?.toolName === 'workflow')) {
      pendingHandoff = null;
    }
    const path = event?.input?.path ?? event?.input?.file_path;
    if (!isUlwExecuteSkillPath(path)) return;
    observeUlwExecute();
  }

  function onSessionShutdown() {
    if (!active) return;
    completePending();
    reconcileMemoryNow();
    mirror.forget(sessionKey());
    pendingHandoff = null;
    submitLock = false;
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
        const availableIds = SELECTABLE_AGENT_IDS.filter(agentId => !availability[agentId]?.unavailable);
        const availableNames = availableIds.map(agentId => DISPLAY[agentId]);
        const argument = String(args ?? '').trim();

        if (argument.length === 0) {
          const choice = await ctx.ui.select(AGENT_PICKER_TITLE, availableNames);
          if (choice === undefined || choice === null) return;
          const picked = SELECTABLE_AGENT_IDS.find(agentId => agentId === choice || DISPLAY[agentId] === choice);
          if (picked) await switchTo(picked, { source: 'command' });
          return;
        }

        if (argument.toLowerCase() === 'atlas' || argument.toLowerCase() === DISPLAY.atlas.toLowerCase()) {
          notify(ctx, 'Atlas는 퇴역했어요. 새 선택은 지원하지 않아요.', 'warning');
          return;
        }

        const match = SELECTABLE_AGENT_IDS.find(agentId => agentId.toLowerCase() === argument.toLowerCase()
          || DISPLAY[agentId].toLowerCase() === argument.toLowerCase());
        if (!match) {
          const allNames = SELECTABLE_AGENT_IDS.map(agentId => DISPLAY[agentId]).join(', ');
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
