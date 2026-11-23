/**
 * 3.18.1 — the master-unlock secret file: missing, corrupt/empty and unreadable
 * are told apart, logged (path only, never a secret), and an unreadable file is
 * never rotated. A loose `.secrets/` directory is tightened to 0700.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  UNLOCK_SECRET_DIR,
  UNLOCK_SECRET_FILE,
  createUnlockToken,
  resetUnlockKeyMaterial,
  unlockSecretFallbackReason,
  unlockSecretPersisted,
  verifyUnlockToken,
} from '../masterUnlock.js';

const MASTER = 'correct-horse-battery';
const VALID = { v: 2, secret: 'c'.repeat(64), salt: 'd'.repeat(32) };

function capture(fn) {
  const lines = [];
  const { log, warn } = console;
  console.log = (...a) => lines.push({ level: 'info', text: a.join(' ') });
  console.warn = (...a) => lines.push({ level: 'warn', text: a.join(' ') });
  try {
    fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

describe('master-unlock secret file repair and logging (3.18.1)', () => {
  let dir;
  let secretsDir;
  let file;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kanban-unlockfile-'));
    secretsDir = path.join(dir, UNLOCK_SECRET_DIR);
    file = path.join(secretsDir, UNLOCK_SECRET_FILE);
    process.env.KANBAN_DATA_DIR = dir;
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    resetUnlockKeyMaterial();
  });
  afterEach(async () => {
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_MASTER_PASSWORD;
    resetUnlockKeyMaterial();
    await chmod(file, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const noSecretIn = (lines, ...values) => {
    const all = lines.map((l) => l.text).join('\n');
    for (const v of [MASTER, ...values]) assert.ok(!all.includes(v), 'a secret value reached the log');
  };

  it('missing file: created, persisted, logged at info with the path', async () => {
    const lines = capture(() => createUnlockToken());
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(unlockSecretPersisted(), true);
    assert.equal(unlockSecretFallbackReason(), null);
    const created = lines.filter((l) => l.level === 'info' && l.text.includes('created the master-unlock signing secret'));
    assert.equal(created.length, 1);
    assert.ok(created[0].text.includes(file));
    assert.equal(lines.filter((l) => l.level === 'warn').length, 0);
    noSecretIn(lines, stored.secret, stored.salt);
  });

  for (const [name, content] of [['corrupt', '{"secret":"nope-SENTINEL"}'], ['empty', ''], ['not JSON', 'SENTINEL{{{']]) {
    it(`${name} file: replaced with a warning naming the path, never the content`, async () => {
      await mkdir(secretsDir, { recursive: true, mode: 0o700 });
      await writeFile(file, content, { mode: 0o600 });
      const lines = capture(() => createUnlockToken());
      const stored = JSON.parse(await readFile(file, 'utf8'));
      assert.match(stored.secret, /^[0-9a-f]{64}$/);
      assert.equal(unlockSecretPersisted(), true);
      const warns = lines.filter((l) => l.level === 'warn');
      assert.equal(warns.length, 1, JSON.stringify(lines));
      assert.match(warns[0].text, /empty or corrupt; replaced it/);
      assert.ok(warns[0].text.includes(file));
      noSecretIn(lines, 'SENTINEL', stored.secret, stored.salt);
    });
  }

  it('read error (EISDIR): the stored path is left untouched, the run is per-process, and the startup reason says so', async () => {
    await mkdir(file, { recursive: true }); // the "file" is a directory: reading it fails with EISDIR
    const lines = capture(() => createUnlockToken());
    assert.ok((await stat(file)).isDirectory(), 'the stored path must not be replaced');
    assert.equal(unlockSecretPersisted(), false);
    assert.equal(unlockSecretFallbackReason(), 'read_error');
    const warns = lines.filter((l) => l.level === 'warn');
    assert.equal(warns.length, 1, JSON.stringify(lines));
    assert.match(warns[0].text, /could not be read; it is left untouched/);
    assert.match(warns[0].text, /per-process secret/);
    assert.match(warns[0].text, /code=EISDIR/);
    // Stable for the whole run: a token minted now verifies later in the run.
    const minted = createUnlockToken();
    assert.ok(verifyUnlockToken(minted.token));
  });

  it('read error (EACCES): the stored secret is NOT rotated and comes back once readable', { skip: process.getuid?.() === 0 ? 'root can read a 000 file' : false }, async () => {
    await mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(VALID), { mode: 0o600 });
    const before = await readFile(file, 'utf8');
    // A token minted under the stored secret...
    let minted;
    capture(() => { minted = createUnlockToken(); });
    resetUnlockKeyMaterial();
    await chmod(file, 0o000);
    const lines = capture(() => assert.equal(verifyUnlockToken(minted.token), null, 'per-process key this run'));
    assert.equal(unlockSecretFallbackReason(), 'read_error');
    assert.ok(lines.some((l) => l.level === 'warn' && /code=EACCES/.test(l.text)), JSON.stringify(lines));
    noSecretIn(lines, VALID.secret, VALID.salt);
    await chmod(file, 0o600);
    assert.equal(await readFile(file, 'utf8'), before, 'the stored secret was rewritten');
    // ...verifies again after a "restart" that can read the file.
    resetUnlockKeyMaterial();
    assert.ok(verifyUnlockToken(minted.token));
    assert.equal(unlockSecretPersisted(), true);
  });

  for (const loose of [0o777, 0o770, 0o722]) {
    it(`a ${loose.toString(8)} .secrets/ directory is tightened to 0700 and that is logged`, async () => {
      await mkdir(secretsDir, { recursive: true });
      await writeFile(file, JSON.stringify(VALID), { mode: 0o600 });
      await chmod(secretsDir, loose);
      const lines = capture(() => createUnlockToken());
      assert.equal((await stat(secretsDir)).mode & 0o777, 0o700);
      const warns = lines.filter((l) => /tightened .*to 0700/.test(l.text));
      assert.equal(warns.length, 1, JSON.stringify(lines));
      assert.ok(warns[0].text.includes(secretsDir));
      noSecretIn(lines, VALID.secret, VALID.salt);
    });
  }

  it('an owner-only .secrets/ directory is left alone and nothing is logged about it', async () => {
    await mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(VALID), { mode: 0o600 });
    const lines = capture(() => createUnlockToken());
    assert.deepEqual(lines, []);
  });

  it('a symlinked .secrets/ directory is not followed: no chmod, no write through it, per-process key, warned', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'kanban-unlockfile-outside-'));
    try {
      await chmod(outside, 0o777);
      await symlink(outside, secretsDir, 'dir');
      const lines = capture(() => createUnlockToken());
      assert.equal((await stat(outside)).mode & 0o777, 0o777, 'the link target was chmodded');
      assert.deepEqual(await readdir(outside), [], 'something was written through the link');
      assert.ok((await lstat(secretsDir)).isSymbolicLink(), 'the link was replaced');
      assert.equal(unlockSecretPersisted(), false);
      assert.equal(unlockSecretFallbackReason(), 'symlink');
      const warns = lines.filter((l) => l.level === 'warn');
      assert.equal(warns.length, 1, JSON.stringify(lines));
      assert.match(warns[0].text, /symbolic link; it is not followed/);
      assert.ok(warns[0].text.includes(file));
      // Stable for the whole run.
      const minted = createUnlockToken();
      assert.ok(verifyUnlockToken(minted.token));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a symlinked secret file is not read, chmodded or replaced', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'kanban-unlockfile-outside-'));
    try {
      const target = path.join(outside, 'planted.json');
      await writeFile(target, JSON.stringify(VALID), { mode: 0o644 });
      await mkdir(secretsDir, { recursive: true, mode: 0o700 });
      await symlink(target, file);
      // A token signed with the PLANTED secret must not verify.
      process.env.KANBAN_DATA_DIR = outside;
      await mkdir(path.join(outside, UNLOCK_SECRET_DIR), { mode: 0o700 });
      await writeFile(path.join(outside, UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE), JSON.stringify(VALID), { mode: 0o600 });
      resetUnlockKeyMaterial();
      let planted;
      capture(() => { planted = createUnlockToken(); });
      process.env.KANBAN_DATA_DIR = dir;
      resetUnlockKeyMaterial();
      const lines = capture(() => assert.equal(verifyUnlockToken(planted.token), null, 'the planted secret was used'));
      assert.equal((await stat(target)).mode & 0o777, 0o644, 'the link target was chmodded');
      assert.equal(await readFile(target, 'utf8'), JSON.stringify(VALID), 'the link target was rewritten');
      assert.ok((await lstat(file)).isSymbolicLink(), 'the link was replaced');
      assert.equal(unlockSecretFallbackReason(), 'symlink');
      assert.ok(lines.some((l) => l.level === 'warn' && /symbolic link/.test(l.text)), JSON.stringify(lines));
      noSecretIn(lines, VALID.secret, VALID.salt);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a corrupt file on a read-only directory: the warning says it was left as is, not "replacing it"', { skip: process.getuid?.() === 0 ? 'root writes into a 0500 directory' : false }, async () => {
    await mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await writeFile(file, 'SENTINEL{{{', { mode: 0o600 });
    await chmod(secretsDir, 0o500);
    try {
      const lines = capture(() => createUnlockToken());
      assert.equal(await readFile(file, 'utf8'), 'SENTINEL{{{');
      assert.equal(unlockSecretPersisted(), false);
      const warns = lines.filter((l) => l.level === 'warn');
      assert.equal(warns.length, 1, JSON.stringify(lines));
      assert.match(warns[0].text, /could not be replaced/);
      assert.match(warns[0].text, /left as it is/);
      assert.doesNotMatch(warns[0].text, /replacing it|replaced it/);
      noSecretIn(lines, 'SENTINEL');
    } finally {
      await chmod(secretsDir, 0o700);
    }
  });
});
