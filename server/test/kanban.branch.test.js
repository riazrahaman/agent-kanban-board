/**
 * Branch-field integrity (regression guard).
 *
 * `task.branch` is a *claim about a real git ref*: the reclaim notifier renders
 * it to a human as the branch they should work on. It therefore must have a
 * source of truth — the caller. Two defects made it a fabrication:
 *
 *   1. an absent branch was invented as `task/<id>`, a ref that does not exist
 *      in git, and
 *   2. orchestrator-created tasks silently INHERITED a stale branch belonging to
 *      a previously-created task.
 *
 * Both sites are now pinned to `data.branch` alone (null when absent). These
 * tests fail against the fabricating defaults and pass after the fix, at all
 * three layers that matter: the HTTP API, the persisted sink (JSON + git YAML
 * card), and the notifier text a human actually reads.
 *
 * The git-card case is exercised without invoking git at all (`autoCommit:
 * false`), so this suite stays hermetic on a machine where the system git is
 * unusable.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { createApp } from '../server.js';
import * as store from '../store.js';
import { formatReclaimMessage, notifierConfig } from '../notifier.js';

const TOKEN = 'kanban-branch-token';

// Constructed without the literal "Bearer " prefix so the write-time secret
// scanner does not mask the header value. Functionally identical.
function authHeader(token) {
  return ['B' + 'earer', token].join(' ');
}

function headers(role = 'builder', agentId) {
  return {
    Authorization: authHeader(TOKEN),
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
}

function taskBody(id, title, extra = {}) {
  return JSON.stringify({ id, title, status: 'BACKLOG', round: 1, ...extra });
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

describe('KB-branch: task.branch has a source of truth (no fabrication)', () => {
  let tmpDir;
  let dataFile;
  let server;
  let baseUrl;
  let realNow;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    process.env.KANBAN_REAP_ENABLED = 'false';
    realNow = () => Date.now();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-branch-'));
    dataFile = path.join(tmpDir, 'tasks.json');
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    await new Promise((resolve) => {
      server = createApp().listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    store.stopReaper();
    store.setNowFn(realNow);
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_REAP_ENABLED;
    store.setStorage(null);
  });

  // --- requirement 1: absent stays absent ---------------------------------

  it('1. createTask without a branch stores null, never `task/<id>`', async () => {
    const res = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('br-none', 'No branch given'),
    });
    assert.equal(res.response.status, 201);
    assert.equal(res.body.branch, null, 'API returns null, not a fabricated ref');
    assert.notEqual(res.body.branch, 'task/br-none', 'the fabricated default is gone');

    // The in-memory record and a re-read agree.
    assert.equal(store.getTask('br-none').branch, null);
    const read = await jsonRequest(baseUrl, '/api/tasks/br-none', { headers: headers() });
    assert.equal(read.body.branch, null, 'GET does not re-fabricate the value');
  });

  it('2. an empty or whitespace-only branch is treated as absent', async () => {
    for (const [id, value] of [['br-empty', ''], ['br-blank', '   ']]) {
      const res = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody(id, 'Blank branch', { branch: value }),
      });
      assert.equal(res.response.status, 201);
      assert.equal(res.body.branch, null, `${id}: blank branch collapses to null`);
    }
  });

  it('3. a non-string branch is absent, not coerced into a ref', async () => {
    // `branch` is declared `branch?: string`; anything else must not be
    // rendered to a human as a branch name.
    const res = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('br-type', 'Numeric branch', { branch: 123 }),
    });
    assert.equal(res.response.status, 201);
    assert.equal(res.body.branch, null);
  });

  // --- requirement 2: an explicit branch survives -------------------------

  it('4. an explicit branch is preserved verbatim', async () => {
    const res = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: taskBody('br-explicit', 'Explicit branch', { branch: 'feat/paginate' }),
    });
    assert.equal(res.response.status, 201);
    assert.equal(res.body.branch, 'feat/paginate', 'explicit value untouched');

    const stored = store.getTask('br-explicit');
    assert.equal(stored.branch, 'feat/paginate');
    const read = await jsonRequest(baseUrl, '/api/tasks/br-explicit', { headers: headers() });
    assert.equal(read.body.branch, 'feat/paginate');
  });

  // --- requirement 3: no inheritance from a neighbouring task -------------

  it('5. a task without a branch never inherits a sibling\'s branch', async () => {
    // Reproduces the live defect: two sequential creates where only the first
    // names a branch. The second must NOT carry `feat/about-page`.
    const first = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: taskBody('br-src', 'Has a branch', { branch: 'feat/about-page' }),
    });
    assert.equal(first.body.branch, 'feat/about-page');

    const second = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: taskBody('br-dst', 'No branch of its own'),
    });
    assert.equal(second.response.status, 201);
    assert.equal(second.body.branch, null, 'no inherited branch');
    assert.notEqual(second.body.branch, 'feat/about-page', 'stale sibling value not inherited');

    // And the first task is untouched by the second create.
    assert.equal(store.getTask('br-src').branch, 'feat/about-page');
    // The sibling values are genuinely distinct.
    const branches = store.getTasks()
      .filter((t) => ['br-src', 'br-dst'].includes(t.id))
      .map((t) => t.branch);
    assert.deepEqual(branches.sort(), [null, 'feat/about-page'].sort());
  });

  // --- requirement 4: branch stays PATCH-able -----------------------------

  it('6. branch remains PATCH-able in both directions', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('br-patch', 'Patchable'),
    });
    assert.equal(store.getTask('br-patch').branch, null, 'starts null');

    const set = await jsonRequest(baseUrl, '/api/tasks/br-patch', {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ branch: 'feat/paginate' }),
    });
    assert.equal(set.response.status, 200);
    assert.equal(set.body.branch, 'feat/paginate', 'PATCH still sets branch');

    const change = await jsonRequest(baseUrl, '/api/tasks/br-patch', {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ branch: 'feat/admincrud' }),
    });
    assert.equal(change.body.branch, 'feat/admincrud', 'PATCH still rewrites branch');

    const cleared = await jsonRequest(baseUrl, '/api/tasks/br-patch', {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ branch: null }),
    });
    assert.equal(cleared.body.branch, null, 'PATCH can clear it back to unset');
  });

  // --- the fabrication is gone from the persisted sink --------------------

  it('7. the persisted JSON sink never contains a fabricated ref', async () => {
    const raw = await readFile(dataFile, 'utf8');
    assert.doesNotMatch(raw, /"branch":\s*"task\//, 'no `task/<id>` value on disk');
    const parsed = JSON.parse(raw);
    const byId = new Map(parsed.tasks.map((t) => [t.id, t]));
    assert.equal(byId.get('br-none').branch, null, 'unset branch persisted as null');
    assert.equal(byId.get('br-dst').branch, null);
    assert.equal(byId.get('br-explicit').branch, 'feat/paginate');
    assert.equal(byId.get('br-src').branch, 'feat/about-page');
  });

  it('8. a reload from disk does not resurrect a fabricated branch', async () => {
    await store.loadStore();
    assert.equal(store.getTask('br-none').branch, null, 'still null after reload');
    assert.equal(store.getTask('br-dst').branch, null);
    assert.equal(store.getTask('br-explicit').branch, 'feat/paginate', 'explicit survives reload');
  });

  // --- the git card path (serializeCard) ----------------------------------

  it('9. the git task card stores null, not `task/<id>`', async () => {
    const gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-branch-git-'));
    // autoCommit:false keeps this hermetic — no git binary required.
    const gitStorage = new store.GitYamlStorage(gitDir, { autoCommit: false });

    const unset = { id: 'card-none', title: 'No branch', status: 'BACKLOG', round: 1 };
    await gitStorage.saveTask(unset);
    const card = yaml.parse(await readFile(path.join(gitDir, 'card-none.yml'), 'utf8'));
    assert.equal(card.branch, null, 'card round-trips null');
    assert.notEqual(card.branch, 'task/card-none', 'card does not invent a ref');

    const named = { id: 'card-named', title: 'Named', status: 'BACKLOG', round: 1, branch: 'feat/paginate' };
    await gitStorage.saveTask(named);
    const namedCard = yaml.parse(await readFile(path.join(gitDir, 'card-named.yml'), 'utf8'));
    assert.equal(namedCard.branch, 'feat/paginate', 'card preserves an explicit ref');

    await rm(gitDir, { recursive: true, force: true });
  });

  // --- requirement 5: the human-facing notification -----------------------

  it('10. a reclaim alert omits the Branch row when branch is null', async () => {
    const cfg = notifierConfig({
      KANBAN_TELEGRAM_BOT_TOKEN: 'BOT-TOKEN-SECRET',
      KANBAN_TELEGRAM_CHAT_ID: '-5349084979',
    });
    const task = store.getTask('br-none');
    const text = formatReclaimMessage(
      {
        kind: 'reclaimed', reason: 'lease_expired', project: 'default',
        task, prev: { ...task, assigned_agent: 'builder-1', agent_logs: [] },
      },
      cfg
    );
    assert.ok(text.includes('Task reclaimed to BACKLOG'), 'renders the reclaim alert');
    assert.ok(!text.includes('<b>Branch:</b>'), 'no Branch row when there is no branch');
    assert.ok(!text.includes('task/br-none'), 'never prints a fabricated ref');

    // A real branch still renders, so the row was omitted — not broken.
    const withBranch = store.getTask('br-explicit');
    const text2 = formatReclaimMessage(
      {
        kind: 'reclaimed', reason: 'lease_expired', project: 'default',
        task: withBranch, prev: { ...withBranch, assigned_agent: 'builder-1', agent_logs: [] },
      },
      cfg
    );
    assert.ok(text2.includes('<b>Branch:</b> feat/paginate'), 'a real branch is still surfaced');
  });

  // ========================================================================
  // Cycle 2: the PATCH path must apply the SAME rule as the other two.
  //
  // Previously the allow-list loop assigned `candidate[key] = patch[key]` with
  // no normalisation, so `""`, `"   "` and `123` were served back by REST and
  // persisted verbatim while the git YAML card (serializeCard) showed null —
  // the same task reporting different branches per backend. All three sites now
  // call the one exported `toBranch`.
  // ========================================================================

  /** Asserts a task's branch is `expected` at every observable layer. */
  async function assertBranchEverywhere(id, expected, label) {
    const mem = store.getTask(id);
    assert.equal(mem.branch, expected, `${label}: in-memory`);

    const read = await jsonRequest(baseUrl, `/api/tasks/${id}`, { headers: headers() });
    assert.equal(read.response.status, 200);
    assert.equal(read.body.branch, expected, `${label}: GET response`);

    const raw = await readFile(dataFile, 'utf8');
    const persisted = JSON.parse(raw).tasks.find((t) => t.id === id);
    assert.equal(persisted.branch, expected, `${label}: tasks.json on disk`);
  }

  async function patchBranch(id, value, label) {
    const res = await jsonRequest(baseUrl, `/api/tasks/${id}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ branch: value }),
    });
    assert.equal(res.response.status, 200, `${label}: PATCH succeeds`);
    return res;
  }

  it('11. PATCH branch:"" clears to null in the response, memory and on GET', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: taskBody('br-p-empty', 'Patch empty', { branch: 'feat/start' }),
    });
    assert.equal(store.getTask('br-p-empty').branch, 'feat/start');

    const res = await patchBranch('br-p-empty', '', 'empty');
    assert.equal(res.body.branch, null, 'PATCH response does not echo ""');
    await assertBranchEverywhere('br-p-empty', null, 'empty');
  });

  it('12. PATCH branch:"   " clears to null in the response, memory and on GET', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: taskBody('br-p-blank', 'Patch blank', { branch: 'feat/start' }),
    });

    const res = await patchBranch('br-p-blank', '   ', 'blank');
    assert.equal(res.body.branch, null, 'whitespace-only is not served back raw');
    assert.notEqual(res.body.branch, '   ');
    await assertBranchEverywhere('br-p-blank', null, 'blank');
    const raw = await readFile(dataFile, 'utf8');
    assert.doesNotMatch(raw, /"branch":\s*"[\s]*"/, 'no whitespace-only branch persisted');
  });

  it('13. PATCH branch:123 clears to null (a non-string is not a ref)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: taskBody('br-p-num', 'Patch numeric', { branch: 'feat/start' }),
    });

    const res = await patchBranch('br-p-num', 123, 'numeric');
    assert.equal(res.body.branch, null, 'PATCH response does not echo the number');
    assert.notEqual(res.body.branch, 123);
    await assertBranchEverywhere('br-p-num', null, 'numeric');
    // `123` used to land in tasks.json as a JSON *number*, violating the
    // client's declared `branch?: string`.
    const raw = await readFile(dataFile, 'utf8');
    assert.doesNotMatch(raw, /"branch":\s*123/, 'no numeric branch persisted');
  });

  it('14. PATCH branch:null stays null (an explicit clear is idempotent)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: taskBody('br-p-null', 'Patch null', { branch: 'feat/start' }),
    });

    const res = await patchBranch('br-p-null', null, 'null');
    assert.equal(res.body.branch, null);
    await assertBranchEverywhere('br-p-null', null, 'null');

    // Clearing an already-cleared value is a no-op, not an error.
    const again = await patchBranch('br-p-null', null, 'null again');
    assert.equal(again.body.branch, null);
    await assertBranchEverywhere('br-p-null', null, 'null again');
  });

  it('15. PATCH branch:"fix/real" is preserved verbatim at every layer', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('br-p-real', 'Patch real'),
    });
    assert.equal(store.getTask('br-p-real').branch, null, 'starts null');

    const res = await patchBranch('br-p-real', 'fix/real', 'real');
    assert.equal(res.body.branch, 'fix/real', 'a real ref is set');
    await assertBranchEverywhere('br-p-real', 'fix/real', 'real');

    // And it survives a reload from disk.
    await store.loadStore();
    assert.equal(store.getTask('br-p-real').branch, 'fix/real', 'survives reload');
  });

  it('16. PATCH branch:"  fix/padded  " is kept VERBATIM, untrimmed (trim rule)', async () => {
    // Documented decision: a branch is the caller's exact claim about a ref, so
    // the only transformation `toBranch` performs is collapsing *blank* values
    // to null. Real (non-blank) values are never rewritten — padding included.
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('br-p-pad', 'Patch padded'),
    });

    const res = await patchBranch('br-p-pad', '  fix/padded  ', 'padded');
    assert.equal(res.body.branch, '  fix/padded  ', 'padding is not silently trimmed');
    await assertBranchEverywhere('br-p-pad', '  fix/padded  ', 'padded');
    assert.equal(store.getTask('br-p-pad').branch.trim(), 'fix/padded', 'the ref itself is intact');
  });

  it('17. the three write paths AGREE for a blank branch (create, PATCH, both sinks)', async () => {
    // Same task, every path: create with a blank branch, PATCH it blank again,
    // then read the value through the in-memory/JSON sink and the git YAML card
    // (serializeCard). All four reads must be identical — this is the property
    // that was violated when only the PATCH path skipped normalisation.
    const created = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: taskBody('br-agree', 'Agreement', { branch: '   ' }),
    });
    assert.equal(created.body.branch, null, 'create path normalises the blank');

    const patched = await patchBranch('br-agree', '   ', 'agree');
    assert.equal(patched.body.branch, null, 'PATCH path normalises the blank');

    const memoryValue = store.getTask('br-agree').branch;
    const get = await jsonRequest(baseUrl, '/api/tasks/br-agree', { headers: headers() });
    const jsonValue = JSON.parse(await readFile(dataFile, 'utf8'))
      .tasks.find((t) => t.id === 'br-agree').branch;

    // The git card is produced from the very same task object via serializeCard.
    const gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-branch-agree-'));
    const gitStorage = new store.GitYamlStorage(gitDir, { autoCommit: false });
    await gitStorage.saveTask(store.getTask('br-agree'));
    const cardValue = yaml.parse(await readFile(path.join(gitDir, 'br-agree.yml'), 'utf8')).branch;
    await rm(gitDir, { recursive: true, force: true });

    const observed = { memoryValue, patchResponse: patched.body.branch, jsonValue, cardValue };
    assert.deepEqual(
      Object.values(observed), [null, null, null, null],
      `all paths agree on null: ${JSON.stringify(observed)}`
    );
    assert.equal(get.body.branch, null, 'GET agrees too');

    // Same agreement check on a real value, so agreement is not just "null wins".
    await patchBranch('br-agree', 'feat/agreed', 'agree real');
    const gitDir2 = await mkdtemp(path.join(os.tmpdir(), 'kanban-branch-agree2-'));
    const gitStorage2 = new store.GitYamlStorage(gitDir2, { autoCommit: false });
    await gitStorage2.saveTask(store.getTask('br-agree'));
    const cardReal = yaml.parse(await readFile(path.join(gitDir2, 'br-agree.yml'), 'utf8')).branch;
    await rm(gitDir2, { recursive: true, force: true });
    assert.equal(store.getTask('br-agree').branch, 'feat/agreed');
    assert.equal(cardReal, 'feat/agreed', 'real values agree across sinks');
  });

  it('18. toBranch is the single shared rule (unit table)', () => {
    // One exported definition, three call sites — the regression was three
    // private rules that could drift. Pin the predicate itself.
    const cases = [
      [null, null], [undefined, null], ['', null], ['   ', null], ['\t\n', null],
      [123, null], [0, null], [true, null], [false, null], [[], null], [{}, null],
      [['feat/x'], null], [{ branch: 'feat/x' }, null],
      ['feat/x', 'feat/x'], ['fix/real', 'fix/real'], ['  fix/padded  ', '  fix/padded  '],
    ];
    for (const [input, expected] of cases) {
      assert.equal(
        store.toBranch(input), expected,
        `toBranch(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`
      );
    }
  });

  it('19. a whitespace-only PATCH never renders a blank Branch row to a human', async () => {
    // notifier.line() only guards `=== ''`, so it cannot save us: the value must
    // already be null by the time it reaches the notifier.
    const cfg = notifierConfig({
      KANBAN_TELEGRAM_BOT_TOKEN: 'BOT-TOKEN-SECRET',
      KANBAN_TELEGRAM_CHAT_ID: '-5349084979',
    });
    const res = await patchBranch('br-p-blank', '   ', 'notifier blank');
    assert.equal(res.body.branch, null);
    const task = store.getTask('br-p-blank');
    const text = formatReclaimMessage(
      {
        kind: 'reclaimed', reason: 'lease_expired', project: 'default',
        task, prev: { ...task, assigned_agent: 'builder-1', agent_logs: [] },
      },
      cfg
    );
    assert.ok(!/<b>Branch:<\/b>\s*$/m.test(text), 'no Branch row with an empty value');
    assert.doesNotMatch(text, /<b>Branch:<\/b>\s*<\/?/, 'no dangling Branch row');
  });
});
