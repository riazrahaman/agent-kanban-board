#!/usr/bin/env node
/**
 * test-agents.js
 *
 * Headless demo of the multi-agent workflow against the Agent Kanban Board
 * API. Simulates two AI agents (Agent-Alpha and Agent-Beta) claiming tasks,
 * moving them through the board, and leaving log entries — all via plain
 * HTTP calls, no browser required.
 *
 * Usage:
 *   1. In one terminal: cd server && npm install && npm start
 *   2. In another:       node scripts/test-agents.js
 *
 * Optionally open the client in a browser first — the board updates live
 * via Server-Sent Events while this script runs, with no page refresh.
 */

const BASE_URL = 'http://localhost:4000';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTask(id) {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}`);
  if (!res.ok) {
    throw new Error(`GET /api/tasks/${id} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

const AUTH_TOKEN = process.env.KANBAN_AUTH_TOKEN || '';

function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
}

async function claimTask(id, agentId) {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}/claim`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/tasks/${id}/claim failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function patchTask(id, patch) {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/tasks/${id} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function addLog(id, agentId, message) {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}/logs`, {
    method: 'POST',
    headers: getHeaders(),
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
  console.log('\n[Agent-Alpha] Claiming task-1...');
  await claimTask('task-1', 'Agent-Alpha');
  await sleep(300);

  console.log('[Agent-Alpha] Moving task-1 to "blocked"...');
  await patchTask('task-1', { status: 'blocked' });
  await sleep(300);

  console.log('[Agent-Alpha] Logging blocker reason on task-1...');
  await addLog(
    'task-1',
    'Agent-Alpha',
    'Blocked: waiting on design review sign-off.'
  );
  await sleep(300);
}

async function runAgentBeta() {
  console.log('\n[Agent-Beta] Claiming task-3...');
  await claimTask('task-3', 'Agent-Beta');
  await sleep(300);

  console.log('[Agent-Beta] Submitting task-3 for review...');
  await patchTask('task-3', { status: 'IN_REVIEW', role: 'builder' });
  await sleep(300);

  console.log('[Agent-Beta] Moving task-3 to test verification...');
  await patchTask('task-3', { status: 'IN_TEST', role: 'reviewer' });
  await sleep(300);

  console.log('[Agent-Beta] Test verification passed, moving task-3 to DONE...');
  await patchTask('task-3', { status: 'DONE', role: 'tester' });
  await sleep(300);

  console.log('[Agent-Beta] Logging completion note on task-3...');
  await addLog(
    'task-3',
    'Agent-Beta',
    'Rate limiter implemented and tests passing.'
  );
  await sleep(300);
}

async function ensureTask(id, title) {
  const res = await fetch(`${BASE_URL}/api/tasks/${id}`);
  if (res.status === 404) {
    await fetch(`${BASE_URL}/api/tasks`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ id, title, status: 'BACKLOG' }),
    });
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
