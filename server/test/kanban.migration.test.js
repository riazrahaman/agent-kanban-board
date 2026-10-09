import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as store from '../store.js';

describe('8-state workflow data migration (ADR-004, v3.0.0)', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-migration-test-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('migrates legacy stored BUILDING and IN_TEST statuses and stage_owners to IN_PROGRESS and VALIDATION idempotently', async () => {
    const tasksFile = path.join(tmpDir, 'tasks.json');
    const legacyData = [
      {
        id: 'legacy-build',
        title: 'Legacy Building Task',
        status: 'BUILDING',
        stage_owners: {
          BUILDING: 'agent-builder-1',
        },
        version: 2,
      },
      {
        id: 'legacy-test',
        title: 'Legacy In Test Task',
        status: 'IN_TEST',
        stage_owners: {
          BUILDING: 'agent-builder-1',
          IN_TEST: 'agent-tester-1',
        },
        version: 3,
      },
      {
        id: 'legacy-todo',
        title: 'Legacy Todo Task',
        status: 'TODO',
        version: 1,
      },
      {
        id: 'canonical-review',
        title: 'Canonical In Review Task',
        status: 'IN_REVIEW',
        stage_owners: {
          IN_PROGRESS: 'agent-builder-2',
          IN_REVIEW: 'agent-reviewer-1',
        },
        version: 2,
      },
    ];

    await writeFile(tasksFile, JSON.stringify({ tasks: legacyData }, null, 2), 'utf8');

    // First load
    store.setStorage(null);
    await store.loadStore();

    const t1 = store.getTask('legacy-build');
    assert.ok(t1);
    assert.equal(t1.status, 'IN_PROGRESS');
    assert.equal(t1.stage_owners.IN_PROGRESS, 'agent-builder-1');
    assert.equal(t1.stage_owners.BUILDING, undefined);

    const t2 = store.getTask('legacy-test');
    assert.ok(t2);
    assert.equal(t2.status, 'VALIDATION');
    assert.equal(t2.stage_owners.IN_PROGRESS, 'agent-builder-1');
    assert.equal(t2.stage_owners.VALIDATION, 'agent-tester-1');

    const t3 = store.getTask('legacy-todo');
    assert.ok(t3);
    assert.equal(t3.status, 'BACKLOG');

    const t4 = store.getTask('canonical-review');
    assert.ok(t4);
    assert.equal(t4.status, 'IN_REVIEW');
    assert.equal(t4.stage_owners.IN_PROGRESS, 'agent-builder-2');
    assert.equal(t4.stage_owners.IN_REVIEW, 'agent-reviewer-1');

    // Second load (idempotency check)
    await store.loadStore();

    const t1Again = store.getTask('legacy-build');
    assert.equal(t1Again.status, 'IN_PROGRESS');
    assert.equal(t1Again.stage_owners.IN_PROGRESS, 'agent-builder-1');
  });
});
