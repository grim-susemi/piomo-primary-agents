import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER_BEGIN, MARKER_END } from "../src/gate-adapter/adapter.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "scripts", "gate-adapter.mjs");

// Probe P11 fixtures. Tests copy these before touching anything; the source
// files are read-only inputs and are hashed again at the end of this file.
const FIXTURES = {
  stable: process.env.PIOMO_GATE_TARGET_STABLE
    ?? "C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.38-r1/package/plugin/extensions/omo-task.js",
  global: process.env.PIOMO_GATE_TARGET_GLOBAL
    ?? "C:/Users/USER/.bun/install/global/node_modules/omo-ai/plugin/extensions/omo-task.js",
  stock: process.env.PIOMO_GATE_TARGET_STOCK
    ?? "C:/Users/USER/.omo-stable-500/staging/upgrade-5.1.38/pristine-omo-ai/plugin/extensions/omo-task.js",
};
const P11_ADAPTED_SHA256 = "2b559bb11f0285072722cffbb7f322756c81aec867f6fb4a683278f075d7f783";
const COORDINATION_BASELINE_SHA256 = "36d98c7ab3cc07349b60adc8bc7365a85e7573653ebab574d0114c2571d53dcd";

// Independent copy of the P11 anchor regex. It is deliberately not imported
// from the adapter, so this file is an oracle rather than a mirror.
const P11_ANCHOR = /if\((\w+)\.startsWith\("\/skill:"\)\)\{let (\w+)=\1\.indexOf\(" "\),(\w+)=\(-1===\2\?\1\.slice\(7\):\1\.slice\(7,\2\)\)\.trim\(\);return (\w+)\((\w+),(\w+),\3\),void \4\((\w+),\6,\3\)\}/g;

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaFile = (file) => digest(readFileSync(file));

function source(name) {
  const file = FIXTURES[name];
  assert.ok(existsSync(file), `P11 fixture missing: ${file}`);
  return file;
}

function anchorMatches(text) {
  return [...text.matchAll(new RegExp(P11_ANCHOR.source, "g"))];
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "piomo-gate-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

function copyFixture(root, name, subdir = name) {
  const directory = join(root, subdir);
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "omo-task.js");
  copyFileSync(source(name), target);
  // node --check reads the nearest package.json to decide ESM vs CJS.
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  return target;
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
  const stdoutLine = result.stdout.trim().split(/\r?\n/).at(-1);
  const stderrLine = result.stderr.trim().split(/\r?\n/).at(-1);
  let json = null;
  try { json = JSON.parse(stdoutLine); } catch {
    try { json = JSON.parse(stderrLine); } catch { /* refusal tests assert on raw output */ }
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json, error: result.error };
}

function checkSyntax(target) {
  return spawnSync(process.execPath, ["--check", target], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
}

function expectedInsertion(bytes) {
  const text = bytes.toString("utf8");
  const [match] = anchorMatches(text);
  assert.ok(match, "the fixture must contain the P11 anchor");
  const [, , , skillName, , mapName, sessionName] = match;
  const block = MARKER_BEGIN
    + `if(${skillName}==="ulw-plan"){${mapName}.get(${sessionName})?.delete("ulw-execute")}`
    + MARKER_END;
  const returnIndex = match.index + match[0].indexOf("return ");
  const byteIndex = Buffer.byteLength(text.slice(0, returnIndex), "utf8");
  return { block, byteIndex, match };
}

function install(target, stateDir, extra = []) {
  return runCli("install", "--target", target, "--state-dir", stateDir, ...extra);
}

function stateSnapshot(stateDir) {
  if (!existsSync(stateDir)) return null;
  return Object.fromEntries(
    readdirSync(stateDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const file = join(stateDir, entry.name);
        return [entry.name, { sha256: shaFile(file), mtimeMs: statSync(file).mtimeMs }];
      }),
  );
}

const SOURCE_HASHES = Object.fromEntries(
  Object.entries(FIXTURES).map(([name, file]) => [name, { file, sha256: shaFile(file) }]),
);

