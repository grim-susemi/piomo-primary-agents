// Below-input agent label.
//
// Pure layout: no SDK, no I/O, no timers. `renderLabel` returns exactly one
// line for the width the widget received:
//
//   ▌ <Name>  <modelId>[ (대기)] · <thinking>        ...        Tab 전환
//
// The bar and name carry the agent's truecolor; the model, thinking and hint
// are dim. The hint is right-aligned and dropped first when the line does not
// fit; only then is the model id shortened with an ellipsis. Wide (CJK)
// characters count as two cells so the result never exceeds `width`.
import { COLORS, DISPLAY } from '../../contract/constants.mjs';

export const BAR = '▌';
export const HINT = 'Tab 전환';
export const PENDING_SUFFIX = ' (대기)';
export const RESET = '\x1b[0m';
export const DIM = '\x1b[2m';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ELLIPSIS = '…';
const FALLBACK_COLOR = '#FFFFFF';

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(value);
}

function rgb(hex) {
  const body = hex.slice(1);
  const expanded = body.length === 3
    ? body.split('').map(char => `${char}${char}`).join('')
    : body;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

/** The agent id, display name and colour for a string id or an object. */
export function resolveAgent(agent) {
  if (agent && typeof agent === 'object') {
    const id = typeof agent.id === 'string' ? agent.id : '';
    return {
      id,
      name: typeof agent.name === 'string' ? agent.name : (DISPLAY[id] ?? id),
      color: isHexColor(agent.color) ? agent.color : (COLORS[id] ?? FALLBACK_COLOR),
    };
  }
  const id = typeof agent === 'string' ? agent : '';
  return {
    id,
    name: DISPLAY[id] ?? id,
    color: COLORS[id] ?? FALLBACK_COLOR,
  };
}

/** Strip SGR sequences from a rendered label. */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

function codePointWidth(codePoint) {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if ((codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)) return 0;
  if ((codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)) return 2;
  return 1;
}

/** Terminal cell width of plain text (SGR sequences are ignored). */
export function displayWidth(text) {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += codePointWidth(char.codePointAt(0));
  }
  return width;
}

/** Shorten plain text to at most `maxWidth` cells, marking the cut with `…`. */
export function truncateToWidth(text, maxWidth) {
  const source = String(text ?? '');
  const limit = Math.max(0, Math.floor(Number(maxWidth) || 0));
  if (limit === 0) return '';
  if (displayWidth(source) <= limit) return source;
  const ellipsisWidth = displayWidth(ELLIPSIS);
  if (limit <= ellipsisWidth) return ELLIPSIS.slice(0, limit);
  let out = '';
  let used = 0;
  for (const char of source) {
    const width = codePointWidth(char.codePointAt(0));
    if (used + width > limit - ellipsisWidth) break;
    out += char;
    used += width;
  }
  return `${out}${ELLIPSIS}`;
}

function truecolor(hex, text) {
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

/**
 * Render the one-line label.
 *
 * @param {{agent?: string|{id?: string, name?: string, color?: string}, modelId?: string, thinking?: string, pending?: boolean, width: number}} input
 * @returns {string}
 */
export function renderLabel(input = {}) {
  const options = input ?? {};
  const requested = Math.floor(Number(options.width));
  const width = Number.isFinite(requested) && requested >= 1 ? requested : 1;
  const agent = resolveAgent(options.agent);
  const model = String(options.modelId ?? '');
  const thinking = String(options.thinking ?? '');
  const pending = options.pending === true ? PENDING_SUFFIX : '';
  const hintWidth = displayWidth(HINT);
  const colored = `${BAR} ${agent.name}`;
  const coloredWidth = displayWidth(colored);
  const tail = `  ${model}${pending} · ${thinking}`;
  const left = `${colored}${tail}`;

  if (displayWidth(left) + 2 + hintWidth <= width) {
    const gap = width - displayWidth(left) - hintWidth;
    return `${truecolor(agent.color, colored)}${DIM}${tail}${' '.repeat(gap)}${HINT}${RESET}`;
  }

  // The hint is dropped first and never reintroduced on this render. Only a
  // line that is still too wide shortens the model id.
  if (displayWidth(left) > width) {
    const fixedTail = `  ${pending} · ${thinking}`;
    const available = width - coloredWidth - displayWidth(fixedTail);
    const modelText = truncateToWidth(model, Math.max(0, available));
    const shortened = `${colored}  ${modelText}${pending} · ${thinking}`;
    if (displayWidth(shortened) <= width) {
      return `${truecolor(agent.color, colored)}${DIM}  ${modelText}${pending} · ${thinking}${RESET}`;
    }
    // Pathological width: keep the colour on the bar/name prefix and clip the
    // dim tail, then the prefix itself if it cannot fit.
    if (coloredWidth >= width) {
      return truecolor(agent.color, truncateToWidth(colored, width));
    }
    return `${truecolor(agent.color, colored)}${DIM}${truncateToWidth(fixedTail, width - coloredWidth)}${RESET}`;
  }

  return `${truecolor(agent.color, colored)}${DIM}${tail}${RESET}`;
}
