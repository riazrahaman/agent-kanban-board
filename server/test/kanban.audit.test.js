import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';
import {
  auditLogEnabled,
  auditLogDir,
  auditLogPath,
  appendAudit,
  readAudit,
  resetAuditLog,
} from '../auditLog.js';

// §2.9 (v2.9.0): persisted audit stream + GET /api/audit (ENH-04).

const TOKEN = 'pi03-audit-token';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function headers(role = 'admin', agentId = 'audit-agent') {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
}

describe('KB-14 persisted audit stream (§2.9, v2.9.0)', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let unsubAudit;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_REAP_ENABLED = 'false';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-audit-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUDIT_LOG = '1';
    store.setStorage(null);
    await store.loadStore();
    // startServer wires this; createApp does not, so mirror it here.
    unsubAudit = store.onAudit(appendAudit);
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    if (unsubAudit) unsubAudit();
    store.setStorage(null);
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUDIT_LOG;
  });

  beforeEach(async () => {
    await resetAuditLog();
  });

  it('auditLogEnabled parses the flag', () => {
    assert.equal(auditLogEnabled({ KANBAN_AUDIT_LOG: undefined }), false);
    assert.equal(auditLogEnabled({ KANBAN_AUDIT_LOG: '' }), false);
    assert.equal(auditLogEnabled({ KANBAN_AUDIT_LOG: '0' }), false);
    assert.equal(auditLogEnabled({ KANBAN_AUDIT_LOG: 'false' }), false);
    assert.equal(auditLogEnabled({ KANBAN_AUDIT_LOG: '1' }), true);
    assert.equal(auditLogEnabled({ KANBAN_AUDIT_LOG: 'true' }), true);
  });

  it('auditLogDir prefers KANBAN_DATA_DIR, then dirname(DATA_FILE)', () => {
    assert.equal(auditLogDir({ KANBAN_DATA_DIR: '/data' }), '/data');
    assert.equal(
      auditLogDir({ KANBAN_DATA_FILE: '/var/x/tasks.json' }),
      '/var/x',
    );
  });

  it('appendAudit writes one compact JSONL line and readAudit reads it back', async () => {
    await appendAudit({
      ts: '2026-09-25T10:00:00.000Z',
      kind: 'created',
      project: 'alpha',
      task: { id: 'a-1', title: 'should not be stored whole' },
      actor: 'builder-1',
      reason: null,
    });
    const raw = await readFile(auditLogPath(), 'utf8');
    assert.equal(raw.trim().split('\n').length, 1);
    assert.ok(!raw.includes('should not be stored whole'), 'only task_id is persisted');

    const entries = await readAudit();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].task_id, 'a-1');
    assert.equal(entries[0].project, 'alpha');
    assert.equal(entries[0].kind, 'created');
  });

  it('readAudit is newest-first and honours limit / project / kind / since', async () => {
    await appendAudit({ ts: '2026-09-25T10:00:00.000Z', kind: 'created', project: 'alpha', task: { id: 'a-1' } });
    await appendAudit({ ts: '2026-09-25T10:00:01.000Z', kind: 'updated', project: 'alpha', task: { id: 'a-2' } });
    await appendAudit({ ts: '2026-09-25T10:00:02.000Z', kind: 'created', project: 'beta', task: { id: 'b-1' } });

    const all = await readAudit();
    assert.deepEqual(all.map((e) => e.task_id), ['b-1', 'a-2', 'a-1']);
    assert.deepEqual((await readAudit({ limit: 2 })).map((e) => e.task_id), ['b-1', 'a-2']);
    assert.deepEqual((await readAudit({ project: 'alpha' })).map((e) => e.task_id), ['a-2', 'a-1']);
    assert.deepEqual((await readAudit({ kind: 'created' })).map((e) => e.task_id), ['b-1', 'a-1']);
    assert.deepEqual((await readAudit({ since: '2026-09-25T10:00:01.000Z' })).map((e) => e.task_id), ['b-1', 'a-2']);
  });

  it('readAudit returns [] when the file does not exist', async () => {
    await resetAuditLog();
    assert.deepEqual(await readAudit(), []);
  });

  it('a real mutation is persisted and exposed via GET /api/audit', async () => {
    const create = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: headers('admin'),
      body: JSON.stringify({ id: 'aud-1', title: 'Audited card', status: 'BACKLOG', project: 'default', round: 1 }),
    });
    assert.equal(create.status, 201);

    const res = await fetch(`${baseUrl}/api/audit`, { headers: headers('builder') });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.ok(body.count >= 1, 'at least the create should be audited');
    const found = body.entries.find((e) => e.task_id === 'aud-1');
    assert.ok(found, 'the created task id must appear in the audit stream');
    assert.equal(found.kind, 'created');
  });

  it('GET /api/audit works unauthenticated (reads are open by default)', async () => {
    const res = await fetch(`${baseUrl}/api/audit`);
    assert.equal(res.status, 200);
  });
});
