/**
 * Hardening: journal-aware project discovery and flag-independent journal load.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, utimes, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';
import { JsonStorage } from '../storage.js';
import { listJsonProjects } from '../store/core.js';

describe('journal load path', () => {
  let tmpDir;
  let tasksDir;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-journalload-'));
    tasksDir = path.join(tmpDir, 'tasks');
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'default-tasks.json');
  });

  beforeEach(async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '0';
    delete process.env.KANBAN_JOURNAL_COMPACT_BYTES;
    store.setStorage(null);
    await rm(tasksDir, { recursive: true, force: true });
    await mkdir(tasksDir, { recursive: true });
  });

  after(async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '0';
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
    await rm(tmpDir, { recursive: true, force: true });
  });

  const task = (id, title) => ({ id, title, status: 'BACKLOG', version: 1, project: 'jp' });
  const storageFor = () => new JsonStorage(path.join(tasksDir, 'jp.json'), { project: 'jp' });

  it('discovers a journal-only project once, validated by project id', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(tasksDir, 'jp.json.journal.jsonl'), '');
    await writeFile(path.join(tasksDir, 'both.json'), '{"tasks":[]}');
    await writeFile(path.join(tasksDir, 'both.json.journal.jsonl'), '');
    await writeFile(path.join(tasksDir, '..bad.json.journal.jsonl'), '');
    const ids = (await listJsonProjects()).sort();
    assert.deepEqual(ids, ['both', 'jp']);
  });

  it('a journal-only named project survives a store reload', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    await store.loadStore();
    await store.createTask({ id: 'jo-1', title: 'journaled only', status: 'BACKLOG', round: 1 }, 'jp');
    assert.ok(!existsSync(path.join(tasksDir, 'jp.json')), 'no compacted base yet');
    store.setStorage(null);
    await store.loadStore();
    assert.ok(store.getTasks('jp').some((t) => t.id === 'jo-1'));
  });

  it('ON -> OFF reload keeps every write, and the next OFF save clears the journal', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const on = storageFor();
    await on.save([task('a', 'a0')]);
    await on.saveTask(task('b', 'b0'), [task('a', 'a0'), task('b', 'b0')]);
    process.env.KANBAN_STORAGE_JOURNAL = '0';
    const off = storageFor();
    const loaded = await off.load();
    assert.deepEqual(loaded.map((t) => t.id).sort(), ['a', 'b']);
    await off.save(loaded);
    assert.ok(!existsSync(`${off.filePath}.journal.jsonl`), 'journal removed by a full save');
  });

  it('an OFF save after ON writes does not let a later ON reload resurrect stale state', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const s = storageFor();
    await s.save([task('a', 'old')]);
    await s.saveTask(task('a', 'stale-journaled'), [task('a', 'stale-journaled')]);
    process.env.KANBAN_STORAGE_JOURNAL = '0';
    await s.save([task('a', 'newest'), task('c', 'c0')]);
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const loaded = await storageFor().load();
    const byId = Object.fromEntries(loaded.map((t) => [t.id, t.title]));
    assert.deepEqual(byId, { a: 'newest', c: 'c0' });
    const base = JSON.parse(await readFile(s.filePath, 'utf-8'));
    assert.equal(base.tasks.length, 2);
  });

  const writeJournal = async (file, entries) =>
    writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const ageJournal = async (file) => {
    const old = new Date(Date.now() - 3600_000);
    await utimes(file, old, old);
  };

  for (const flag of ['off', 'on']) {
    it(`a journal older than the base is not replayed, is moved aside, and does not resurrect deleted tasks (flag ${flag})`, async () => {
      if (flag === 'on') process.env.KANBAN_STORAGE_JOURNAL = '1';
      const s = storageFor();
      // Newer base: t1 at v9, t2 was deleted.
      await s.save([{ ...task('t1', 'current'), version: 9 }]);
      const journal = `${s.filePath}.journal.jsonl`;
      await writeJournal(journal, [
        { op: 'upsert', id: 't1', task: { ...task('t1', 'old'), version: 2 } },
        { op: 'upsert', id: 't2', task: task('t2', 'deleted-later') },
      ]);
      await ageJournal(journal);
      const loaded = await storageFor().load();
      assert.deepEqual(loaded.map((t) => [t.id, t.version]), [['t1', 9]]);
      assert.ok(!existsSync(journal), 'journal no longer in place');
      const aside = (await readdir(tasksDir)).filter((f) => f.includes('.journal.jsonl.stale-'));
      assert.equal(aside.length, 1);
    });
  }

  it('a lower-version upsert in a fresh journal is ignored', async () => {
    const s = storageFor();
    await s.save([{ ...task('t1', 'current'), version: 5 }]);
    const journal = `${s.filePath}.journal.jsonl`;
    await writeJournal(journal, [
      { op: 'upsert', id: 't1', task: { ...task('t1', 'older'), version: 3 } },
      { op: 'upsert', id: 't1', task: { ...task('t1', 'newer'), version: 6 } },
      { op: 'upsert', id: 't1', task: { ...task('t1', 'older-again'), version: 4 } },
    ]);
    const loaded = await storageFor().load();
    assert.deepEqual(loaded.map((t) => [t.title, t.version]), [['newer', 6]]);
  });
});
