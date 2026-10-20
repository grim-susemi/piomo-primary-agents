#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_ID, ADAPTER_VERSION, GateAdapterError,
  anchorNames, applyAdapter, inspectAdapter,
} from "../src/gate-adapter/adapter.mjs";

const ACTIONS = new Set(["install", "uninstall", "rollback", "status"]);
const RETRY_DELAYS = [0, 10, 20, 40, 80, 160];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fail(code, detail) {
  throw new GateAdapterError(code, detail);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function targetFile(target) {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) fail("TARGET_MISSING", absolute);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) fail("SYMLINK_REFUSED", absolute);
  if (!stat.isFile()) fail("TARGET_NOT_FILE_REFUSED", absolute);
  return absolute;
}

function stateDirectory(stateDir) {
  const absolute = path.resolve(stateDir);
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail("SYMLINK_REFUSED", absolute);
    if (!stat.isDirectory()) fail("STATE_DIR_NOT_DIRECTORY_REFUSED", absolute);
  }
  return absolute;
}

function manifestFile(stateDir) {
  return path.join(stateDir, "manifest.json");
}

function backupName(target) {
  return path.basename(target) + ".preimage";
}

function backupFile(stateDir, manifest) {
  if (typeof manifest.backup !== "string" || manifest.backup !== path.basename(manifest.backup)) {
    fail("MANIFEST_SHAPE_REFUSED", "backup must be a bare file name");
  }
  return path.join(stateDir, manifest.backup);
}

function loadManifest(stateDir) {
  const file = manifestFile(stateDir);
  if (!fs.existsSync(file)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail("MANIFEST_UNREADABLE_REFUSED", error.message);
  }
  if (manifest?.version !== 1 || manifest.adapter !== ADAPTER_ID || manifest.adapter_version !== ADAPTER_VERSION) {
    fail("MANIFEST_IDENTITY_REFUSED", file);
  }
  for (const field of ["target", "backup", "preimage_sha256", "postimage_sha256"]) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
      fail("MANIFEST_SHAPE_REFUSED", field);
    }
  }
  return manifest;
}

async function atomicReplace(target, bytes) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx");
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    let lastError;
    for (const delay of RETRY_DELAYS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        fs.renameSync(temporary, target);
        lastError = undefined;
        break;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    if (fs.existsSync(temporary)) {
      try { fs.unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
    }
  }
}

function verifyManagedTarget(manifest, target, stateDir, currentSha256) {
  if (!samePath(manifest.target, target)) {
    fail("TARGET_MISMATCH_REFUSED", `manifest=${manifest.target} target=${target}`);
  }
  if (currentSha256 !== manifest.postimage_sha256) {
    fail("TARGET_DRIFT_REFUSED", `expected ${manifest.postimage_sha256}, found ${currentSha256}`);
  }
  const backup = backupFile(stateDir, manifest);
  if (!fs.existsSync(backup)) fail("BACKUP_MISSING_REFUSED", backup);
  const backupSha256 = digest(fs.readFileSync(backup));
  if (backupSha256 !== manifest.preimage_sha256) {
    fail("BACKUP_DRIFT_REFUSED", `expected ${manifest.preimage_sha256}, found ${backupSha256}`);
  }
  return { backup, backupSha256 };
}

