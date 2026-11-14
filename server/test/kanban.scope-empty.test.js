/**
 * Project scope hardening: a blank project value in any channel (query
 * project/workspace, X-Kanban-Project, body project/workspace_id) counts as
 * absent everywhere, so authorisation and routing always resolve the same
 * project and a scoped token can never reach another project's cards.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('blank project scope channels', () => {
  let tmpDir;
  let server;
  let base;
  let store;
  const saved = {};

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-scope-empty-'));
    for (const k of ['KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_PROJECT_TOKENS', 'KANBAN_ADMIN_TOKEN', 'KANBAN_STORAGE_BACKEND']) {
      saved[k] = process.env[k];
    }
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    delete process.env.KANBAN_STORAGE_BACKEND;
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ default: 'tok-default', beta: 'tok-beta' });
    process.env.KANBAN_ADMIN_TOKEN = 'tok-admin-xyz';
    const { createApp } = await import('../server.js');
    store = await import('../store.js');
    store.setStorage(null);
    await store.loadStore();
    server = await new Promise((r) => {
      const s = createApp().listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function call(method, route, token, body, extra = {}) {
    const r = await fetch(base + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Agent-Role': 'builder',
        'X-Agent-Id': 'a1',
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null;
    try { j = await r.json(); } catch { /* none */ }
    return { s: r.status, j };
  }

  // Each variant: how a blank value is smuggled in next to a real `beta` one.
  const variants = [
    { name: 'query project + workspace', qs: '?project=&workspace=beta' },
    { name: 'query project + header', qs: '?project=', headers: { 'X-Kanban-Project': 'beta' } },
    { name: 'query workspace blank + project', qs: '?workspace=&project=beta' },
    { name: 'query whitespace project', qs: '?project=%20%20&workspace=beta' },
    { name: 'blank header', qs: '?project=beta', headers: { 'X-Kanban-Project': ' ' } },
    { name: 'body project + workspace_id', qs: '', body: { project: '', workspace_id: 'beta' } },
    { name: 'body blank workspace_id', qs: '?project=beta', body: { workspace_id: '' } },
    { name: 'body whitespace project', qs: '?project=beta', body: { project: '  ' } },
  ];

  async function seedDefault(id) {
    const c = await call('POST', '/api/tasks', 'tok-default', {
      id, title: 'default-owned', description: 'x', status: 'READY', round: 1,
    });
    assert.equal(c.s, 201);
    return c.j.id;
  }

  for (const v of variants) {
    it(`create lands in named project: ${v.name}`, async () => {
      const r = await call('POST', `/api/tasks${v.qs}`, 'tok-beta',
        { id: `C-${Math.random().toString(36).slice(2, 8)}`, title: 't', status: 'READY', round: 1, ...v.body },
        v.headers);
      // Blank is ignored, so the card lands in the named project (beta) -
    // never in default.
    assert.equal(r.s, 201);
    assert.equal(r.j.project, 'beta');
    assert.equal(store.getTask(r.j.id, 'default') ?? undefined, undefined);
    });

    it(`patch/comment/claim cannot reach default: ${v.name}`, async () => {
      const id = await seedDefault(`D-${Math.random().toString(36).slice(2, 8)}`);
      const patch = await call('PATCH', `/api/tasks/${id}${v.qs}`, 'tok-beta', { title: 'changed', ...v.body }, v.headers);
      assert.ok([400, 403, 404].includes(patch.s), `patch ${patch.s}`);
      const comment = await call('POST', `/api/tasks/${id}/comments${v.qs}`, 'tok-beta', { message: 'm', ...v.body }, v.headers);
      assert.ok([400, 403, 404].includes(comment.s), `comment ${comment.s}`);
      const claim = await call('POST', `/api/tasks/${id}/claim${v.qs}`, 'tok-beta', { agent_id: 'a1', ...v.body }, v.headers);
      assert.ok([400, 403, 404].includes(claim.s), `claim ${claim.s}`);
      const t = store.getTask(id, 'default');
      assert.equal(t.title, 'default-owned');
      assert.equal((t.comments || []).length, 0);
      assert.ok(!t.assignee && !t.claimed_by);
    });
  }

  it('legitimate scoped and unscoped requests still work', async () => {
    const own = await call('POST', '/api/tasks?project=beta', 'tok-beta',
      { id: 'OK-1', title: 'beta card', status: 'READY', round: 1 });
    assert.equal(own.s, 201);
    assert.equal(own.j.project, 'beta');
    const def = await call('POST', '/api/tasks', 'tok-default',
      { id: 'OK-2', title: 'default card', status: 'READY', round: 1 });
    assert.equal(def.s, 201);
    assert.equal(def.j.project, 'default');
  });
});