test("P11 fixtures: one anchor each; both real bundles are coordination-adapted", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const text = readFileSync(fixture, "utf8");
    assert.equal(anchorMatches(text).length, 1, `${name} anchor count`);
    assert.ok(!text.includes(MARKER_BEGIN), `${name} must not already carry the gate marker`);
  }
  const stableHash = shaFile(FIXTURES.stable);
  const globalHash = shaFile(FIXTURES.global);
  assert.equal(stableHash, P11_ADAPTED_SHA256, "stable-500 target drifted from P11");
  assert.equal(globalHash, P11_ADAPTED_SHA256, "global omo-ai target drifted from P11");
  assert.equal(shaFile(FIXTURES.stock), COORDINATION_BASELINE_SHA256, "stock fixture drifted from the coordination baseline");
  for (const name of ["stable", "global"]) {
    const text = readFileSync(FIXTURES[name], "utf8");
    assert.ok(text.trimStart().startsWith("var __coordNative"), `${name} is not the coordination-adapted P11 bundle`);
  }
  assert.ok(!readFileSync(FIXTURES.stock, "utf8").trimStart().startsWith("var __coordNative"));
});

test("install inserts exactly the marked statement and the result passes node --check", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  const before = readFileSync(target);
  const beforeSha256 = digest(before);

  const result = install(target, stateDir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.json?.ok, true);
  assert.equal(result.json?.status, "installed");
  assert.equal(result.json?.wrote, true);
  assert.equal(result.json?.preimage_sha256, beforeSha256);

  const after = readFileSync(target);
  const { block, byteIndex } = expectedInsertion(before);
  const expected = Buffer.concat([before.subarray(0, byteIndex), Buffer.from(block), before.subarray(byteIndex)]);
  assert.ok(after.equals(expected), "the byte diff must be exactly the marked statement");
  assert.equal(after.subarray(byteIndex, byteIndex + Buffer.byteLength(block)).toString(), block);
  assert.equal(
    block,
    MARKER_BEGIN + 'if(r==="ulw-plan"){t.get(a)?.delete("ulw-execute")}' + MARKER_END,
  );
  assert.equal(result.json?.statement, 'if(r==="ulw-plan"){t.get(a)?.delete("ulw-execute")}');
  assert.equal(result.json?.postimage_sha256, digest(after));

  const syntax = checkSyntax(target);
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  const afterText = after.toString("utf8");
  assert.ok(
    afterText.includes("stateFor:e=>({hasInvoked:n=>t.get(e)?.has(n)"),
    "the cleared map must be the one hasInvoked reads",
  );
  assert.equal((afterText.match(/piomo-primary-agents:gate-adapter:v1:begin/g) ?? []).length, 1);
  assert.equal((afterText.match(/piomo-primary-agents:gate-adapter:v1:end/g) ?? []).length, 1);
  for (const untouched of [
    'requiresSkills:["ulw-plan"]',
    'forbidsSkills:["ulw-execute"]',
    "requiresPlanArtifact:!0",
    '"plan-consultant":{requiresSkills:["ulw-plan"],requiresPlanArtifact:!0,forbidsSkills:["ulw-execute"]}',
  ]) {
    assert.equal(afterText.split(untouched).length, before.toString("utf8").split(untouched).length,
      `gate policy bytes changed: ${untouched}`);
  }
  const manifest = JSON.parse(readFileSync(join(stateDir, "manifest.json"), "utf8"));
  assert.equal(manifest.preimage_sha256, beforeSha256);
  assert.equal(manifest.postimage_sha256, digest(after));
  assert.equal(manifest.target, target);
  assert.ok(readFileSync(join(stateDir, manifest.backup)).equals(before), "backup must be the exact pre-image");
});

test("second install reports applied and writes nothing", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  assert.equal(install(target, stateDir).status, 0);
  const targetBefore = { sha256: shaFile(target), mtimeMs: statSync(target).mtimeMs };
  const stateBefore = stateSnapshot(stateDir);

  const second = install(target, stateDir);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(second.json?.status, "applied");
  assert.equal(second.json?.applied, true);
  assert.equal(second.json?.wrote, false);
  assert.deepEqual({ sha256: shaFile(target), mtimeMs: statSync(target).mtimeMs }, targetBefore);
  assert.deepEqual(stateSnapshot(stateDir), stateBefore);
});

