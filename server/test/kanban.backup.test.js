import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';

const ENV = [
  'KANBAN_BACKUP_ENABLED',
  'KANBAN_BACKUP_INTERVAL_MS',
  'KANBAN_BACKUP_KEEP',
  'KANBAN_DATA_DIR',
  'KANBAN_DATA_FILE',
];

describe('§2.7 periodic backup', () => {
  let tmpDir;
  let savedEnv = {};

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-backup-'));
    for (const k of ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  after(async () => {
    store.stopBackup();
    for (const k of ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('disabled by default: isBackupRunning() false and startBackup() returns null', () => {
    assert.equal(store.isBackupRunning(), false);
    assert.equal(store.startBackup(), null);
    assert.equal(store.isBackupRunning(), false);
  });

  it('enabled: a backup run produces files under backups/ and rotates to keep KANBAN_BACKUP_KEEP', async () => {
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_BACKUP_ENABLED = 'true';
    process.env.KANBAN_BACKUP_INTERVAL_MS = '50';
    process.env.KANBAN_BACKUP_KEEP = '2';

    await writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify({ tasks: [] }), 'utf-8');
    await mkdir(path.join(tmpDir, 'tasks'), { recursive: true });
    await writeFile(path.join(tmpDir, 'tasks', 'alpha.json'), JSON.stringify({ project: 'alpha', tasks: [] }), 'utf-8');
    await mkdir(path.join(tmpDir, 'archive'), { recursive: true });
    await writeFile(path.join(tmpDir, 'archive', 'alpha.json'), JSON.stringify({ tasks: [] }), 'utf-8');

    for (let i = 0; i < 3; i++) {
      await store.runBackupNow();
      await new Promise((r) => setTimeout(r, 30));
    }

    const backupsDir = path.join(tmpDir, 'backups');
    assert.ok(existsSync(backupsDir), 'backups/ created');
    const stamps = (await readdir(backupsDir)).filter((n) => n !== 'backups').sort();
    assert.ok(stamps.length > 0, 'backup stamp dirs exist');
    assert.ok(stamps.length <= 2, `rotated to keep <= 2, got ${stamps.length}`);

    const newest = stamps[stamps.length - 1];
    const stampDir = path.join(backupsDir, newest);
    assert.ok(existsSync(path.join(stampDir, 'tasks.json')), 'default live file copied');
    assert.ok(existsSync(path.join(stampDir, 'tasks', 'alpha.json')), 'named project copied');
    assert.ok(existsSync(path.join(stampDir, 'archive', 'alpha.json')), 'archive copied');
  });

  it('timer is unref\u2019d (startBackup timer does not keep the process alive)', () => {
    process.env.KANBAN_BACKUP_ENABLED = 'true';
    process.env.KANBAN_BACKUP_INTERVAL_MS = '50';
    process.env.KANBAN_BACKUP_KEEP = '2';
    const t = store.startBackup();
    assert.notEqual(t, null);
    assert.equal(t.hasRef(), false, 'backup timer is unref\u2019d');
    store.stopBackup();
    assert.equal(store.isBackupRunning(), false);
  });
});
