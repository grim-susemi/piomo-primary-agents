// Pure gate-adapter core: bytes in, bytes out. No fs, no network, no clocks.
//
// The installed omo-task.js input handler contains this minified branch:
//
//   if(S.startsWith("/skill:")){let E=S.indexOf(" "),R=(-1===E?S.slice(7):S.slice(7,E)).trim();
//   return O(T,A,R),void O(N,A,R)}
//
// `T` is the per-session map of invoked skills that `stateFor().hasInvoked` reads.
// The adapter inserts exactly one marked statement before that `return`:
//
//   if(R==="ulw-plan"){T.get(A)?.delete("ulw-execute")}
//
// so an owner's interactive /skill:ulw-plan request clears the session's
// ulw-execute lock. Nothing else changes.

export const ADAPTER_ID = "piomo-primary-agents/gate-adapter";
export const ADAPTER_VERSION = "v1";
export const MARKER_BEGIN = "/*piomo-primary-agents:gate-adapter:v1:begin*/";
export const MARKER_END = "/*piomo-primary-agents:gate-adapter:v1:end*/";

// Anchor regex recorded by probe P11. Capture order:
// text, space index, skill name, invoked recorder, invoked map, session id, requested recorder.
export const ANCHOR_SOURCE =
  'if\\((\\w+)\\.startsWith\\("\\/skill:"\\)\\)\\{let (\\w+)=\\1\\.indexOf\\(" "\\),(\\w+)=\\(-1===\\2\\?\\1\\.slice\\(7\\):\\1\\.slice\\(7,\\2\\)\\)\\.trim\\(\\);return (\\w+)\\((\\w+),(\\w+),\\3\\),void \\4\\((\\w+),\\6,\\3\\)\\}';

export class GateAdapterError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GateAdapterError";
    this.code = code;
    this.detail = detail;
  }
}

function asBytes(input) {
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

function occurrences(text, needle) {
  const found = [];
  let index = -1;
  while ((index = text.indexOf(needle, index + 1)) !== -1) found.push(index);
  return found;
}

export function anchorRegex() {
  return new RegExp(ANCHOR_SOURCE, "g");
}

export function anchorMatches(text) {
  return [...text.matchAll(anchorRegex())];
}

export function anchorNames(match) {
  // Groups: text, space index, skill, recorder, invoked map, session, requested map.
  const [full, textName, spaceIndexName, skillName, recorderName, mapName, sessionName, requestedMapName] = match;
  return {
    full,
    text: textName,
    spaceIndex: spaceIndexName,
    skill: skillName,
    recorder: recorderName,
    map: mapName,
    session: sessionName,
    requestedMap: requestedMapName,
  };
}

export function statementFor(match) {
  const names = anchorNames(match);
  return `if(${names.skill}==="ulw-plan"){${names.map}.get(${names.session})?.delete("ulw-execute")}`;
}

export function insertionFor(match) {
  return MARKER_BEGIN + statementFor(match) + MARKER_END;
}

/**
 * Classify bytes without changing them.
 * @param {Buffer|Uint8Array|string} input
 * @returns {{kind: "absent"|"applied"|"tampered", anchorCount: number, anchor: RegExpMatchArray|null,
 *   statement?: string, block?: string, reason?: string, bytes: Buffer}}
 */
export function inspectAdapter(input) {
  const bytes = asBytes(input);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return { kind: "tampered", anchorCount: 0, anchor: null, reason: "BYTES_NOT_UTF8", bytes };
  }
  const begins = occurrences(text, MARKER_BEGIN);
  const ends = occurrences(text, MARKER_END);
  if (begins.length === 0 && ends.length === 0) {
    const matches = anchorMatches(text);
    return { kind: "absent", anchorCount: matches.length, anchor: matches[0] ?? null, bytes };
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) {
    return {
      kind: "tampered", anchorCount: 0, anchor: null,
      reason: `MARKER_COUNT_REFUSED: begin=${begins.length} end=${ends.length}`, bytes,
    };
  }
  const blockStart = begins[0];
  const blockEnd = ends[0] + MARKER_END.length;
  const block = text.slice(blockStart, blockEnd);
  const stripped = text.slice(0, blockStart) + text.slice(blockEnd);
  const matches = anchorMatches(stripped);
  if (matches.length !== 1) {
    return {
      kind: "tampered", anchorCount: matches.length, anchor: null,
      reason: `MARKER_ANCHOR_COUNT_REFUSED: expected 1, found ${matches.length}`, bytes,
    };
  }
  const match = matches[0];
  const expectedBlock = insertionFor(match);
  if (block !== expectedBlock) {
    return {
      kind: "tampered", anchorCount: 1, anchor: match,
      reason: "MARKER_STATEMENT_REFUSED", bytes,
    };
  }
  const returnIndex = match.index + match[0].indexOf("return ");
  const expectedText = stripped.slice(0, returnIndex) + expectedBlock + stripped.slice(returnIndex);
  if (expectedText !== text) {
    return {
      kind: "tampered", anchorCount: 1, anchor: match,
      reason: "MARKER_POSITION_REFUSED", bytes,
    };
  }
  return {
    kind: "applied", anchorCount: 1, anchor: match, statement: statementFor(match), block, bytes,
  };
}

/**
 * Apply the one-statement adapter. Idempotent: already-applied bytes are
 * returned unchanged. Refuses 0 or >1 anchors and any marker tampering.
 * @param {Buffer|Uint8Array|string} input
 */
export function applyAdapter(input) {
  const bytes = asBytes(input);
  const inspection = inspectAdapter(bytes);
  if (inspection.kind === "applied") {
    return { status: "applied", bytes: Buffer.from(bytes), inspection, insertionOffset: null };
  }
  if (inspection.kind === "tampered") {
    throw new GateAdapterError("MARKER_TAMPERED", inspection.reason);
  }
  if (inspection.anchorCount !== 1) {
    throw new GateAdapterError("ANCHOR_COUNT_REFUSED", `expected 1, found ${inspection.anchorCount}`);
  }
  const match = inspection.anchor;
  const insertion = insertionFor(match);
  const text = bytes.toString("utf8");
  const returnIndex = match.index + match[0].indexOf("return ");
  const insertionOffset = Buffer.byteLength(text.slice(0, returnIndex), "utf8");
  const output = Buffer.concat([
    bytes.subarray(0, insertionOffset),
    Buffer.from(insertion, "utf8"),
    bytes.subarray(insertionOffset),
  ]);
  const verified = inspectAdapter(output);
  if (verified.kind !== "applied") {
    throw new GateAdapterError("SELF_CHECK_REFUSED", verified.reason);
  }
  return { status: "installed", bytes: output, inspection: verified, insertion, insertionOffset };
}