test("uninstall restores the pre-image byte-for-byte and status becomes not-installed", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  const before = readFileSync(target);
  assert.equal(install(target, stateDir).status, 0);

  const removed = runCli("uninstall", "--target", target, "--state-dir", stateDir);
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.equal(removed.json?.status, "uninstalled");
  assert.equal(removed.json?.restored_sha256, digest(before));
  assert.ok(readFileSync(target).equals(before), "uninstall must restore byte-identical bytes");
  assert.equal(existsSync(join(stateDir, "manifest.json")), false);

  const status = runCli("status", "--target", target, "--state-dir", stateDir);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal(status.json?.status, "not-installed");
  assert.equal(status.json?.applied, false);
});

test("rollback goes through the same guarded restore", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  const before = readFileSync(target);
  assert.equal(install(target, stateDir).status, 0);

  const rolledBack = runCli("rollback", "--target", target, "--state-dir", stateDir);
  assert.equal(rolledBack.status, 0, rolledBack.stderr || rolledBack.stdout);
  assert.equal(rolledBack.json?.status, "rolled-back");
  assert.ok(readFileSync(target).equals(before));
  assert.equal(existsSync(join(stateDir, "manifest.json")), false);
});

test("stock coordination baseline installs and uninstalls", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stock");
  const stateDir = join(root, "state");
  const before = readFileSync(target);
  assert.equal(anchorMatches(before.toString("utf8")).length, 1);

  const installed = install(target, stateDir);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(installed.json?.status, "installed");
  assert.equal(checkSyntax(target).status, 0);
  assert.ok(readFileSync(target).equals(Buffer.concat([
    before.subarray(0, expectedInsertion(before).byteIndex),
    Buffer.from(expectedInsertion(before).block),
    before.subarray(expectedInsertion(before).byteIndex),
  ])));

  const removed = runCli("uninstall", "--target", target, "--state-dir", stateDir);
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.ok(readFileSync(target).equals(before));
});

test("coordination-adapted fixture installs and uninstalls", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "global");
  const stateDir = join(root, "state");
  const before = readFileSync(target);
  assert.equal(anchorMatches(before.toString("utf8")).length, 1);
  assert.ok(before.toString("utf8").trimStart().startsWith("var __coordNative"));

  const installed = install(target, stateDir);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(installed.json?.status, "installed");
  assert.equal(checkSyntax(target).status, 0);

  const removed = runCli("uninstall", "--target", target, "--state-dir", stateDir);
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.ok(readFileSync(target).equals(before));
});

test("a target changed after install makes uninstall refuse with no write", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  assert.equal(install(target, stateDir).status, 0);
  writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("\n// drifted\n")]));
  const driftedSha256 = shaFile(target);
  const manifestBefore = shaFile(join(stateDir, "manifest.json"));
  const backupBefore = shaFile(join(stateDir, "omo-task.js.preimage"));

  const refused = runCli("uninstall", "--target", target, "--state-dir", stateDir);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json?.ok, false);
  assert.match(refused.json?.reason ?? "", /^TARGET_DRIFT_REFUSED/);
  assert.equal(shaFile(target), driftedSha256, "refusal must not write the target");
  assert.equal(shaFile(join(stateDir, "manifest.json")), manifestBefore);
  assert.equal(shaFile(join(stateDir, "omo-task.js.preimage")), backupBefore);
});

