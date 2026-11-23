import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOverlay, stripOverlay } from '../src/core/prompt.mjs';

const BASE = 'You are the main agent.\n\nFollow the repository rules.';
const overlays = {
  hephaestus: 'HEPHAESTUS OVERLAY\nWork end to end.',
  other: 'OTHER OVERLAY\nA different role.',
};

const BEGIN_COUNT = text => (text.match(/<!-- piomo-primary-agent:begin/g) ?? []).length;
const END_COUNT = text => (text.match(/<!-- piomo-primary-agent:end -->/g) ?? []).length;

test('prompt: sisyphus returns the stripped base unchanged', () => {
  assert.equal(applyOverlay(BASE, 'sisyphus', overlays), BASE);
  const withBlock = applyOverlay(BASE, 'hephaestus', overlays);
  assert.equal(applyOverlay(withBlock, 'sisyphus', overlays), BASE);
});

test('prompt: the overlay is appended once in the marker block', () => {
  const result = applyOverlay(BASE, 'hephaestus', overlays);
  assert.ok(result.startsWith(BASE));
  assert.equal(BEGIN_COUNT(result), 1);
  assert.equal(END_COUNT(result), 1);
  assert.ok(result.includes('<!-- piomo-primary-agent:begin id=hephaestus -->'));
  assert.ok(result.endsWith(overlays.hephaestus + '\n<!-- piomo-primary-agent:end -->'));
});

test('prompt: applying the same overlay twice equals applying it once', () => {
  const once = applyOverlay(BASE, 'hephaestus', overlays);
  const twice = applyOverlay(once, 'hephaestus', overlays);
  assert.equal(twice, once);
});

test('prompt: an agent change replaces the block instead of stacking', () => {
  const hephaestus = applyOverlay(BASE, 'hephaestus', overlays);
  const other = applyOverlay(hephaestus, 'other', overlays);
  assert.equal(other, applyOverlay(BASE, 'other', overlays));
  assert.equal(BEGIN_COUNT(other), 1);
  assert.ok(other.includes('id=other'));
  assert.ok(!other.includes('HEPHAESTUS OVERLAY'));
});

test('prompt: every pre-existing block is stripped first', () => {
  const stacked = [
    BASE,
    '',
    '<!-- piomo-primary-agent:begin id=other -->',
    'old other',
    '<!-- piomo-primary-agent:end -->',
    '',
    '<!-- piomo-primary-agent:begin id=hephaestus -->',
    'old hephaestus',
    '<!-- piomo-primary-agent:end -->',
  ].join('\n');
  const result = applyOverlay(stacked, 'hephaestus', overlays);
  assert.equal(BEGIN_COUNT(result), 1);
  assert.equal(END_COUNT(result), 1);
  assert.ok(!result.includes('old other'));
  assert.ok(!result.includes('old hephaestus'));
  assert.equal(result, applyOverlay(BASE, 'hephaestus', overlays));
});

test('prompt: an unterminated trailing block is stripped', () => {
  const dangling = `${BASE}\n\n<!-- piomo-primary-agent:begin id=other -->\npartial`;
  assert.equal(stripOverlay(dangling), BASE);
  const result = applyOverlay(dangling, 'other', overlays);
  assert.equal(result, applyOverlay(BASE, 'other', overlays));
});

test('prompt: a missing overlay leaves the stripped base', () => {
  assert.equal(applyOverlay(BASE, 'other', {}), BASE);
  assert.equal(applyOverlay(BASE, 'other', undefined), BASE);
  assert.equal(applyOverlay('', 'other', overlays), `\n\n<!-- piomo-primary-agent:begin id=other -->\n${overlays.other}\n<!-- piomo-primary-agent:end -->`);
});
