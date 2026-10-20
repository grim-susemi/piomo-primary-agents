// Persona overlay for the system prompt.
//
// The base prompt is owned by the harness (and by whatever else appends to it).
// This module owns exactly one marker-delimited block: strip every existing
// block, then append the selected agent's block once. Stripping the separator
// newlines too makes the operation idempotent: applying twice equals applying
// once, and switching agents replaces the block instead of stacking them.

export const OVERLAY_BEGIN = '<!-- piomo-primary-agent:begin';
export const OVERLAY_END = '<!-- piomo-primary-agent:end -->';

const BLOCK = /(?:\r?\n){0,2}<!-- piomo-primary-agent:begin[\s\S]*?<!-- piomo-primary-agent:end -->/g;
const DANGLING_BEGIN = /(?:\r?\n){0,2}<!-- piomo-primary-agent:begin[\s\S]*$/;

/** Remove every overlay block, including an unterminated trailing one. */
export function stripOverlay(base) {
  const text = typeof base === 'string' ? base : '';
  return text.replace(BLOCK, '').replace(DANGLING_BEGIN, '');
}

/**
 * @param {string} base
 * @param {string} agentId
 * @param {Record<string, string>} overlays
 * @returns {string}
 */
export function applyOverlay(base, agentId, overlays) {
  const stripped = stripOverlay(base);
  if (agentId === 'sisyphus') return stripped;
  const overlay = overlays?.[agentId];
  if (typeof overlay !== 'string' || overlay.length === 0) return stripped;
  return `${stripped}\n\n<!-- piomo-primary-agent:begin id=${agentId} -->\n${overlay}\n<!-- piomo-primary-agent:end -->`;
}
