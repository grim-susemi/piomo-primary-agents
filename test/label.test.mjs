import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIM, HINT, RESET, displayWidth, renderLabel, stripAnsi,
} from '../src/ui/label.mjs';

const AGENT = 'sisyphus';
const MODEL = 'claude-opus-5-5';
const THINKING = 'medium';
const LEFT = '▌ Sisyphus  claude-opus-5-5 · medium';

function expected(width) {
  if (width === 40) return LEFT;
  return `${LEFT}${' '.repeat(width - displayWidth(LEFT) - displayWidth(HINT))}${HINT}`;
}

test('label: 40/60/80/120/200 are one line, fit and match the expected text', () => {
  for (const width of [40, 60, 80, 120, 200]) {
    const rendered = renderLabel({
      agent: AGENT,
      modelId: MODEL,
      thinking: THINKING,
      pending: false,
      width,
    });
    assert.equal(rendered.includes('\n'), false, `width ${width} wrapped`);
    assert.ok(displayWidth(rendered) <= width, `width ${width} exceeded at ${displayWidth(rendered)}`);
    assert.equal(stripAnsi(rendered), expected(width), `width ${width}`);
    assert.equal(rendered.endsWith(RESET), true, `width ${width} has no reset`);
  }
});

test('label: display width counts the Korean hint as four cells', () => {
  assert.equal(displayWidth(HINT), 8);
  assert.equal(displayWidth(LEFT), 36);
});

test('label: bar and name use the agent truecolor, the rest is dim', () => {
  const rendered = renderLabel({ agent: AGENT, modelId: MODEL, thinking: THINKING, width: 80 });
  assert.ok(rendered.startsWith('\x1b[38;2;0;206;209m▌ Sisyphus\x1b[0m'), rendered);
  assert.ok(rendered.includes(`${DIM}  ${MODEL} · ${THINKING}`), rendered);
  assert.ok(rendered.includes(HINT), rendered);
  assert.equal(rendered.endsWith(RESET), true, rendered);
});

test('label: hint is dropped first at 40 cells', () => {
  const rendered = renderLabel({ agent: AGENT, modelId: MODEL, thinking: THINKING, width: 40 });
  assert.equal(stripAnsi(rendered).includes(HINT), false);
  assert.equal(stripAnsi(rendered), LEFT);
});

test('label: pending marker follows the model and precedes the thinking separator', () => {
  const rendered = renderLabel({
    agent: 'prometheus',
    modelId: 'claude-fable-5-1',
    thinking: 'xhigh',
    pending: true,
    width: 80,
  });
  const plain = stripAnsi(rendered);
  assert.ok(plain.startsWith('▌ Prometheus  claude-fable-5-1 (대기) · xhigh'), plain);
  assert.equal(plain.includes('claude-fable-5-1 · xhigh'), false);
  assert.ok(displayWidth(rendered) <= 80);
  assert.equal(rendered.endsWith(RESET), true);
});

test('label: a too-wide line shortens the model id with an ellipsis', () => {
  const rendered = renderLabel({
    agent: AGENT,
    modelId: 'claude-opus-5-5-ultralong',
    thinking: THINKING,
    width: 40,
  });
  assert.equal(stripAnsi(rendered), '▌ Sisyphus  claude-opus-5-5-ul… · medium');
  assert.equal(displayWidth(rendered), 40);
  assert.equal(displayWidth(rendered) <= 40, true);
  assert.equal(rendered.endsWith(RESET), true);
});

test('label: pathological widths still stay on one line within the width', () => {
  for (const width of [1, 2, 5, 12, 20]) {
    const rendered = renderLabel({
      agent: 'prometheus',
      modelId: 'claude-fable-5-1',
      thinking: 'xhigh',
      pending: true,
      width,
    });
    assert.equal(rendered.includes('\n'), false);
    assert.ok(displayWidth(rendered) <= width, `${width}: ${JSON.stringify(stripAnsi(rendered))}`);
    assert.equal(rendered.endsWith(RESET), true);
  }
});

test('label: an agent object may override the display name and colour', () => {
  const rendered = renderLabel({
    agent: { id: 'sisyphus', name: 'Custom', color: '#112233' },
    modelId: 'm',
    thinking: 'low',
    width: 80,
  });
  assert.ok(rendered.startsWith('\x1b[38;2;17;34;51m▌ Custom\x1b[0m'), rendered);
  assert.ok(stripAnsi(rendered).startsWith('▌ Custom  m · low'));
});

test('label: invalid width is clamped instead of throwing', () => {
  for (const width of [undefined, null, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    const rendered = renderLabel({ agent: AGENT, modelId: MODEL, thinking: THINKING, width });
    assert.equal(rendered.includes('\n'), false);
    assert.ok(displayWidth(rendered) <= 1);
    assert.equal(rendered.endsWith(RESET), true);
  }
});
