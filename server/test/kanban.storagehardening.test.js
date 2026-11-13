/**
 * Storage hardening (batch 2): durable atomic writes, compact partitions, git
 * backend rollback on commit failure, path-argument safety, archive removal
 * with auto-commit off, batched commits for lease renewals, and a backup set
 * that covers every storage file.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import * as store from '../store.js';
import { writeAtomic, isValidTaskId } from '../task-identity.js';
import { JsonStorage, GitYamlStorage } from '../storage.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESTORE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'restore-backup.mjs');

const ENV = [
  'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_GIT_DIR', 'KANBAN_STORAGE_BACKEND',
  'KANBAN_GIT_COMMIT', 'KANBAN_STORAGE_JOURNAL', 'KANBAN_ARCHIVE_AFTER_DAYS',
  'KANBAN_BACKUP_ENABLED', 'KANBAN_DEFAULT_PROJECT',
];
const savedEnv = {};
let tmpRoot;

before(async () => {
  for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kanban-storagehardening-'));
  process.env.KANBAN_DATA_DIR = path.join(tmpRoot, 'default-data');
  process.env.KANBAN_DATA_FILE = path.join(tmpRoot, 'default-data', 'tasks.json');
});

after(async () => {
  store.setStorage(null);
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

let seq = 0;
async function freshDir(label) {
  const dir = path.join(tmpRoot, `${label}-${++seq}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function gitRepo(label) {
  const dir = await freshDir(label);
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Storage Test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'storage@test.local'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

async function failCommits(dir) {
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf-8');
  await chmod(hook, 0o755);
}

async function allowCommits(dir) {
  await rm(path.join(dir, '.git', 'hooks', 'pre-commit'), { force: true });
}

async function commitCount(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir });
    return Number(stdout.trim());
  } catch {
    return 0;
  }
}

async function porcelain(dir) {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
  return stdout.trim();
}

function card(id, extra = {}) {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id, title: `Card ${id}`, status: 'READY', round: 1, priority: 'medium',
    depends_on: [], issues: [], agent_logs: [], metadata: {}, comments: [],
    assigned_agent: null, created_at: now, updated: now, version: 1, ...extra,
  };
}

// ---------------------------------------------------------------------------
describe('A12 durable atomic write', () => {
  it('writes the content and leaves no temp file behind', async () => {
    const dir = await freshDir('atomic');
    const target = path.join(dir, 'p.json');
    await writeAtomic(target, '{"a":1}');
    await writeAtomic(target, '{"a":2}');
    assert.equal(await readFile(target, 'utf-8'), '{"a":2}');
    assert.deepEqual(await readdir(dir), ['p.json']);
  });

  it('removes the temp file when the final rename fails', async () => {
    const dir = await freshDir('atomic-fail');
    // A non-empty directory at the target path makes the rename fail.
    const target = path.join(dir, 'occupied');
    await mkdir(target);
    await writeFile(path.join(target, 'keep'), 'x');
    await assert.rejects(writeAtomic(target, 'data'));
    assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith('.tmp_')), []);
  });
});

// ---------------------------------------------------------------------------
describe('B1 compact JSON partitions', () => {
  it('writes the live partition, archive and trash compactly and reads both forms', async () => {
    const dir = await freshDir('compact');
    const s = new JsonStorage(path.join(dir, 'tasks.json'), { isDefault: true });
    const tasks = [card('c1'), card('c2')];
    await s.save(tasks);
    await s.saveArchive([card('a1')]);
    await s.saveTrash([card('t1')]);
    for (const f of [s.filePath, s.archiveFile, s.trashFile]) {
      const raw = await readFile(f, 'utf-8');
      assert.ok(!raw.includes('\n'), `${path.basename(f)} is compact`);
    }
    assert.deepEqual((await s.load()).map((t) => t.id), ['c1', 'c2']);
    assert.deepEqual((await s.loadArchive()).map((t) => t.id), ['a1']);
    assert.deepEqual((await s.loadTrash()).map((t) => t.id), ['t1']);

    // A pretty-printed partition from an earlier release still loads.
    await writeFile(s.filePath, JSON.stringify({ tasks: [card('legacy')] }, null, 2));
    assert.deepEqual((await s.load()).map((t) => t.id), ['legacy']);
  });
});

// ---------------------------------------------------------------------------
describe('COR-14 task id validation and git path arguments', () => {
  it('rejects ids that begin with a hyphen and keeps ordinary ids valid', () => {
    for (const bad of ['-n', '--all', '-', '-abc']) assert.equal(isValidTaskId(bad), false, bad);
    for (const ok of ['a-b', '_x', 'T1', 'a--b', 'x-']) assert.equal(isValidTaskId(ok), true, ok);
  });

  it('createTask answers 400 for an option-shaped id', async () => {
    const dir = await freshDir('cor14-store');
    store.setStorage(new JsonStorage(path.join(dir, 'tasks.json'), { isDefault: true }));
    await store.loadStore();
    const ok = await store.createTask({ id: 'ok-id', title: 'Good id', status: 'BACKLOG', round: 1 });
    assert.ok(ok.task, 'an ordinary hyphenated id is still accepted');
    const res = await store.createTask({ id: '--all', title: 'Bad id', status: 'BACKLOG', round: 1 });
    assert.equal(res.status, 400);
    assert.match(res.error, /Invalid task id/);
    assert.equal(store.getTask('--all'), null);
    store.setStorage(null);
  });

  it('git storage passes card paths after "--" so a hyphenated file name commits cleanly', async () => {
    const dir = await gitRepo('cor14-git');
    const s = new GitYamlStorage(dir);
    // Bypasses id validation on purpose: the storage layer must be safe on its own.
    await s.saveTask(card('-n'));
    assert.equal(await commitCount(dir), 1);
    assert.equal(await porcelain(dir), '');
    await s.deleteTask(card('-n'));
    assert.equal(existsSync(path.join(dir, '-n.yml')), false);
    assert.equal(await commitCount(dir), 2);
  });
});

// ---------------------------------------------------------------------------
describe('C7 git backend rolls the working tree back when a commit fails', () => {
  it('a failed create leaves no card file and nothing staged', async () => {
    const dir = await gitRepo('c7-create');
    const s = new GitYamlStorage(dir);
    await s.saveTask(card('base'));
    await failCommits(dir);
    await assert.rejects(s.saveTask(card('g1')), /commit failed/);
    assert.equal(existsSync(path.join(dir, 'g1.yml')), false);
    assert.equal(await porcelain(dir), '');
    // Nothing from the failed write rides along with the next commit.
    await allowCommits(dir);
    await s.saveTask(card('g2'));
    const { stdout } = await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir });
    assert.deepEqual(stdout.trim().split('\n'), ['g2.yml']);
    assert.deepEqual((await s.load()).map((t) => t.id).sort(), ['base', 'g2']);
  });

  it('a failed update restores the previous card content', async () => {
    const dir = await gitRepo('c7-update');
    const s = new GitYamlStorage(dir);
    await s.saveTask(card('u1'));
    const before = await readFile(path.join(dir, 'u1.yml'), 'utf-8');
    await failCommits(dir);
    await assert.rejects(s.saveTask(card('u1', { status: 'IN_PROGRESS', version: 2 })));
    assert.equal(await readFile(path.join(dir, 'u1.yml'), 'utf-8'), before);
    assert.equal(await porcelain(dir), '');
  });

  it('a failed archive keeps the live card and drops the new archive entry', async () => {
    const dir = await gitRepo('c7-archive');
    const s = new GitYamlStorage(dir);
    await s.saveTask(card('d1', { status: 'DONE' }));
    const before = await readFile(path.join(dir, 'd1.yml'), 'utf-8');
    await failCommits(dir);
    await assert.rejects(s.saveArchiveTask(card('d1', { status: 'DONE' })));
    assert.equal(await readFile(path.join(dir, 'd1.yml'), 'utf-8'), before);
    assert.equal(existsSync(path.join(dir, 'archive', 'default', 'd1.yml')), false);
    assert.equal(await porcelain(dir), '');
  });

  it('a failed hard delete restores the card', async () => {
    const dir = await gitRepo('c7-delete');
    const s = new GitYamlStorage(dir);
    await s.saveTask(card('x1'));
    const before = await readFile(path.join(dir, 'x1.yml'), 'utf-8');
    await failCommits(dir);
    await assert.rejects(s.deleteTask(card('x1')));
    assert.equal(await readFile(path.join(dir, 'x1.yml'), 'utf-8'), before);
    assert.equal(await porcelain(dir), '');
  });

  it('a failed batch restores every card in the batch', async () => {
    const dir = await gitRepo('c7-batch');
    const s = new GitYamlStorage(dir);
    await s.saveTask(card('b1'));
    await s.saveTask(card('b2'));
    const b1 = await readFile(path.join(dir, 'b1.yml'), 'utf-8');
    const b2 = await readFile(path.join(dir, 'b2.yml'), 'utf-8');
    await failCommits(dir);
    await assert.rejects(s.saveTasks([
      card('b1', { status: 'IN_PROGRESS' }), card('b2', { status: 'IN_PROGRESS' }), card('b3'),
    ]), /commit failed/);
    assert.equal(await readFile(path.join(dir, 'b1.yml'), 'utf-8'), b1);
    assert.equal(await readFile(path.join(dir, 'b2.yml'), 'utf-8'), b2);
    assert.equal(existsSync(path.join(dir, 'b3.yml')), false);
    assert.equal(await porcelain(dir), '');
  });
});

// ---------------------------------------------------------------------------
describe('COR-10 git backend with auto-commit off', () => {
  it('archiving removes the live card file (no git repository needed)', async () => {
    const dir = await freshDir('cor10-plain');
    const s = new GitYamlStorage(dir, { autoCommit: false });
    await s.saveTask(card('a1', { status: 'DONE' }));
    await s.saveArchiveTask(card('a1', { status: 'DONE' }));
    assert.equal(existsSync(path.join(dir, 'a1.yml')), false);
    assert.ok(existsSync(path.join(dir, 'archive', 'default', 'a1.yml')));
    assert.deepEqual(await s.load(), []);
    assert.deepEqual((await s.loadArchive()).map((t) => t.id), ['a1']);
  });

  it('an archived card neither returns nor duplicates across restarts', async () => {
    const dir = await freshDir('cor10-store');
    const old = '2020-01-01T00:00:00.000Z';
    const s1 = new GitYamlStorage(dir, { autoCommit: false });
    await s1.saveTask(card('old-done', { status: 'DONE', completed_at: old, created_at: old, updated: old }));
    store.setStorage(s1);
    await store.loadStore(); // boot sweep archives the old DONE card
    assert.equal(store.getTask('old-done'), null);
    for (let i = 0; i < 2; i++) {
      store.setStorage(null);
      store.setStorage(new GitYamlStorage(dir, { autoCommit: false }));
      await store.loadStore();
      assert.equal(store.getTask('old-done'), null, `restart ${i + 1}: not live`);
      assert.deepEqual(store.getArchivedTasks('default').map((t) => t.id), ['old-done'], `restart ${i + 1}: archived once`);
    }
    store.setStorage(null);
  });

  it('a live card left next to its identical archive entry is skipped and cleaned on load', async () => {
    const dir = await freshDir('cor10-leftover');
    const s = new GitYamlStorage(dir, { autoCommit: false });
    const done = card('left', { status: 'DONE' });
    await s.saveTask(done);
    // Simulate the earlier behaviour: archive entry written, live card kept.
    await mkdir(path.join(dir, 'archive', 'default'), { recursive: true });
    await writeFile(
      path.join(dir, 'archive', 'default', 'left.yml'),
      yaml.stringify(s.serializeCard({ ...done, archived_at: '2026-02-01T00:00:00.000Z' }, 'DONE')),
    );
    // A re-created task reusing an archived id is a different card and stays.
    await s.saveTask(card('reused', { created_at: '2026-03-01T00:00:00.000Z' }));
    await writeFile(
      path.join(dir, 'archive', 'default', 'reused.yml'),
      yaml.stringify(s.serializeCard({ ...card('reused', { status: 'DONE' }), archived_at: '2026-02-01T00:00:00.000Z' }, 'DONE')),
    );
    assert.deepEqual((await s.load()).map((t) => t.id), ['reused']);
    assert.equal(existsSync(path.join(dir, 'left.yml')), false);
  });
});

// ---------------------------------------------------------------------------
describe('PERF-02 git backend batches renewals into at most one commit', () => {
  const lease = (id, at) => card(id, {
    status: 'IN_PROGRESS', assigned_agent: 'agent-1', claim_expires_at: at, updated: at,
  });

  it('a lease-only renewal batch writes the cards without committing', async () => {
    const dir = await gitRepo('perf02-lease');
    const s = new GitYamlStorage(dir);
    for (const id of ['h1', 'h2', 'h3']) await s.saveTask(lease(id, '2026-01-01T00:10:00.000Z'));
    const before = await commitCount(dir);
    const renewed = ['h1', 'h2', 'h3'].map((id) => lease(id, '2026-01-01T00:20:00.000Z'));
    await s.saveTasks(renewed, renewed);
    assert.equal(await commitCount(dir), before, 'no commit for a pure lease renewal');
    const loaded = await s.load();
    assert.ok(loaded.every((t) => t.claim_expires_at === '2026-01-01T00:20:00.000Z'), 'renewed lease is on disk');
  });

  it('a batch with real changes makes exactly one commit holding only the changed cards', async () => {
    const dir = await gitRepo('perf02-batch');
    const s = new GitYamlStorage(dir);
    for (const id of ['h1', 'h2', 'h3']) await s.saveTask(lease(id, '2026-01-01T00:10:00.000Z'));
    const before = await commitCount(dir);
    const batch = [
      { ...lease('h1', '2026-01-01T00:20:00.000Z'), version: 2, title: 'changed' },
      lease('h2', '2026-01-01T00:20:00.000Z'),
      { ...lease('h3', '2026-01-01T00:20:00.000Z'), version: 2 },
    ];
    await s.saveTasks(batch, batch);
    assert.equal(await commitCount(dir), before + 1);
    const { stdout } = await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir });
    assert.deepEqual(stdout.trim().split('\n').sort(), ['h1.yml', 'h3.yml']);
  });
});

// ---------------------------------------------------------------------------
describe('COR-11 backups cover every storage file', () => {
  async function seedDefault(fileHome) {
    await mkdir(path.join(fileHome, 'archive'), { recursive: true });
    await mkdir(path.join(fileHome, 'trash'), { recursive: true });
    await writeFile(path.join(fileHome, 'tasks.json'), JSON.stringify({ tasks: [card('d1')] }));
    await writeFile(path.join(fileHome, 'tasks.json.journal.jsonl'), '');
    await writeFile(path.join(fileHome, 'archive', 'default.json'), JSON.stringify({ tasks: [card('da')] }));
    await writeFile(path.join(fileHome, 'trash', 'default.json'), JSON.stringify({ tasks: [card('dt')] }));
    await writeFile(path.join(fileHome, 'settings.json'), JSON.stringify({ wip: 3 }));
  }
  async function seedNamed(dataHome) {
    await mkdir(path.join(dataHome, 'tasks', 'archive'), { recursive: true });
    await mkdir(path.join(dataHome, 'settings'), { recursive: true });
    await mkdir(path.join(dataHome, 'spill', 'atlas'), { recursive: true });
    await writeFile(path.join(dataHome, 'tasks', 'atlas.json'), JSON.stringify({ project: 'atlas', tasks: [card('n1')] }));
    await writeFile(path.join(dataHome, 'tasks', 'archive', 'atlas.json'), JSON.stringify({ tasks: [] }));
    await writeFile(path.join(dataHome, 'settings', 'atlas.json'), JSON.stringify({}));
    await writeFile(path.join(dataHome, 'spill', 'atlas', 'n1.jsonl'), '{}\n');
  }
  async function latestSnapshot(root) {
    const stamps = (await readdir(root)).sort();
    return path.join(root, stamps[stamps.length - 1]);
  }
  async function listFiles(dir, prefix = '') {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...await listFiles(path.join(dir, e.name), rel));
      else out.push(rel);
    }
    return out.sort();
  }

  it('includes the default project when KANBAN_DATA_FILE lies outside KANBAN_DATA_DIR, and restores it', async () => {
    const base = await freshDir('cor11-split');
    const dataHome = path.join(base, 'datahome');
    const fileHome = path.join(base, 'filehome');
    await seedDefault(fileHome);
    await seedNamed(dataHome);
    process.env.KANBAN_DATA_DIR = dataHome;
    process.env.KANBAN_DATA_FILE = path.join(fileHome, 'tasks.json');
    try {
      await store.runBackupNow();
    } finally {
      process.env.KANBAN_DATA_DIR = path.join(tmpRoot, 'default-data');
      process.env.KANBAN_DATA_FILE = path.join(tmpRoot, 'default-data', 'tasks.json');
    }
    const snap = await latestSnapshot(path.join(dataHome, 'backups'));
    const files = await listFiles(snap);
    for (const f of [
      'tasks.json', 'tasks.json.journal.jsonl', 'archive/default.json', 'trash/default.json', 'settings.json',
      'tasks/atlas.json', 'tasks/archive/atlas.json', 'settings/atlas.json', 'spill/atlas/n1.jsonl',
      'backup-manifest.json',
    ]) assert.ok(files.includes(f), `snapshot has ${f}`);
    const manifest = JSON.parse(await readFile(path.join(snap, 'backup-manifest.json'), 'utf-8'));
    assert.equal(manifest.split, true);
    assert.equal(manifest.default_project.dir, path.resolve(fileHome));

    // Restore into fresh directories: named data to --into, the default
    // project to --default-into.
    const newData = path.join(base, 'restored-data');
    const newFile = path.join(base, 'restored-file');
    await execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', newData, '--default-into', newFile]);
    assert.deepEqual(await listFiles(newFile),
      ['archive/default.json', 'settings.json', 'tasks.json', 'tasks.json.journal.jsonl', 'trash/default.json']);
    const restoredData = await listFiles(newData);
    assert.ok(restoredData.includes('tasks/atlas.json'));
    assert.ok(restoredData.includes('spill/atlas/n1.jsonl'));
    assert.ok(!restoredData.includes('tasks.json'), 'default files went to --default-into');
    assert.ok(!restoredData.includes('backup-manifest.json'), 'manifest is not copied into the data dir');
  });

  it('includes the default archive, trash and settings when KANBAN_DATA_DIR is unset', async () => {
    const base = await freshDir('cor11-noenv');
    const fileHome = path.join(base, 'filehome');
    const jsonHome = path.join(base, 'jsonhome');
    await seedDefault(fileHome);
    await seedNamed(jsonHome);
    delete process.env.KANBAN_DATA_DIR;
    process.env.KANBAN_GIT_DIR = jsonHome; // jsonDataDir() fallback, kept off the real server/data
    process.env.KANBAN_DATA_FILE = path.join(fileHome, 'tasks.json');
    try {
      await store.runBackupNow();
    } finally {
      delete process.env.KANBAN_GIT_DIR;
      process.env.KANBAN_DATA_DIR = path.join(tmpRoot, 'default-data');
      process.env.KANBAN_DATA_FILE = path.join(tmpRoot, 'default-data', 'tasks.json');
    }
    const snap = await latestSnapshot(path.join(fileHome, 'backups'));
    const files = await listFiles(snap);
    for (const f of [
      'tasks.json', 'archive/default.json', 'trash/default.json', 'settings.json',
      'tasks/atlas.json', 'settings/atlas.json', 'spill/atlas/n1.jsonl',
    ]) assert.ok(files.includes(f), `snapshot has ${f}`);
    assert.ok(!files.some((f) => f.startsWith('backups/')), 'snapshot does not nest earlier snapshots');
  });

  it('a snapshot without a manifest still restores as before', async () => {
    const base = await freshDir('cor11-legacy');
    const snap = path.join(base, 'snap');
    await seedDefault(snap);
    const into = path.join(base, 'into');
    const { stdout } = await execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', into]);
    assert.match(stdout, /copy complete/);
    assert.ok(existsSync(path.join(into, 'tasks.json')));
    assert.ok(existsSync(path.join(into, 'archive', 'default.json')));
  });
});
