// Primary-agent tool policy.
//
// PiOMO no longer restricts a planner role's tools: Prometheus keeps only its
// display name and model preset, and Atlas is retired from new selection. The
// host's own tool registration, permissions and review gates stay authoritative,
// so this module refuses only an unknown primary agent id (a corrupt or stale
// identity entry). Keeping that single guard means a malformed identity cannot
// silently inherit a permissive verdict for an id nobody defined.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AGENT_IDS } from '../../contract/constants.mjs';

const AGENT_SET = new Set(AGENT_IDS);

/**
 * Realpath of the nearest ancestor that exists, with the missing tail appended.
 * Returns null when the filesystem refuses to answer (ENOTDIR, EACCES, ...):
 * a caller that cannot resolve the parent must not treat the path as verified.
 */
export function realpathNearestAncestor(target) {
  let current = resolve(target);
  const missing = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length > 0 ? join(real, ...missing.slice().reverse()) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * @param {string} toolName
 * @param {unknown} input
 * @param {{agentId: string}} context
 * @returns {{allow: true} | {block: true, reason: string}}
 */
export function verdict(toolName, input, context = {}) {
  const { agentId } = context;
  if (!AGENT_SET.has(agentId)) {
    return { block: true, reason: `unknown agent id "${String(agentId)}"` };
  }
  return { allow: true };
}
