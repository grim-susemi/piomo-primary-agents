// Session identity and per-agent model memory.
//
// Identity is a custom session entry, so it travels with the session file and
// branches (and sub-branches) keep their own history:
//
//   pi.appendEntry("primary-agent/v1", { schemaVersion: 1, agentId })
//
// Restore reads only the branch handed in by the caller
// (`ctx.sessionManager.getBranch()`), never `previousSessionFile`: a resumed
// session must not inherit an agent from an unrelated earlier file.
//
// Model memory has provenance. `model_select` fires before the switch is
// committed, and a `model_change` entry records who caused it. P3 (todo 2)
// measured `source: "command" | "picker" | "cycle"` for the owner's own
// switches and `source: "extension"` for `setSessionModel`; only the first
// three are learned. Thinking changes record `thinkingSelection.source`
// ("explicit" for Shift+Tab) and no trigger; entries carrying a
// `triggerSource`/`triggerActor` are somebody else's switch and are ignored.
import { AGENT_IDS, THINKING } from '../../contract/constants.mjs';

export const IDENTITY_ENTRY_TYPE = 'primary-agent/v1';
export const IDENTITY_SCHEMA_VERSION = 1;
export const DEFAULT_AGENT_ID = 'sisyphus';
export const LEARNED_MODEL_SOURCES = Object.freeze(['command', 'picker', 'cycle']);
export const LEARNED_THINKING_SOURCES = Object.freeze(['explicit', 'editor']);

const MODEL_SOURCE_SET = new Set(LEARNED_MODEL_SOURCES);
const THINKING_SOURCE_SET = new Set(LEARNED_THINKING_SOURCES);
const THINKING_SET = new Set(THINKING);
const AGENT_SET = new Set(AGENT_IDS);

export function isAgentId(value) {
  return typeof value === 'string' && AGENT_SET.has(value);
}

/** The payload written by every identity entry. */
export function identityData(agentId) {
  if (!isAgentId(agentId)) throw new RangeError(`unknown agent id "${String(agentId)}"`);
  return { schemaVersion: IDENTITY_SCHEMA_VERSION, agentId };
}

export function isIdentityEntry(entry) {
  return entry?.type === 'custom' && entry.customType === IDENTITY_ENTRY_TYPE;
}

/** A valid identity payload, or null when the entry is malformed. */
export function readIdentity(entry) {
  if (!isIdentityEntry(entry)) return null;
  const data = entry.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.schemaVersion !== IDENTITY_SCHEMA_VERSION) return null;
  if (!isAgentId(data.agentId)) return null;
  return { schemaVersion: IDENTITY_SCHEMA_VERSION, agentId: data.agentId };
}

/**
 * Append (or overwrite the leaf state with) the identity entry for an agent.
 *
 * @param {{appendEntry: (type: string, data: unknown) => unknown}} pi
 * @param {string} agentId
 */
export function appendIdentity(pi, agentId) {
  if (typeof pi?.appendEntry !== 'function') throw new TypeError('pi.appendEntry is required');
  return pi.appendEntry(IDENTITY_ENTRY_TYPE, identityData(agentId));
}

/**
 * The agent restored from the session's own branch: the last identity entry on
 * that branch. A malformed last entry (or no entry) means `sisyphus`.
 *
 * `options.previousSessionFile` is accepted and deliberately ignored: restore
 * never reads another session file.
 *
 * @param {readonly object[]} branch
 * @param {{previousSessionFile?: string}} [options]
 * @returns {string}
 */
export function restoreAgentId(branch, options = {}) {
  void options;
  if (!Array.isArray(branch)) return DEFAULT_AGENT_ID;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isIdentityEntry(entry)) continue;
    const identity = readIdentity(entry);
    return identity ? identity.agentId : DEFAULT_AGENT_ID;
  }
  return DEFAULT_AGENT_ID;
}

function agentBefore(entries, end) {
  for (let index = end - 1; index >= 0; index -= 1) {
    const identity = readIdentity(entries[index]);
    if (identity) return identity.agentId;
  }
  return null;
}

/** The starting cursor for a session: nothing consumed, no active agent yet. */
export function initialCursor(agentId = null) {
  return { index: 0, agentId: isAgentId(agentId) ? agentId : null };
}

function isLearnableThinking(entry) {
  if (entry?.type !== 'thinking_level_change') return false;
  // A trigger is another actor's switch (command/rpc/extension/...).
  if (entry.triggerSource !== undefined || entry.triggerActor !== undefined) return false;
  const selection = entry.thinkingSelection;
  if (!selection || typeof selection !== 'object') return false;
  if (selection.level !== entry.thinkingLevel) return false;
  if (!THINKING_SOURCE_SET.has(selection.source)) return false;
  return THINKING_SET.has(entry.thinkingLevel);
}

function isLearnableModel(entry) {
  return entry?.type === 'model_change'
    && MODEL_SOURCE_SET.has(entry.source)
    && typeof entry.provider === 'string' && entry.provider.length > 0
    && typeof entry.modelId === 'string' && entry.modelId.length > 0;
}

/**
 * Reconcile a cursor over the session's committed branch and report what the
 * owner taught each agent. Pure: the caller writes the reported memory rows.
 *
 * @param {readonly object[]} branch entries from `getBranch()`, oldest first
 * @param {{index?: number, agentId?: string|null}} [cursor]
 * @returns {{cursor: {index: number, agentId: string|null}, updates: object[]}}
 */
export function reconcileMemory(branch, cursor = {}) {
  const entries = Array.isArray(branch) ? branch : [];
  const rawIndex = Number.isInteger(cursor?.index) && cursor.index >= 0 ? cursor.index : 0;
  const start = Math.min(rawIndex, entries.length);
  // Trust the committed branch first; a compacted branch may no longer hold the
  // identity entry, so fall back to the cursor's last known agent.
  const scanned = agentBefore(entries, start);
  let agentId = scanned ?? (isAgentId(cursor?.agentId) ? cursor.agentId : null);
  const updates = [];

  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    const identity = readIdentity(entry);
    if (identity) {
      agentId = identity.agentId;
      continue;
    }
    if (agentId === null) continue;
    if (isLearnableModel(entry)) {
      updates.push({
        agentId,
        kind: 'model',
        model: { provider: entry.provider, modelId: entry.modelId },
        entryId: entry.id,
      });
      continue;
    }
    if (isLearnableThinking(entry)) {
      updates.push({
        agentId,
        kind: 'thinking',
        thinking: entry.thinkingLevel,
        entryId: entry.id,
      });
    }
  }

  return { cursor: { index: entries.length, agentId }, updates };
}
