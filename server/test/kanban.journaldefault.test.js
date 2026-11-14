/**
 * v3.16.0: the JSON append-only journal is on by default. Unset means on,
 * `0`/`false` opts out, `1` keeps working; an existing (pre-journal) data
 * directory loads and then journals; switching the flag later folds safely.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';
import { JsonStorage } from '../storage.js';

describe('journal default', () => {
  let tmpDir;
  let dataFile;
  const saved = {};
  const KEYS = ['KANBAN_STORAGE_JOURNAL', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_REAP_ENABLED'];
  const jfile = () => `${dataFile}.journal.jsonl`;
  const task = (id) => ({ id, title: id, status: 'BACKLOG', round: 1 });

  before(() => { for (const k of KEYS) { saved[k] = process.env[k]; } });
  beforeEach(async () => {
    delete process.env.KANBAN_STORAGE_JOURNAL;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    process.env.KANBAN_REAP_ENABLED = 'false';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-journaldefault-'));
    dataFile = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = dataFile;
    store.setStorage(null);
  });
  after(async () => {
    store.setStorage(null);
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('flag parsing: unset/1/empty are on; 0/false/off/no (any case) are off', () => {
    const s = new JsonStorage(dataFile);
    delete process.env.KANBAN_STORAGE_JOURNAL;
    assert.equal(s._journalEnabled(), true);
    for (const v of ['1', 'true', '']) { process.env.KANBAN_STORAGE_JOURNAL = v; assert.equal(s._journalEnabled(), true, v); }
    for (const v of ['0', 'false', 'FALSE', ' off ', 'no']) { process.env.KANBAN_STORAGE_JOURNAL = v; assert.equal(s._journalEnabled(), false, v); }
  });

  it('upgrade: a pre-journal data dir loads, the first write journals, a reload sees it', async () => {
    await writeFile(dataFile, JSON.stringify({ tasks: [{ ...task('old-1'), version: 1, project: 'default' }] }, null, 2));
    assert.ok(!existsSync(jfile()));
    await store.loadStore();
    assert.ok(store.getTasks().some((t) => t.id === 'old-1'), 'legacy base loads');
    const base = await readFile(dataFile, 'utf8');
    await store.createTask(task('new-1'));
    assert.ok(existsSync(jfile()), 'journal created on first write');
    assert.equal(await readFile(dataFile, 'utf8'), base, 'base file not rewritten by a journalled write');
    store.setStorage(null);
    await store.loadStore();
    const ids = store.getTasks().map((t) => t.id);
    assert.ok(ids.includes('old-1') && ids.includes('new-1'));
  });

  it('opt-out (KANBAN_STORAGE_JOURNAL=0) rewrites the partition and creates no journal', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '0';
    await store.loadStore();
    await store.createTask(task('off-1'));
    assert.ok(!existsSync(jfile()), 'no journal when opted out');
    const data = JSON.parse(await readFile(dataFile, 'utf8'));
    assert.ok(data.tasks.some((t) => t.id === 'off-1'));
  });

  it('default on -> opt out later: journalled writes survive and the next full save clears the journal', async () => {
    await store.loadStore();
    await store.createTask(task('j-1'));
    assert.ok(existsSync(jfile()));
    process.env.KANBAN_STORAGE_JOURNAL = '0';
    store.setStorage(null);
    await store.loadStore();
    assert.ok(store.getTasks().some((t) => t.id === 'j-1'), 'journal replayed although opted out');
    await store.createTask(task('j-2'));
    assert.ok(!existsSync(jfile()) || (await readFile(jfile(), 'utf8')) === '', 'full save cleared the journal');
    store.setStorage(null);
    await store.loadStore();
    const ids = store.getTasks().map((t) => t.id);
    assert.ok(ids.includes('j-1') && ids.includes('j-2'));
  });
});