async function install({ target, stateDir, dryRun }) {
  const targetPath = targetFile(target);
  const before = fs.readFileSync(targetPath);
  const beforeSha256 = digest(before);
  const inspection = inspectAdapter(before);
  const state = stateDirectory(stateDir);
  const manifest = loadManifest(state);

  if (inspection.kind === "applied") {
    if (manifest) {
      verifyManagedTarget(manifest, targetPath, state, beforeSha256);
      return {
        status: "applied", applied: true, wrote: false, managed: true,
        target: targetPath, preimage_sha256: manifest.preimage_sha256, postimage_sha256: beforeSha256,
      };
    }
    return {
      status: "applied", applied: true, wrote: false, managed: false,
      target: targetPath, postimage_sha256: beforeSha256,
    };
  }
  if (inspection.kind === "tampered") {
    fail("MARKER_TAMPERED", inspection.reason);
  }
  if (inspection.anchorCount !== 1) {
    fail("ANCHOR_COUNT_REFUSED", `expected 1, found ${inspection.anchorCount}`);
  }
  if (manifest) fail("EXISTING_MANIFEST_REFUSED", manifestFile(state));
  const backup = path.join(state, backupName(targetPath));
  if (fs.existsSync(backup)) fail("EXISTING_BACKUP_REFUSED", backup);

  const applied = applyAdapter(before);
  const postimageSha256 = digest(applied.bytes);
  const names = anchorNames(inspection.anchor);
  const result = {
    status: dryRun ? "would-install" : "installed",
    applied: !dryRun,
    wrote: false,
    managed: true,
    target: targetPath,
    preimage_sha256: beforeSha256,
    postimage_sha256: postimageSha256,
    backup,
    anchor: {
      count: inspection.anchorCount,
      offset: inspection.anchor.index,
      names: {
        text: names.text, space_index: names.spaceIndex, skill: names.skill,
        recorder: names.recorder, map: names.map, session: names.session,
        requested_map: names.requestedMap,
      },
    },
    statement: applied.inspection.statement,
  };
  if (dryRun) return result;

  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(backup, before, { flag: "wx" });
  const manifestBytes = Buffer.from(JSON.stringify({
    version: 1,
    adapter: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    target: targetPath,
    backup: backupName(targetPath),
    preimage_sha256: beforeSha256,
    preimage_size: before.length,
    postimage_sha256: postimageSha256,
    postimage_size: applied.bytes.length,
    anchor: result.anchor,
    statement: result.statement,
    applied_at: new Date().toISOString(),
  }, null, 2) + "\n");
  fs.writeFileSync(manifestFile(state), manifestBytes, { flag: "wx" });

  // Recheck the external boundary immediately before its only write.
  if (digest(fs.readFileSync(targetPath)) !== beforeSha256) {
    fs.rmSync(manifestFile(state), { force: true });
    fs.rmSync(backup, { force: true });
    fail("TARGET_CHANGED_DURING_INSTALL", targetPath);
  }
  try {
    await atomicReplace(targetPath, applied.bytes);
  } catch (error) {
    // The target was not replaced (or was replaced atomically): remove the
    // install state only while the target still holds the pre-image.
    if (digest(fs.readFileSync(targetPath)) === beforeSha256) {
      fs.rmSync(manifestFile(state), { force: true });
      fs.rmSync(backup, { force: true });
    }
    throw error;
  }
  const writtenSha256 = digest(fs.readFileSync(targetPath));
  if (writtenSha256 !== postimageSha256) {
    fail("POST_WRITE_DRIFT_REFUSED", `expected ${postimageSha256}, found ${writtenSha256}`);
  }
  return { ...result, wrote: true };
}

async function restore({ target, stateDir, dryRun, action }) {
  const targetPath = targetFile(target);
  const state = stateDirectory(stateDir);
  const manifest = loadManifest(state);
  if (!manifest) fail("MANIFEST_MISSING_REFUSED", manifestFile(state));
  if (!samePath(manifest.target, targetPath)) {
    fail("TARGET_MISMATCH_REFUSED", `manifest=${manifest.target} target=${targetPath}`);
  }
  const current = fs.readFileSync(targetPath);
  const currentSha256 = digest(current);
  if (currentSha256 !== manifest.postimage_sha256) {
    fail("TARGET_DRIFT_REFUSED", `expected ${manifest.postimage_sha256}, found ${currentSha256}`);
  }
  const inspection = inspectAdapter(current);
  if (inspection.kind !== "applied") {
    fail("TARGET_DRIFT_REFUSED", `post-image is not applied: ${inspection.reason ?? inspection.kind}`);
  }
  const backup = backupFile(state, manifest);
  if (!fs.existsSync(backup)) fail("BACKUP_MISSING_REFUSED", backup);
  const backupBytes = fs.readFileSync(backup);
  const backupSha256 = digest(backupBytes);
  if (backupSha256 !== manifest.preimage_sha256) {
    fail("BACKUP_DRIFT_REFUSED", `expected ${manifest.preimage_sha256}, found ${backupSha256}`);
  }
  const result = {
    status: dryRun ? "would-uninstall" : action === "rollback" ? "rolled-back" : "uninstalled",
    applied: false,
    wrote: false,
    target: targetPath,
    restored_sha256: manifest.preimage_sha256,
    removed_sha256: currentSha256,
  };
  if (dryRun) return result;

  // Recheck the external boundary immediately before its only write.
  const recheck = digest(fs.readFileSync(targetPath));
  if (recheck !== currentSha256) {
    fail("TARGET_CHANGED_DURING_UNINSTALL", `expected ${currentSha256}, found ${recheck}`);
  }
  await atomicReplace(targetPath, backupBytes);
  const restoredSha256 = digest(fs.readFileSync(targetPath));
  if (restoredSha256 !== manifest.preimage_sha256) {
    fail("RESTORE_DRIFT_REFUSED", `expected ${manifest.preimage_sha256}, found ${restoredSha256}`);
  }
  fs.rmSync(manifestFile(state), { force: true });
  fs.rmSync(backup, { force: true });
  try {
    if (fs.readdirSync(state).length === 0) fs.rmdirSync(state);
  } catch { /* the state directory may be shared; leave it in place */ }
  return { ...result, wrote: true };
}

