/**
 * 3.18.1 — a stream ticket never grants more than the credential that minted
 * it. Before the fix, `req.caller.authorizedProjects = getAuthorizedProjects(req)`
 * evaluated `req.caller` BEFORE the call, and the ticket branch replaces
 * `req.caller`, so the project scope landed on a discarded object: an
 * alpha-only ticket streamed every project on /api/events (and, with a master
 * password set, with full card details). These tests pin that the ticket path
 * and the bearer path see exactly the same projects, in snapshot and diff
 * modes, with read auth on and with read auth off + a master password.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';
import crypto from 'node:crypto';
import { createStreamTicket, resetStreamTickets, verifyStreamTicket } from '../streamTicket.js';
import { challengeProofInput } from '../routes/auth.js';
import { resetAuthLimits } from '../middleware/rateLimit.js';
import { resetUnlockFailures, resetUnlockKeyMaterial } from '../masterUnlock.js';

const ADMIN = 'admin-token-for-ticket-scope';
const GLOBAL = 'global-token-for-ticket-scope';
const ALPHA = 'alpha-only-project-token';
const MASTER = 'correct-horse-battery-scope';
const ENV_KEYS = [
  'KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_AUTH_TOKEN', 'KANBAN_AUTH_SECRET',
  'KANBAN_READ_AUTH', 'KANBAN_AUTH_RATE_LIMIT_PER_MIN', 'KANBAN_ADMIN_TOKEN', 'KANBAN_PROJECT_TOKENS',
  'KANBAN_MASTER_PASSWORD', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_GIT_DIR',
];

const json = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra });
const bearer = (token, extra = {}) => json({ Authorization: `Bearer ${token}`, ...extra });

async function req(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { response, body, text };
}

/**
 * Opens an SSE stream and reads until `until(text)` holds (or it times out).
 * Returns the status and everything that arrived.
 */
async function readStream(baseUrl, route, { until, headers = {}, timeoutMs = 2500, onOpen } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  let status = 0;
  try {
    const res = await fetch(`${baseUrl}${route}`, { signal: controller.signal, headers: { 'Accept-Encoding': 'identity', ...headers } });
    status = res.status;
    if (res.status !== 200) return { status, text: await res.text() };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let opened = false;
    while (!until(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!opened && onOpen && /\n\n/.test(text)) {
        opened = true;
        await onOpen();
      }
    }
  } catch {
    // aborted on timeout: return what arrived
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { status, text };
}

/** Project names of every task in every `event: tasks` / `task.*` frame. */
function projectsIn(text) {
  const out = new Set();
  for (const frame of text.split('\n\n')) {
    const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    if (!data) continue;
    let parsed;
    try { parsed = JSON.parse(data); } catch { continue; }
    const tasks = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.tasks) ? parsed.tasks
        : parsed?.task ? [parsed.task] : [];
    for (const t of tasks) if (t && typeof t.project === 'string') out.add(t.project);
  }
  return out;
}

const CONFIGS = [
  { name: 'read auth on', env: { KANBAN_READ_AUTH: 'token' }, master: false },
  { name: 'read auth off + master password', env: { KANBAN_MASTER_PASSWORD: MASTER }, master: true },
  { name: 'read auth on + master password', env: { KANBAN_READ_AUTH: 'token', KANBAN_MASTER_PASSWORD: MASTER }, master: true },
];

