/**
 * Journal generations, follow-up: journal lines that load ignores are never
 * left in the live journal, so a later append cannot make them current again.
 * Also: restore-backup refuses manifest paths that leave their directory.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JsonStorage } from '../storage.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESTORE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'restore-backup.mjs');

let tmpRoot;
const saved = {};
const ENV = ['KANBAN_STORAGE_JOURNAL', 'KANBAN_JOURNAL_COMPACT_BYTES', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE'];

before(async () => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kanban-journalmixed-'));
  process.env.KANBAN_DATA_DIR = tmpRoot;
  process.env.KANBAN_DATA_FILE = path.join(tmpRoot, 'tasks.json');
  process.env.KANBAN_STORAGE_JOURNAL = '1';
});
after(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

let seq = 0;
async function freshDir(label) {
  const dir = path.join(tmpRoot, `${label}-${++seq}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
const T = (id, version) => ({ id, title: id, status: 'BACKLOG', round: 1, version, project: 'default' });
const ids = (list) => list.map((t) => t.id).sort();
const boot = (file) => new JsonStorage(file, { isDefault: true });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('superseded journal lines are cleared on load', { concurrency: 1 }, () => {
  it('upgrade window: a purged card does not return after crash, restart and a later append', async () => {
    const dir = await freshDir('mixed');
    const file = path.join(dir, 'tasks.json');
    // Base from the previous release (no generation) plus an untagged line.
    await writeFile(file, JSON.stringify({ tasks: [T('A', 1)] }));
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    await writeFile(`${file}.journal.jsonl`, JSON.stringify({ op: 'upsert', id: 'X', task: T('X', 1) }) + '\n');

    const s1 = boot(file);
    assert.deepEqual(ids(await s1.load()), ['A', 'X'], 'boot 1: untagged line replayed');
    await s1.saveTask(T('A', 2), [T('A', 2), T('X', 1)]); // tagged generation 0
    // Purge X with a full base write; crash before the journal is truncated.
    await s1._writeCanonical([T('A', 2)]);

    const s2 = boot(file);
    assert.deepEqual(ids(await s2.load()), ['A'], 'boot 2: purged card stays gone');
    await tick();
    await s2.saveTask(T('A', 3), [T('A', 3)]);

    const s3 = boot(file);
    const loaded = await s3.load();
    assert.deepEqual(ids(loaded), ['A'], 'boot 3: purged card not revived by a later append');
    assert.equal(loaded[0].version, 3, 'the later append itself is replayed');
    assert.ok((await readdir(dir)).some((f) => f.includes('.journal.jsonl.stale-')), 'superseded journal kept aside');
  });

  it('a mixed journal whose untagged lines are current folds them into the base', async () => {
    const dir = await freshDir('mixed-current');
    const file = path.join(dir, 'tasks.json');
    await writeFile(file, JSON.stringify({ generation: 1, tasks: [T('A', 1)] }));
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    // Untagged line (e.g. written after a downgrade) and a line of another generation.
    await writeFile(`${file}.journal.jsonl`, [
      JSON.stringify({ op: 'upsert', id: 'B', task: T('B', 1) }),
      JSON.stringify({ op: 'upsert', id: 'Z', task: T('Z', 1), generation: 7 }),
    ].join('\n') + '\n');
    assert.deepEqual(ids(await boot(file).load()), ['A', 'B']);
    const base = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(ids(base.tasks), ['A', 'B'], 'current untagged line folded into the base');
    assert.equal(base.generation, 2);
    assert.equal(existsSync(`${file}.journal.jsonl`), false, 'live journal cleared');
    assert.deepEqual(ids(await boot(file).load()), ['A', 'B'], 'stable across another restart');
  });

  it('tagged lines from an older generation are cleared on load so a later append cannot revive them', async () => {
    const dir = await freshDir('tagged-stale');
    const file = path.join(dir, 'tasks.json');
    const s = boot(file);
    await s.save([T('A', 1)]);                       // generation 1
    await s.saveTask(T('Y', 1), [T('A', 1), T('Y', 1)]); // tagged generation 1
    const stale = await readFile(s.journalFile, 'utf-8');
    await s.save([T('A', 1)]);                       // generation 2, Y removed
    await writeFile(s.journalFile, stale);           // truncation lost

    const s2 = boot(file);
    assert.deepEqual(ids(await s2.load()), ['A']);
    assert.equal(existsSync(s2.journalFile), false, 'stale tagged lines not left in the live journal');
    await s2.saveTask(T('A', 2), [T('A', 2)]);
    const again = await boot(file).load();
    assert.deepEqual(ids(again), ['A']);
    assert.equal(again[0].version, 2);
  });

  it('a failed fold at boot refuses to start with a journal message, not "corrupt data file"', async () => {
    const dir = await freshDir('fold-fails');
    const file = path.join(dir, 'tasks.json');
    await writeFile(file, JSON.stringify({ generation: 2, tasks: [T('A', 1)] }));
    await writeFile(`${file}.journal.jsonl`,
      JSON.stringify({ op: 'upsert', id: 'Y', task: T('Y', 1), generation: 1 }) + '\n');
    const s = boot(file);
    s._writeCanonical = async () => {
      throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
    };
    const logged = [];
    const orig = console.error;
    console.error = (...a) => { logged.push(a.join(' ')); };
    try {
      await assert.rejects(s.load(), (err) => err.journalFold === true);
    } finally {
      console.error = orig;
    }
    const msg = logged.join('\n');
    assert.match(msg, /could not fold the journal/);
    assert.match(msg, /EACCES/);
    assert.match(msg, /refusing to start/);
    assert.doesNotMatch(msg, /corrupt data file/);
    assert.ok(existsSync(`${file}.journal.jsonl`), 'journal left on disk');
  });

  it('a journal with only current lines is left in place (no extra base write)', async () => {
    const dir = await freshDir('current');
    const file = path.join(dir, 'tasks.json');
    const s = boot(file);
    await s.save([T('A', 1)]);
    await s.saveTask(T('A', 2), [T('A', 2)]);
    const before = await readFile(file, 'utf-8');
    assert.equal((await boot(file).load())[0].version, 2);
    assert.equal(await readFile(file, 'utf-8'), before, 'base untouched');
    assert.ok(existsSync(s.journalFile));
  });
});

describe('restore-backup refuses manifest paths outside their directory', () => {
  async function snapshot(files) {
    const base = await freshDir('restore-unsafe');
    const snap = path.join(base, 'snap');
    await mkdir(snap, { recursive: true });
    await writeFile(path.join(snap, 'tasks.json'), JSON.stringify({ tasks: [] }));
    await writeFile(path.join(snap, 'backup-manifest.json'), JSON.stringify({
      format: 1, split: true, data_dir: '/data', git: null,
      default_project: { dir: '/elsewhere', files, live_file: 'tasks.json' },
    }));
    return { base, snap };
  }

  for (const bad of ['a/../../x', '../x', '/etc/x', 'a\\..\\..\\x', '']) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const { base, snap } = await snapshot(['tasks.json', bad]);
      const into = path.join(base, 'into');
      const def = path.join(base, 'def');
      await assert.rejects(
        execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', into, '--default-into', def]),
        (err) => /unsafe default project file path/.test(err.stderr) && err.code === 2,
      );
      assert.equal(existsSync(into), false, 'nothing restored');
      assert.equal(existsSync(path.join(base, 'x')), false);
    });
  }

  it('still restores a manifest with plain relative paths', async () => {
    const { base, snap } = await snapshot(['tasks.json']);
    const def = path.join(base, 'def');
    await execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', path.join(base, 'into'), '--default-into', def]);
    assert.ok(existsSync(path.join(def, 'tasks.json')));
  });
});