test("a fixture with the anchor removed makes install refuse with no write", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stock");
  const sourceText = readFileSync(target, "utf8");
  const [match] = anchorMatches(sourceText);
  const withoutAnchor = sourceText.replace(match[0], match[0].replace('startsWith("/skill:")', 'startsWith("/skillX:")'));
  assert.equal(anchorMatches(withoutAnchor).length, 0);
  writeFileSync(target, withoutAnchor);
  const beforeSha256 = shaFile(target);

  const refused = install(target, join(root, "state"));
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json?.ok, false);
  assert.match(refused.json?.reason ?? "", /^ANCHOR_COUNT_REFUSED: expected 1, found 0$/);
  assert.equal(shaFile(target), beforeSha256, "refusal must not write the target");
  assert.equal(existsSync(join(root, "state", "manifest.json")), false);
  assert.equal(existsSync(join(root, "state", "omo-task.js.preimage")), false);
});

test("a duplicated anchor makes install refuse with no write", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stock");
  const sourceText = readFileSync(target, "utf8");
  const [match] = anchorMatches(sourceText);
  writeFileSync(target, sourceText.replace(match[0], match[0] + match[0]));
  const beforeSha256 = shaFile(target);

  const refused = install(target, join(root, "state"));
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json?.ok, false);
  assert.match(refused.json?.reason ?? "", /^ANCHOR_COUNT_REFUSED: expected 1, found 2$/);
  assert.equal(shaFile(target), beforeSha256);
});

test("a tampered marker refuses install and the hash-mismatched uninstall", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  assert.equal(install(target, stateDir).status, 0);
  const tampered = readFileSync(target, "utf8")
    .replace('delete("ulw-execute")', 'delete("ulw-execute-x")');
  writeFileSync(target, tampered);
  const tamperedSha256 = shaFile(target);

  const installRefused = install(target, stateDir);
  assert.equal(installRefused.status, 1, installRefused.stdout);
  assert.equal(installRefused.json?.ok, false);
  assert.match(installRefused.json?.reason ?? "", /^MARKER_TAMPERED/);
  assert.equal(shaFile(target), tamperedSha256);

  const uninstallRefused = runCli("uninstall", "--target", target, "--state-dir", stateDir);
  assert.equal(uninstallRefused.status, 1, uninstallRefused.stdout);
  assert.equal(uninstallRefused.json?.ok, false);
  assert.match(uninstallRefused.json?.reason ?? "", /^TARGET_DRIFT_REFUSED/);
  assert.equal(shaFile(target), tamperedSha256);
});

test("an existing backup makes install refuse", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "omo-task.js.preimage"), "stale backup\n");
  const beforeSha256 = shaFile(target);

  const refused = install(target, stateDir);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.json?.ok, false);
  assert.match(refused.json?.reason ?? "", /^EXISTING_BACKUP_REFUSED/);
  assert.equal(shaFile(target), beforeSha256);
  assert.equal(readFileSync(join(stateDir, "omo-task.js.preimage"), "utf8"), "stale backup\n");
});

test("dry-run reports the candidate hash and writes nothing", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  const beforeSha256 = shaFile(target);

  const dryRun = install(target, stateDir, ["--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.equal(dryRun.json?.status, "would-install");
  assert.equal(dryRun.json?.wrote, false);
  assert.notEqual(dryRun.json?.postimage_sha256, beforeSha256);
  assert.equal(shaFile(target), beforeSha256);
  assert.equal(existsSync(stateDir), false);
});

test("status reports drift and never claims applied for a changed target", (t) => {
  const root = workspace(t);
  const target = copyFixture(root, "stable");
  const stateDir = join(root, "state");
  assert.equal(install(target, stateDir).status, 0);
  writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("\n// drift\n")]));

  const status = runCli("status", "--target", target, "--state-dir", stateDir);
  assert.equal(status.status, 1, status.stdout);
  assert.equal(status.json?.ok, false);
  assert.equal(status.json?.status, "drift");
  assert.equal(status.json?.applied, false);
  assert.match(status.stdout, /"ok":false/);
  assert.doesNotMatch(status.stdout, /"ok":true/);
});

test("source P11 fixtures and staging copies were never modified", () => {
  for (const [name, entry] of Object.entries(SOURCE_HASHES)) {
    assert.equal(shaFile(entry.file), entry.sha256, `${name} source changed during the test run`);
    assert.ok(!readFileSync(entry.file, "utf8").includes(MARKER_BEGIN), `${name} source gained the gate marker`);
  }
});