for (const config of CONFIGS) {
  describe(`stream ticket scope never exceeds its credential (${config.name})`, () => {
    let tmpDir;
    let server;
    let baseUrl;
    let seq = 0;

    before(async () => {
      for (const k of ENV_KEYS) delete process.env[k];
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-ticketscope-'));
      store.setStorage(null);
      process.env.KANBAN_DATA_DIR = tmpDir;
      process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
      process.env.KANBAN_ADMIN_TOKEN = ADMIN;
      process.env.KANBAN_AUTH_TOKEN = GLOBAL;
      process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: { token: ALPHA, role: 'builder' } });
      Object.assign(process.env, config.env);
      resetUnlockKeyMaterial();
      await store.loadStore();
      server = await new Promise((resolve) => {
        const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      for (const [id, project] of [['a1', 'alpha'], ['b1', 'beta']]) {
        const r = await req(baseUrl, '/api/tasks', {
          method: 'POST', headers: bearer(ADMIN),
          body: JSON.stringify({ id, project, title: `Card ${id}`, description: `DESC-${project}-${id}`, status: 'READY', round: 1, priority: 'high' }),
        });
        assert.equal(r.response.status, 201, r.text);
      }
    });

    beforeEach(() => {
      resetStreamTickets();
      resetAuthLimits();
      resetUnlockFailures();
    });

    after(async () => {
      server.close();
      store.setStorage(null);
      await rm(tmpDir, { recursive: true, force: true });
      for (const k of ENV_KEYS) delete process.env[k];
      resetStreamTickets();
      resetAuthLimits();
      resetUnlockKeyMaterial();
    });

    /** A FRESH single-use ticket for every connection. */
    async function mint(headers, body = {}) {
      const r = await req(baseUrl, '/api/auth/stream-ticket', { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(r.response.status, 200, r.text);
      assert.equal(typeof r.body.ticket, 'string');
      return encodeURIComponent(r.body.ticket);
    }
    const alphaTicket = () => mint(bearer(ALPHA));
    const createTask = async (project) => {
      seq += 1;
      const id = `${project[0]}-new-${seq}`;
      const r = await req(baseUrl, '/api/tasks', {
        method: 'POST', headers: bearer(ADMIN),
        body: JSON.stringify({ id, project, title: `New ${id}`, description: `DESC-${project}-${id}`, status: 'READY', round: 1, priority: 'high' }),
      });
      assert.equal(r.response.status, 201, r.text);
      return id;
    };
    const hasTasksFrame = (t) => /event: tasks\n[\s\S]*?\n\n/.test(t);

    it('snapshot mode: an alpha ticket gets alpha only (no filter), with details for alpha', async () => {
      const s = await readStream(baseUrl, `/api/events?mode=snapshot&ticket=${await alphaTicket()}`, { until: hasTasksFrame });
      assert.equal(s.status, 200, s.text);
      assert.deepEqual([...projectsIn(s.text)], ['alpha']);
      assert.match(s.text, /DESC-alpha-a1/);
      assert.doesNotMatch(s.text, /DESC-beta|"b1"/);
    });

    it('diff mode prime: an alpha ticket gets alpha only (no filter)', async () => {
      const s = await readStream(baseUrl, `/api/events?prime=1&ticket=${await alphaTicket()}`, { until: hasTasksFrame });
      assert.equal(s.status, 200, s.text);
      assert.deepEqual([...projectsIn(s.text)], ['alpha']);
      assert.doesNotMatch(s.text, /DESC-beta|"b1"/);
    });

    it('diff mode frames: a beta task.created never reaches an alpha ticket; the alpha one does', async () => {
      let betaId;
      let alphaId;
      const s = await readStream(baseUrl, `/api/events?ticket=${await alphaTicket()}`, {
        until: (t) => alphaId && t.includes(alphaId),
        onOpen: async () => {
          betaId = await createTask('beta'); // first, so it would arrive before the alpha control
          alphaId = await createTask('alpha');
        },
      });
      assert.equal(s.status, 200, s.text);
      assert.ok(s.text.includes(alphaId), `the alpha control frame did not arrive: ${s.text}`);
      assert.match(s.text, /event: task\.created/);
      assert.ok(!s.text.includes(betaId), 'a beta frame reached the alpha ticket');
      assert.doesNotMatch(s.text, /DESC-beta/);
      assert.deepEqual([...projectsIn(s.text)], ['alpha']);
    });

    it('?project=beta: refused for the alpha ticket exactly as for the alpha bearer', async () => {
      const viaTicket = await readStream(baseUrl, `/api/events?project=beta&ticket=${await alphaTicket()}`, { until: hasTasksFrame });
      const viaBearer = await readStream(baseUrl, '/api/events?project=beta', { until: hasTasksFrame, headers: { Authorization: `Bearer ${ALPHA}` } });
      assert.equal(viaBearer.status, 403, viaBearer.text);
      assert.equal(viaTicket.status, 403, viaTicket.text);
      assert.doesNotMatch(viaTicket.text, /DESC-beta/);
      const snap = await readStream(baseUrl, `/api/events?project=beta&mode=snapshot&ticket=${await alphaTicket()}`, { until: hasTasksFrame });
      assert.equal(snap.status, 403, snap.text);
    });

    it('the bearer path and the ticket path see the same projects (snapshot and prime)', async () => {
      for (const mode of ['mode=snapshot', 'prime=1']) {
        const viaBearer = await readStream(baseUrl, `/api/events?${mode}`, { until: hasTasksFrame, headers: { Authorization: `Bearer ${ALPHA}` } });
        const viaTicket = await readStream(baseUrl, `/api/events?${mode}&ticket=${await alphaTicket()}`, { until: hasTasksFrame });
        assert.equal(viaBearer.status, 200, viaBearer.text);
        assert.equal(viaTicket.status, 200, viaTicket.text);
        assert.deepEqual([...projectsIn(viaTicket.text)].sort(), [...projectsIn(viaBearer.text)].sort(), mode);
        assert.deepEqual([...projectsIn(viaTicket.text)], ['alpha'], mode);
      }
    });

    it('admin and global tokens: a ticket minted without a project still sees every project, like the bearer', async () => {
      for (const token of [ADMIN, GLOBAL]) {
        const viaBearer = await readStream(baseUrl, '/api/events?prime=1', { until: hasTasksFrame, headers: { Authorization: `Bearer ${token}` } });
        const viaTicket = await readStream(baseUrl, `/api/events?prime=1&ticket=${await mint(bearer(token, { 'X-Agent-Role': 'builder' }), { role: 'builder' })}`, { until: hasTasksFrame });
        assert.equal(viaTicket.status, 200, viaTicket.text);
        assert.deepEqual([...projectsIn(viaBearer.text)].sort(), ['alpha', 'beta']);
        assert.deepEqual([...projectsIn(viaTicket.text)].sort(), ['alpha', 'beta']);
        if (config.master) assert.match(viaTicket.text, /DESC-beta-b1/);
      }
      // A ticket minted FOR one project is scoped to it.
      const scoped = await readStream(baseUrl, `/api/events?prime=1&ticket=${await mint(bearer(GLOBAL, { 'X-Agent-Role': 'builder' }), { role: 'builder', project: 'beta' })}`, { until: hasTasksFrame });
      assert.deepEqual([...projectsIn(scoped.text)], ['beta']);
    });

    if (config.master) {
      it('master-unlock ticket: reads every project, with details', async () => {
        const u = await req(baseUrl, '/api/auth/unlock', { method: 'POST', headers: json(), body: JSON.stringify({ password: MASTER }) });
        assert.equal(u.response.status, 200, u.text);
        const ticket = await mint(json({ 'X-Kanban-Unlock': u.body.token }));
        const s = await readStream(baseUrl, `/api/events?prime=1&ticket=${ticket}`, { until: hasTasksFrame });
        assert.equal(s.status, 200, s.text);
        assert.deepEqual([...projectsIn(s.text)].sort(), ['alpha', 'beta']);
        assert.match(s.text, /DESC-alpha-a1/);
        assert.match(s.text, /DESC-beta-b1/);
        assert.doesNotMatch(s.text, /details_locked/);
      });
    }

    it('stream tickets mint with no KANBAN_AUTH_SECRET configured (per-process key)', async () => {
      assert.equal(process.env.KANBAN_AUTH_SECRET, undefined);
      const r = await req(baseUrl, '/api/auth/stream-ticket', { method: 'POST', headers: bearer(ALPHA), body: '{}' });
      assert.equal(r.response.status, 200, r.text);
      assert.equal(r.body.project, 'alpha');
      assert.match(r.body.ticket, /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    });
  });
}

/**
 * 3.19.1 — the same guarantee for admin/project SESSIONS and for a token listed
 * under SEVERAL projects. An admin session (always stamped with a project by
 * /api/auth/session) reads every project as a bearer, so its ticket does too;
 * a project session reads its one project; a multi-project token with no
 * project named gets a ticket for exactly its set (before, it 403'd unless the
 * set held `default`, and the browser's "All projects" view fell back to the
 * anonymous stream). A gamma project nobody but admin holds proves a set never
 * silently widens to '*'.
 */
const SECRET = 'ticket-scope-session-secret-0123456789abcdef';
const MULTI = 'alpha-and-beta-project-token';
const MULTI_D = 'default-and-alpha-project-token';
const ALL_PROJECTS = ['alpha', 'beta', 'default', 'gamma'];

for (const config of CONFIGS) {
  describe(`stream tickets for sessions and multi-project tokens never exceed the bearer (${config.name})`, () => {
    let tmpDir;
    let server;
    let baseUrl;
    let seq = 0;

    before(async () => {
      for (const k of ENV_KEYS) delete process.env[k];
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-ticketscope-session-'));
      store.setStorage(null);
      process.env.KANBAN_DATA_DIR = tmpDir;
      process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
      process.env.KANBAN_ADMIN_TOKEN = ADMIN;
      process.env.KANBAN_AUTH_TOKEN = GLOBAL;
      process.env.KANBAN_AUTH_SECRET = SECRET;
      process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
        alpha: { credentials: [{ token: ALPHA, role: 'builder' }, { token: MULTI, role: 'builder' }, { token: MULTI_D, role: 'builder' }] },
        beta: { token: MULTI, role: 'builder' },
        default: { token: MULTI_D, role: 'builder' },
      });
      Object.assign(process.env, config.env);
      resetUnlockKeyMaterial();
      await store.loadStore();
      server = await new Promise((resolve) => {
        const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      for (const [id, project] of [['a1', 'alpha'], ['b1', 'beta'], ['g1', 'gamma'], ['d1', 'default']]) {
        const r = await req(baseUrl, '/api/tasks', {
          method: 'POST', headers: bearer(ADMIN),
          body: JSON.stringify({ id, project, title: `Card ${id}`, description: `DESC-${project}-${id}`, status: 'READY', round: 1, priority: 'high' }),
        });
        assert.equal(r.response.status, 201, r.text);
      }
    });

    beforeEach(() => {
      resetStreamTickets();
      resetAuthLimits();
      resetUnlockFailures();
    });

    after(async () => {
      server.close();
      store.setStorage(null);
      await rm(tmpDir, { recursive: true, force: true });
      for (const k of ENV_KEYS) delete process.env[k];
      resetStreamTickets();
      resetAuthLimits();
      resetUnlockKeyMaterial();
    });

    /** A real session through the challenge -> proof -> /api/auth/session handshake. */
    async function session(role, project) {
      const c = await req(baseUrl, '/api/auth/challenge', { method: 'POST', headers: json(), body: '{}' });
      assert.equal(c.response.status, 200, c.text);
      const clientNonce = crypto.randomBytes(8).toString('hex');
      const proofProject = project ?? 'default';
      const proof = crypto.createHmac('sha256', SECRET)
        .update(challengeProofInput(c.body.challenge, clientNonce, role, proofProject)).digest('hex');
      const s = await req(baseUrl, '/api/auth/session', {
        method: 'POST', headers: json(),
        body: JSON.stringify({ client_nonce: clientNonce, proof, role, server_nonce: c.body.challenge, ...(project ? { project } : {}) }),
      });
      assert.equal(s.response.status, 200, s.text);
      // The server always stamps a project, even for an admin.
      assert.equal(s.body.project, proofProject);
      return s.body.token;
    }
    async function mint(headers, body = {}) {
      const r = await req(baseUrl, '/api/auth/stream-ticket', { method: 'POST', headers, body: JSON.stringify(body) });
      return r;
    }
    async function ticketFor(headers, body = {}) {
      const r = await mint(headers, body);
      assert.equal(r.response.status, 200, r.text);
      return encodeURIComponent(r.body.ticket);
    }
    const hasTasksFrame = (t) => /event: tasks\n[\s\S]*?\n\n/.test(t);
    const seen = (s) => [...projectsIn(s.text)].sort();
    async function viaBearer(token, query) {
      return readStream(baseUrl, `/api/events?${query}`, { until: hasTasksFrame, headers: { Authorization: `Bearer ${token}` } });
    }
    async function viaTicket(token, query, body = {}) {
      return readStream(baseUrl, `/api/events?${query}&ticket=${await ticketFor(bearer(token), body)}`, { until: hasTasksFrame });
    }
    /** The ticket sees exactly what the bearer sees, and never a project outside `expected`. */
    async function sameAsBearer(token, query, expected) {
      const b = await viaBearer(token, query);
      const t = await viaTicket(token, query);
      assert.equal(b.status, 200, b.text);
      assert.equal(t.status, 200, t.text);
      assert.deepEqual(seen(b), expected, `bearer ${query}`);
      assert.deepEqual(seen(t), expected, `ticket ${query}`);
      for (const p of ALL_PROJECTS.filter((x) => !expected.includes(x))) {
        assert.doesNotMatch(t.text, new RegExp(`DESC-${p}-`), `${p} leaked to the ticket (${query})`);
      }
      return t;
    }

    it('admin session (stamped with a project): mints an unscoped ticket and reads every project, like the bearer', async () => {
      for (const stamped of ['alpha', undefined]) {
        const token = await session('admin', stamped);
        const r = await mint(bearer(token));
        assert.equal(r.response.status, 200, r.text);
        assert.equal(r.body.project, null);
        assert.equal(r.body.projects, undefined);
        for (const mode of ['mode=snapshot', 'prime=1']) {
          const t = await sameAsBearer(token, mode, ALL_PROJECTS);
          if (config.master) assert.match(t.text, /DESC-gamma-g1/);
        }
      }
    });

    it('admin session naming a project: a ticket scoped to that project (a narrowing, allowed)', async () => {
      const token = await session('admin', 'alpha');
      const r = await mint(bearer(token), { project: 'beta' });
      assert.equal(r.response.status, 200, r.text);
      assert.equal(r.body.project, 'beta');
      const s = await readStream(baseUrl, `/api/events?prime=1&ticket=${encodeURIComponent(r.body.ticket)}`, { until: hasTasksFrame });
      assert.deepEqual(seen(s), ['beta']);
    });

    it('project session: the ticket reads only its project; another project is refused at mint and at the stream', async () => {
      const token = await session('builder', 'alpha');
      const r = await mint(bearer(token));
      assert.equal(r.response.status, 200, r.text);
      assert.equal(r.body.project, 'alpha');
      for (const mode of ['mode=snapshot', 'prime=1']) await sameAsBearer(token, mode, ['alpha']);
      assert.equal((await mint(bearer(token), { project: 'beta' })).response.status, 403);
      const b = await viaBearer(token, 'project=beta&prime=1');
      const t = await viaTicket(token, 'project=beta&prime=1');
      assert.equal(b.status, 403, b.text);
      assert.equal(t.status, 403, t.text);
    });

    it('multi-project token, no project named: a ticket for exactly its set (snapshot and prime), never gamma', async () => {
      const r = await mint(bearer(MULTI));
      assert.equal(r.response.status, 200, r.text);
      assert.equal(r.body.project, null);
      assert.deepEqual(r.body.projects, ['alpha', 'beta']);
      for (const mode of ['mode=snapshot', 'prime=1']) {
        const t = await sameAsBearer(MULTI, mode, ['alpha', 'beta']);
        if (config.master) assert.match(t.text, /DESC-beta-b1/);
      }
    });

    it('multi-project token holding default: no longer pinned to default, it reads its whole set', async () => {
      const r = await mint(bearer(MULTI_D));
      assert.equal(r.response.status, 200, r.text);
      assert.deepEqual(r.body.projects, ['alpha', 'default']);
      await sameAsBearer(MULTI_D, 'prime=1', ['alpha', 'default']);
    });

    it('multi-project ticket with ?project=X: inside the set is filtered to X, outside is refused like the bearer', async () => {
      await sameAsBearer(MULTI, 'project=beta&prime=1', ['beta']);
      await sameAsBearer(MULTI, 'project=alpha&mode=snapshot', ['alpha']);
      for (const query of ['project=gamma&prime=1', 'project=gamma&mode=snapshot', 'project=default']) {
        const b = await viaBearer(MULTI, query);
        const t = await viaTicket(MULTI, query);
        assert.equal(b.status, 403, b.text);
        assert.equal(t.status, 403, t.text);
        assert.doesNotMatch(t.text, /DESC-gamma/);
      }
      // A named project outside the set is refused at mint, as before.
      assert.equal((await mint(bearer(MULTI), { project: 'gamma' })).response.status, 403);
    });

    it('multi-project ticket, diff frames: gamma and default never arrive; alpha and beta do', async () => {
      const ids = {};
      const s = await readStream(baseUrl, `/api/events?ticket=${await ticketFor(bearer(MULTI))}`, {
        until: (t) => ids.beta && t.includes(ids.beta),
        onOpen: async () => {
          for (const p of ['gamma', 'default', 'alpha', 'beta']) {
            seq += 1;
            const id = `${p[0]}-sess-${seq}`;
            const r = await req(baseUrl, '/api/tasks', {
              method: 'POST', headers: bearer(ADMIN),
              body: JSON.stringify({ id, project: p, title: `New ${id}`, description: `DESC-${p}-${id}`, status: 'READY', round: 1, priority: 'high' }),
            });
            assert.equal(r.response.status, 201, r.text);
            ids[p] = id;
          }
        },
      });
      assert.equal(s.status, 200, s.text);
      assert.ok(s.text.includes(ids.alpha) && s.text.includes(ids.beta), `the control frames did not arrive: ${s.text}`);
      assert.ok(!s.text.includes(ids.gamma), 'a gamma frame reached the alpha+beta ticket');
      assert.ok(!s.text.includes(ids.default), 'a default frame reached the alpha+beta ticket');
      assert.deepEqual(seen(s), ['alpha', 'beta']);
    });

    it('single-project token: unchanged (alpha only; minting for beta is refused)', async () => {
      const r = await mint(bearer(ALPHA));
      assert.equal(r.response.status, 200, r.text);
      assert.equal(r.body.project, 'alpha');
      assert.equal(r.body.projects, undefined);
      await sameAsBearer(ALPHA, 'prime=1', ['alpha']);
      assert.equal((await mint(bearer(ALPHA), { project: 'beta' })).response.status, 403);
    });

    it('a ticket carrying a malformed projects claim is refused, never read as unscoped', async () => {
      const minted = createStreamTicket({ role: 'builder', project: null, projects: ['alpha'] });
      const [payload] = minted.ticket.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      assert.deepEqual(claims.projects, ['alpha']);
      // Re-sign a forged claim set with the real key: a non-array projects
      // value must fail verification rather than fall through to '*'.
      const forged = Buffer.from(JSON.stringify({ ...claims, projects: 'alpha' }), 'utf8').toString('base64url');
      const mac = crypto.createHmac('sha256', SECRET).update(forged).digest('hex');
      assert.equal(verifyStreamTicket(`${forged}.${mac}`), null);
      // The untouched ticket still verifies, with its exact set.
      assert.deepEqual(verifyStreamTicket(minted.ticket)?.projects, ['alpha']);
    });
  });
}
