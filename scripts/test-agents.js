#!/usr/bin/env node
/**
 * test-agents.js
 *
 * Headless demo of the multi-agent workflow against the Agent Kanban Board
 * API. Simulates two AI agents (Agent-Alpha and Agent-Beta) claiming tasks,
 * moving them through the v3 8-state lifecycle (BACKLOG -> READY ->
 * IN_PROGRESS -> IN_REVIEW -> VALIDATION -> READY_TO_SHIP -> DONE, plus
 * BLOCKED), and leaving log entries — all via plain HTTP calls, no browser
 * required. Each stage is moved by the role that owns it (planner, builder,
 * reviewer, tester, releaser), only READY cards are claimed, and every PATCH
 * carries the card's current version.
 *
 * Usage:
 *   1. In one terminal: cd server && npm install && npm start
 *   2. In another:       node scripts/test-agents.js
 *   Env: KANBAN_URL (default http://localhost:4000), KANBAN_AUTH_TOKEN,
 *        KANBAN_PROJECT (default "default").
 *
 * Optionally open the client in a browser first — the board updates live
 * via Server-Sent Events while this script runs, with no page refresh.
 */

const BASE_URL = process.env.KANBAN_URL || 'http://localhost:4000';
const PROJECT = process.env.KANBAN_PROJECT || 'default';
const q = `?project=${encodeURIComponent(PROJECT)}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTask(id) {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}${q}`);
  if (!res.ok) {
    throw new Error(`GET /api/tasks/${id} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

const AUTH_TOKEN = process.env.KANBAN_AUTH_TOKEN || '';

/**
 * v3.8.0: roles are credential-bound. With a role-bound KANBAN_PROJECT_TOKENS
 * map, each stage's requests MUST use that role's credential — set
 * KANBAN_TOKEN_PLANNER, KANBAN_TOKEN_BUILDER, KANBAN_TOKEN_REVIEWER,
 * KANBAN_TOKEN_TESTER, KANBAN_TOKEN_RELEASER... (missing entries fall back to
 * KANBAN_AUTH_TOKEN, whose legacy header semantics keep this script working
 * against unconfigured boards). The X-Agent-Role header stays advisory: a
 * bound credential overrides it and audits a mismatch.
 */
function resolveToken(role) {
  const bound = role ? process.env[`KANBAN_TOKEN_${role.toUpperCase()}`] : null;
  return bound || AUTH_TOKEN;
}

function getHeaders(role = 'builder') {
  const headers = { 'Content-Type': 'application/json' };
  const token = resolveToken(role);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (role) {
    headers['X-Agent-Role'] = role;
  }
  return headers;
}

async function claimTask(id, agentId, role = 'builder') {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}/claim${q}`, {
    method: 'POST',
    headers: getHeaders(role),
    // v3.8.0: body `role` is no longer read — identity comes from the
    // credential + X-Agent-Role header only.
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/tasks/${id}/claim failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function patchTask(id, patch) {
  const { role, ...rest } = patch;
  // Optimistic concurrency: send the version we just read (409 if stale).
  const current = await getTask(id);
  const res = await fetch(`${BASE_URL}/api/tasks/${id}${q}`, {
    method: 'PATCH',
    headers: getHeaders(role),
    // v3.8.0: a body `role` is rejected with 400 ('role is not mutable') —
    // the role travels in the header (or lives in the credential) only.
    body: JSON.stringify({ ...rest, expected_version: current.version }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PATCH /api/tasks/${id} -> ${patch.status} failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function addLog(id, agentId, message, role = 'builder') {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}/logs${q}`, {
    method: 'POST',
    headers: getHeaders(role),
    body: JSON.stringify({ agent_id: agentId, message }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/tasks/${id}/logs failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function printTask(label, task) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(task, null, 2));
}

async function runAgentAlpha() {
  console.log('\n[Agent-Alpha] Planner promotes task-1 BACKLOG -> READY...');
  await patchTask('task-1', { status: 'READY', role: 'planner' });
  await sleep(300);

  console.log('[Agent-Alpha] Claiming task-1 (READY -> IN_PROGRESS)...');
  await claimTask('task-1', 'Agent-Alpha');
  await sleep(300);

  console.log('[Agent-Alpha] Moving task-1 to BLOCKED (runner)...');
  await patchTask('task-1', { status: 'BLOCKED', role: 'runner' });
  await sleep(300);

  console.log('[Agent-Alpha] Logging blocker reason on task-1...');
  await addLog(
    'task-1',
    'Agent-Alpha',
    'Blocked: waiting on design review sign-off.',
    'runner'
  );
  await sleep(300);
}

async function runAgentBeta() {
  console.log('\n[Agent-Beta] Planner promotes task-3 BACKLOG -> READY...');
  await patchTask('task-3', { status: 'READY', role: 'planner' });
  await sleep(300);

  console.log('[Agent-Beta] Claiming task-3 (READY -> IN_PROGRESS)...');
  await claimTask('task-3', 'Agent-Beta');
  await sleep(300);

  console.log('[Agent-Beta] Builder submits task-3 for review (IN_REVIEW)...');
  await patchTask('task-3', { status: 'IN_REVIEW', role: 'builder' });
  await sleep(300);

  console.log('[Agent-Beta] Reviewer approves task-3 (VALIDATION)...');
  await patchTask('task-3', { status: 'VALIDATION', role: 'reviewer' });
  await sleep(300);

  console.log('[Agent-Beta] Tester verifies task-3 (READY_TO_SHIP)...');
  await patchTask('task-3', { status: 'READY_TO_SHIP', role: 'tester' });
  await sleep(300);

  console.log('[Agent-Beta] Releaser ships task-3 (DONE)...');
  await patchTask('task-3', { status: 'DONE', role: 'releaser' });
  await sleep(300);

  console.log('[Agent-Beta] Logging completion note on task-3...');
  await addLog(
    'task-3',
    'Agent-Beta',
    'Rate limiter implemented and tests passing.',
    'tester'
  );
  await sleep(300);
}

async function ensureTask(id, title) {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}${q}`);
  if (res.status === 404) {
    const created = await fetch(`${BASE_URL}/api/tasks`, {
      method: 'POST',
      headers: getHeaders('runner'),
      // v3.8.0: body role removed — identity comes from credential + header.
      body: JSON.stringify({ id, title, status: 'BACKLOG', round: 1, project: PROJECT }),
    });
    if (!created.ok) {
      throw new Error(`POST /api/tasks ${id} failed: ${created.status} ${await created.text().catch(() => '')}`);
    }
  }
}

async function main() {
  console.log(`Connecting to Agent Kanban Board API at ${BASE_URL} ...`);

  await ensureTask('task-1', 'Implement auth middleware');
  await ensureTask('task-3', 'Rate limiter service');

  const beforeTask1 = await getTask('task-1');
  const beforeTask3 = await getTask('task-3');
  printTask('BEFORE: task-1', beforeTask1);
  printTask('BEFORE: task-3', beforeTask3);

  await runAgentAlpha();
  await runAgentBeta();

  const afterTask1 = await getTask('task-1');
  const afterTask3 = await getTask('task-3');
  printTask('AFTER: task-1', afterTask1);
  printTask('AFTER: task-3', afterTask3);

  console.log('\nDone. Two agents claimed, updated, and logged against their tasks.');
}

main().catch((err) => {
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    console.error(
      `\nCould not reach ${BASE_URL} — make sure the server is running (cd server && npm start).`
    );
  } else {
    console.error(`\nDemo script failed: ${err.message}`);
  }
  process.exit(1);
});