function status({ target, stateDir }) {
  const targetPath = targetFile(target);
  const state = stateDirectory(stateDir);
  const bytes = fs.readFileSync(targetPath);
  const targetSha256 = digest(bytes);
  const inspection = inspectAdapter(bytes);
  if (inspection.kind === "tampered") {
    return { ok: false, status: "tampered", applied: false, reason: inspection.reason, target: targetPath, target_sha256: targetSha256 };
  }
  const manifest = loadManifest(state);
  if (!manifest) {
    if (inspection.kind === "applied") {
      return { ok: true, status: "applied", applied: true, managed: false, target: targetPath, postimage_sha256: targetSha256 };
    }
    return {
      ok: true, status: "not-installed", applied: false, managed: false,
      target: targetPath, target_sha256: targetSha256, anchor_count: inspection.anchorCount,
    };
  }
  if (!samePath(manifest.target, targetPath)) {
    return {
      ok: false, status: "mismatch", applied: false, reason: "TARGET_MISMATCH_REFUSED",
      manifest_target: manifest.target, target: targetPath,
    };
  }
  if (targetSha256 !== manifest.postimage_sha256) {
    return {
      ok: false, status: "drift", applied: false, reason: "TARGET_DRIFT_REFUSED",
      expected_sha256: manifest.postimage_sha256, target_sha256: targetSha256, target: targetPath,
    };
  }
  if (inspection.kind !== "applied") {
    return {
      ok: false, status: "drift", applied: false, reason: "TARGET_NOT_APPLIED",
      detail: inspection.reason ?? inspection.kind, target: targetPath,
    };
  }
  try {
    verifyManagedTarget(manifest, targetPath, state, targetSha256);
  } catch (error) {
    return {
      ok: false, status: "drift", applied: false, reason: error.code ?? "BACKUP_DRIFT_REFUSED",
      detail: error.detail ?? error.message, target: targetPath,
    };
  }
  return {
    ok: true, status: "applied", applied: true, managed: true,
    target: targetPath, preimage_sha256: manifest.preimage_sha256, postimage_sha256: targetSha256,
    backup: backupFile(state, manifest),
  };
}

function parse(argv) {
  const action = argv[0];
  if (!ACTIONS.has(action)) {
    fail("INVALID_ACTION", `expected install|uninstall|rollback|status, found ${action ?? "nothing"}`);
  }
  const options = { action, dryRun: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--target" || argument === "--state-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail("MISSING_VALUE", argument);
      options[argument === "--target" ? "target" : "stateDir"] = value;
      index += 1;
    } else {
      fail("UNKNOWN_ARGUMENT", argument);
    }
  }
  if (!options.target) fail("TARGET_REQUIRED", "--target <omo-task.js>");
  if (!options.stateDir) fail("STATE_DIR_REQUIRED", "--state-dir <dir>");
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const result = options.action === "install"
    ? await install(options)
    : options.action === "status"
      ? status(options)
      : await restore({
        target: options.target,
        stateDir: options.stateDir,
        dryRun: options.dryRun,
        action: options.action,
      });
  const ok = result.ok !== false;
  console.log(JSON.stringify({ ok, action: options.action, ...result }));
  if (!ok) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const reason = error instanceof GateAdapterError ? error.message : `${error?.code ? error.code + ": " : ""}${error?.message ?? error}`;
    console.error(JSON.stringify({ ok: false, applied: false, status: "refused", reason }));
    process.exitCode = 1;
  }
}
