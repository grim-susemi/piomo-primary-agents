// Execution-lead contract for Native plans.
//
// One owner for the plan bytes: the authoring check, the execution router and the
// tests all call these functions, so the same file cannot be classified twice with
// different answers. Pure ESM: Node built-ins only, no SDK import.

export const LEAD_ROLES = Object.freeze(['sisyphus', 'hephaestus']);
export const DEFAULT_LEAD = 'sisyphus';

const TLDR_HEADING = /^## TL;DR\b/;
const HEADING = /^## /;
const LEAD_FIELD = /^Execution lead:(.*)$/;
const RATIONALE_FIELD = /^Execution rationale:(.*)$/;
const FENCE = /^(?:```|~~~)/;

// The contract reads only the TL;DR section at column 0. Indented fields,
// fields in another section, and fields inside a fenced example are not
// declarations; a plan that never states a lead stays the legacy default.
export function tldrBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => TLDR_HEADING.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADING.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { lines: lines.slice(start + 1, end), startLine: start + 1, endLine: end };
}

export function parseExecutionLead(text) {
  const block = tldrBlock(text);
  if (!block) return { status: 'absent', lead: null, rationale: null, reason: 'tldr-missing' };

  const leads = [];
  const rationales = [];
  let fenced = false;
  for (const line of block.lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const lead = LEAD_FIELD.exec(line);
    if (lead) leads.push(lead[1].trim());
    const rationale = RATIONALE_FIELD.exec(line);
    if (rationale) rationales.push(rationale[1].trim());
  }

  if (leads.length === 0 && rationales.length === 0) {
    return { status: 'unspecified', lead: null, rationale: null };
  }
  if (leads.length > 1) return { status: 'invalid', lead: null, rationale: null, reason: 'lead-duplicate' };
  if (rationales.length > 1) {
    return { status: 'invalid', lead: null, rationale: null, reason: 'rationale-duplicate' };
  }
  if (leads.length === 0) return { status: 'invalid', lead: null, rationale: null, reason: 'lead-missing' };
  if (rationales.length === 0) {
    return { status: 'invalid', lead: null, rationale: null, reason: 'rationale-missing' };
  }
  const lead = leads[0];
  const rationale = rationales[0];
  if (!LEAD_ROLES.includes(lead)) {
    return { status: 'invalid', lead: null, rationale: null, reason: 'lead-invalid' };
  }
  if (!rationale) return { status: 'invalid', lead: null, rationale: null, reason: 'rationale-empty' };
  return { status: 'declared', lead, rationale };
}

// Unspecified (or absent) keeps the historical Sisyphus default. Invalid bytes
// do not silently resolve to a role; callers must stop before handing the plan
// to execution, exactly like the authoring check.
export function resolveExecutionLead(text) {
  const parsed = parseExecutionLead(text);
  if (parsed.status === 'declared') return { ok: true, lead: parsed.lead, rationale: parsed.rationale };
  if (parsed.status === 'unspecified' || parsed.status === 'absent') {
    return { ok: true, lead: DEFAULT_LEAD, rationale: null, defaulted: true };
  }
  return { ok: false, lead: null, rationale: null, reason: parsed.reason };
}

const unique = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value))];

// Selection order from the installed ulw-execute Phase 1: an explicit name,
// then the single active Boulder, then the single paused Boulder, then the
// single available plan. Two or more candidates are a UI choice, never a guess.
export function selectExecutionPlan({
  explicitName = null,
  activePlans = [],
  pausedPlans = [],
  availablePlans = [],
} = {}) {
  const available = unique(availablePlans);
  if (explicitName) {
    const matches = available.filter((name) => name === explicitName);
    if (matches.length === 1) return { kind: 'explicit', slug: explicitName };
    return { kind: 'blocked', reason: 'explicit-not-found' };
  }

  const active = unique(activePlans);
  if (active.length === 1) return { kind: 'active', slug: active[0] };
  if (active.length > 1) {
    const candidates = active.filter((name) => available.includes(name));
    if (candidates.length === 1) return { kind: 'active', slug: candidates[0] };
    if (candidates.length > 1) return { kind: 'choose', candidates };
  }

  const paused = unique(pausedPlans);
  if (paused.length === 1) return { kind: 'paused', slug: paused[0] };
  if (paused.length > 1) {
    const candidates = paused.filter((name) => available.includes(name));
    if (candidates.length === 1) return { kind: 'paused', slug: candidates[0] };
    if (candidates.length > 1) return { kind: 'choose', candidates };
  }

  if (available.length === 1) return { kind: 'single', slug: available[0] };
  if (available.length > 1) return { kind: 'choose', candidates: available };
  return { kind: 'new' };
}
