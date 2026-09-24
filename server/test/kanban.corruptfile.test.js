import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';

// BUG-01 (v2.5.2): a corrupt data file must fail CLOSED — the store refuses to
// boot instead of starting empty and letting the next save overwrite the
// (possibly recoverable) file.

describe('corrupt data file fails closed (v2.5.2)', () => {
  let tmpDir;

  before(async () => {
    process.env.KANBAN_REAP_ENABLED = 'false';
    process.env.KANBAN_DEFAULT_PROJECT = 'default';
    delete process.env.KANBAN_STORAGE_BACKEND;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-corrupt-'));
  });

  after(async () => {
    store.stopReaper();
    store.setStorage(null);
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_REAP_ENABLED;
  });

  it('1. absent data file loads as empty (normal first boot)', async () => {
    const filePath = path.join(tmpDir, 'absent.json');
    const storage = new store.JsonStorage(filePath, { project: 'default', isDefault: true });
    const loaded = await storage.load();
    assert.deepEqual(loaded, []);
    assert.equal(existsSync(filePath), false, 'load must not create the file');
  });

  it('2. corrupt JSON -> load throws and the file is NOT overwritten', async () => {
    const filePath = path.join(tmpDir, 'corrupt.json');
    const corrupt = '{tasks: [ {id: "x", BROKEN';
    await writeFile(filePath, corrupt, 'utf-8');
    const storage = new store.JsonStorage(filePath, { project: 'default', isDefault: true });
    await assert.rejects(() => storage.load(), 'corrupt file must refuse to load');
    // The file bytes are unchanged — the failed boot must not wipe the data.
    const after = await readFile(filePath, 'utf-8');
    assert.equal(after, corrupt, 'corrupt file preserved byte-for-byte');
  });

  it('3. loadStore refuses to boot with a corrupt default partition', async () => {
    const filePath = path.join(tmpDir, 'tasks.json');
    const corrupt = 'not-json-at-all';
    await writeFile(filePath, corrupt, 'utf-8');
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = filePath;
    try {
      await assert.rejects(() => store.loadStore(), { message: /not-json-at-all|Unexpected/ });
      const raw = await readFile(filePath, 'utf-8');
      assert.equal(raw, corrupt, 'corrupt file preserved after the failed boot');
    } finally {
      delete process.env.KANBAN_DATA_DIR;
      delete process.env.KANBAN_DATA_FILE;
      store.setStorage(null);
    }
  });

  it('4. valid file round-trips (regression)', async () => {
    const filePath = path.join(tmpDir, 'valid.json');
    const storage = new store.JsonStorage(filePath, { project: 'default', isDefault: true });
    const task = { id: 'ok-1', project: 'default', title: 'ok', status: 'BACKLOG', round: 1 };
    await storage.save([task]);
    const loaded = await storage.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'ok-1');
    assert.equal(loaded[0].version, 1, 'backfill applied');
  });

  it('5. git backend: corrupt per-card file is skipped (warn) but the dir loads', async () => {
    const gitDir = path.join(tmpDir, 'git-proj');
    const storage = new store.GitYamlStorage(gitDir, { project: 'gitproj', autoCommit: false });
    await storage.saveTask({
      id: 'g-1', project: 'gitproj', title: 'card', status: 'BACKLOG', round: 1,
      agent_logs: [], issues: [], depends_on: [], stage_owners: {},
      created_at: new Date().toISOString(), updated: new Date().toISOString(), version: 1,
    });
    await writeFile(path.join(gitDir, 'broken.yml'), '{{{{ not: yaml', 'utf-8');
    const loaded = await storage.load();
    const ids = loaded.map((t) => t.id);
    assert.ok(ids.includes('g-1'), 'valid card loads');
    assert.ok(!ids.includes(undefined), 'broken card skipped without crashing');
    // Clean up so tmpDir rm does not fail on the nested git dir.
    await rm(gitDir, { recursive: true, force: true });
  });
});