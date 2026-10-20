import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOverlay, stripOverlay } from '../src/core/prompt.mjs';

const BASE = 'You are the main agent.\n\nFollow the repository rules.';
const overlays = {
  prometheus: 'PROMETHEUS OVERLAY\nPlan only.',
  atlas: 'ATLAS OVERLAY\nExecute the plan.',
  hephaestus: 'HEPHAESTUS OVERLAY\nWork end to end.',
};

const BEGIN_COUNT = text => (text.match(/<!-- piomo-primary-agent:begin/g) ?? []).length;
const END_COUNT = text => (text.match(/<!-- piomo-primary-agent:end -->/g) ?? []).length;

test('prompt: sisyphus returns the stripped base unchanged', () => {
  assert.equal(applyOverlay(BASE, 'sisyphus', overlays), BASE);
  const withBlock = applyOverlay(BASE, 'prometheus', overlays);
  assert.equal(applyOverlay(withBlock, 'sisyphus', overlays), BASE);
});

test('prompt: the overlay is appended once in the marker block', () => {
  const result = applyOverlay(BASE, 'prometheus', overlays);
  assert.ok(result.startsWith(BASE));
  assert.equal(BEGIN_COUNT(result), 1);
  assert.equal(END_COUNT(result), 1);
  assert.ok(result.includes('<!-- piomo-primary-agent:begin id=prometheus -->'));
  assert.ok(result.endsWith(overlays.prometheus + '\n<!-- piomo-primary-agent:end -->'));
});

test('prompt: applying the same overlay twice equals applying it once', () => {
  const once = applyOverlay(BASE, 'prometheus', overlays);
  const twice = applyOverlay(once, 'prometheus', overlays);
  assert.equal(twice, once);
});

test('prompt: an agent change replaces the block instead of stacking', () => {
  const prometheus = applyOverlay(BASE, 'prometheus', overlays);
  const atlas = applyOverlay(prometheus, 'atlas', overlays);
  assert.equal(atlas, applyOverlay(BASE, 'atlas', overlays));
  assert.equal(BEGIN_COUNT(atlas), 1);
  assert.ok(atlas.includes('id=atlas'));
  assert.ok(!atlas.includes('PROMETHEUS OVERLAY'));
});

test('prompt: every pre-existing block is stripped first', () => {
  const stacked = [
    BASE,
    '',
    '<!-- piomo-primary-agent:begin id=prometheus -->',
    'old prometheus',
    '<!-- piomo-primary-agent:end -->',
    '',
    '<!-- piomo-primary-agent:begin id=atlas -->',
    'old atlas',
    '<!-- piomo-primary-agent:end -->',
  ].join('\n');
  const result = applyOverlay(stacked, 'hephaestus', overlays);
  assert.equal(BEGIN_COUNT(result), 1);
  assert.equal(END_COUNT(result), 1);
  assert.ok(!result.includes('old prometheus'));
  assert.ok(!result.includes('old atlas'));
  assert.equal(result, applyOverlay(BASE, 'hephaestus', overlays));
});

test('prompt: an unterminated trailing block is stripped', () => {
  const dangling = `${BASE}\n\n<!-- piomo-primary-agent:begin id=atlas -->\npartial`;
  assert.equal(stripOverlay(dangling), BASE);
  const result = applyOverlay(dangling, 'atlas', overlays);
  assert.equal(result, applyOverlay(BASE, 'atlas', overlays));
});

test('prompt: a missing overlay leaves the stripped base', () => {
  assert.equal(applyOverlay(BASE, 'atlas', {}), BASE);
  assert.equal(applyOverlay(BASE, 'atlas', undefined), BASE);
  assert.equal(applyOverlay('', 'atlas', overlays), `\n\n<!-- piomo-primary-agent:begin id=atlas -->\n${overlays.atlas}\n<!-- piomo-primary-agent:end -->`);
});
