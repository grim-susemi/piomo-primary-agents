// Handoff identity for an explicitly executed plan.
//
// The router stores the exact bytes it selected immediately before handing the
// command to the Native skill. The first Native `read` of that same file must
// return those bytes before the first `task`/`workflow` delegation is allowed:
// a file swapped between the router's last check and the skill's read is
// detected, and a read of a different plan invalidates the evidence. Pure: the
// caller owns all I/O and passes the read result in.
import { createHash } from 'node:crypto';

export function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function sha256Text(text) {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

/** SHA-256 of the exact file bytes; CRLF and LF must not collapse. */
export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createPlanHandoff({
  sessionId, path, text, sha256, role, provider, modelId, thinking,
}) {
  const body = normalizeText(text);
  return {
    sessionId,
    path,
    body,
    lines: body.split('\n'),
    sha256: sha256 ?? sha256Text(body),
    role,
    provider: provider ?? null,
    modelId: modelId ?? null,
    thinking: thinking ?? null,
    status: 'awaiting-read',
    reason: null,
    reads: new Map(),
    covered: new Set(),
  };
}

function rangeOf(input, totalLines) {
  const offset = Number.isInteger(input?.offset) && input.offset > 0 ? input.offset : 1;
  const start = Math.min(offset, Math.max(1, totalLines));
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? input.limit : null;
  const end = limit === null ? totalLines : Math.min(start + limit - 1, totalLines);
  return { start, end: Math.max(start - 1, end) };
}

/**
 * Record a read call. `samePath` is the caller's normalized comparison of the
 * read target with the selected plan; `isPlan` marks any other plan file, whose
 * read invalidates this handoff.
 * @returns {'read'|'other'|'ignored'}
 */
export function beginRead(handoff, { toolCallId, input, samePath, isPlan }) {
  if (!handoff) return 'ignored';
  if (!samePath) {
    if (isPlan) {
      handoff.status = 'failed';
      handoff.reason = 'other-plan-read';
    }
    return 'other';
  }
  const range = rangeOf(input, handoff.lines.length);
  for (let line = range.start; line <= range.end; line += 1) {
    if (handoff.covered.has(line)) {
      // Starting a re-read discards the earlier evidence for this plan.
      handoff.covered.clear();
      break;
    }
  }
  handoff.reads.set(toolCallId, range);
  if (handoff.status === 'verified') handoff.status = 'awaiting-read';
  return 'read';
}

function compareRange(handoff, range, text, details) {
  const truncation = details?.truncation;
  const truncated = truncation?.truncated === true;
  let count = range.end - range.start + 1;
  if (truncated) {
    const outputLines = Number.isInteger(truncation.outputLines) ? truncation.outputLines : 0;
    count = Math.max(0, Math.min(outputLines, count));
  }
  const expected = handoff.lines.slice(range.start - 1, range.start - 1 + count);
  let actual = normalizeText(text).split('\n');
  if (truncated) {
    actual = actual.slice(0, count);
  } else if (actual.length === expected.length + 1 && actual[actual.length - 1] === '') {
    // The tool appends one newline when it also emits a continuation notice.
    actual = actual.slice(0, -1);
  }
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) return false;
  }
  return true;
}

/**
 * Record a completed read result. `text` is the non-model-only text content of
 * the read result; `details` is the read tool's details.
 * @returns {{ok: boolean, verified: boolean, reason?: string}}
 */
export function completeRead(handoff, { toolCallId, text, details }) {
  if (!handoff) return { ok: false, verified: false, reason: 'no-handoff' };
  const range = handoff.reads.get(toolCallId);
  if (!range) return { ok: false, verified: false, reason: 'not-tracked' };
  handoff.reads.delete(toolCallId);
  if (handoff.status === 'failed') return { ok: false, verified: false, reason: handoff.reason };
  if (!compareRange(handoff, range, text, details)) {
    handoff.status = 'failed';
    handoff.reason = 'body-mismatch';
    handoff.covered.clear();
    return { ok: false, verified: false, reason: handoff.reason };
  }
  for (let line = range.start; line <= range.end; line += 1) handoff.covered.add(line);
  if (handoff.covered.size === handoff.lines.length) {
    handoff.status = 'verified';
    handoff.reason = null;
  }
  return { ok: true, verified: handoff.status === 'verified' };
}

/**
 * The first `task`/`workflow` delegation may start only with a completed,
 * matching read, no read in flight, the same plan bytes, and the live role
 * still being the one the router applied. A failure is final for this request:
 * the owner must send a new explicit execution.
 * @returns {null | {block: true, reason: string}}
 */
export function delegationVerdict(handoff, { live, fileSha }) {
  if (!handoff) return null;
  const fail = (reason) => {
    handoff.status = 'failed';
    handoff.reason = reason;
    return { block: true, reason };
  };
  if (handoff.status === 'failed') {
    return { block: true, reason: `plan handoff failed: ${handoff.reason ?? 'unknown'}` };
  }
  if (handoff.status === 'delegated') return null;
  if (handoff.reads.size > 0) return fail('read-in-flight');
  if (handoff.status !== 'verified') return fail('read-required');
  if (fileSha !== handoff.sha256) return fail('plan-changed');
  if (!live || live.role !== handoff.role
    || live.provider !== handoff.provider
    || live.modelId !== handoff.modelId
    || (handoff.thinking !== null && live.thinking !== handoff.thinking)) {
    return fail('role-changed');
  }
  handoff.status = 'delegated';
  return null;
}

export const HANDOFF_BLOCK_TEXT = {
  'read-required': '선택한 계획을 먼저 끝까지 읽어야 첫 위임을 시작할 수 있어요. 계획을 읽은 뒤 새 /ulw-execute 요청을 보내세요.',
  'read-in-flight': '계획 읽기가 끝나기 전에는 첫 위임을 시작할 수 없어요.',
  'body-mismatch': '읽은 계획 본문이 실행 시점의 계획과 달라요. 새 /ulw-execute 요청으로 다시 확인하세요.',
  'plan-changed': '실행 직전 확인한 계획 파일이 바뀌었어요. 새 /ulw-execute 요청이 필요해요.',
  'other-plan-read': '다른 계획 파일을 읽어 이 실행의 증거가 무효가 됐어요. 새 /ulw-execute 요청이 필요해요.',
  'role-changed': '실행 시점의 역할·모델과 지금 세션이 달라 첫 위임을 막았어요. 새 /ulw-execute 요청이 필요해요.',
};

export function handoffBlockReason(reason) {
  return `${HANDOFF_BLOCK_TEXT[reason] ?? '계획 인계를 확인하지 못했어요.'} (${reason})`;
}
