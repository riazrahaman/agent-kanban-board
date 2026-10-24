/**
 * Unit tests for the AgentOS 8-state state machine and role RBAC matrix (ADR-004).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STATUSES,
  VALID_STATUS_LIST,
  VALID_TRANSITIONS,
  ACTIVE_STATUSES,
  normalizeStatus,
  isValidStatus,
  canTransition,
  canRoleTransition,
  ACTIVE_STATUS_SET,
} from '../state-machine.js';

describe('AgentOS 8-state state-machine module', () => {
  it('defines the 8 canonical statuses + BLOCKED', () => {
    assert.deepEqual(STATUSES, {
      BACKLOG: 'BACKLOG',
      READY: 'READY',
      PLANNING: 'PLANNING',
      IN_PROGRESS: 'IN_PROGRESS',
      IN_REVIEW: 'IN_REVIEW',
      VALIDATION: 'VALIDATION',
      READY_TO_SHIP: 'READY_TO_SHIP',
      DONE: 'DONE',
      BLOCKED: 'BLOCKED',
    });
    assert.equal(VALID_STATUS_LIST.length, 9);
  });

  it('normalizeStatus handles aliases and case insensitivity', () => {
    assert.equal(normalizeStatus('todo'), 'BACKLOG');
    assert.equal(normalizeStatus('TODO'), 'BACKLOG');
    assert.equal(normalizeStatus('building'), 'IN_PROGRESS');
    assert.equal(normalizeStatus('BUILDING'), 'IN_PROGRESS');
    assert.equal(normalizeStatus('in_test'), 'VALIDATION');
    assert.equal(normalizeStatus('IN_TEST'), 'VALIDATION');
    assert.equal(normalizeStatus('in_progress'), 'IN_PROGRESS');
    assert.equal(normalizeStatus('ready'), 'READY');
    assert.equal(normalizeStatus('planning'), 'PLANNING');
    assert.equal(normalizeStatus('ready_to_ship'), 'READY_TO_SHIP');
    // Every stage the client counts as owned must be recorded server-side,
    // otherwise a tester's READY_TO_SHIP work leaves no owner behind.
    assert.ok(ACTIVE_STATUS_SET.has('READY_TO_SHIP'));
    assert.ok(ACTIVE_STATUS_SET.has('VALIDATION'));
    assert.ok(!ACTIVE_STATUS_SET.has('READY'));
    assert.ok(!ACTIVE_STATUS_SET.has('BACKLOG'));
    assert.equal(normalizeStatus('validation'), 'VALIDATION');
    assert.equal(normalizeStatus('unknown'), null);
    assert.equal(normalizeStatus(null), null);
    assert.equal(isValidStatus('ready_to_ship'), true);
    assert.equal(isValidStatus('invalid'), false);
  });

  it('canTransition enforces legal transitions along the 8-state pipeline', () => {
    // Self-transitions always allowed
    for (const status of VALID_STATUS_LIST) {
      assert.equal(canTransition(status, status), true, `Self-transition on ${status}`);
    }

    // BACKLOG
    assert.equal(canTransition('BACKLOG', 'READY'), true);
    assert.equal(canTransition('BACKLOG', 'BLOCKED'), true);
    assert.equal(canTransition('BACKLOG', 'IN_PROGRESS'), false);
    assert.equal(canTransition('BACKLOG', 'DONE'), false);

    // READY
    assert.equal(canTransition('READY', 'PLANNING'), true);
    assert.equal(canTransition('READY', 'IN_PROGRESS'), true);
    assert.equal(canTransition('READY', 'BACKLOG'), true);
    assert.equal(canTransition('READY', 'BLOCKED'), true);
    assert.equal(canTransition('READY', 'DONE'), false);

    // PLANNING
    assert.equal(canTransition('PLANNING', 'IN_PROGRESS'), true);
    assert.equal(canTransition('PLANNING', 'READY'), true);
    assert.equal(canTransition('PLANNING', 'BLOCKED'), true);
    assert.equal(canTransition('PLANNING', 'IN_REVIEW'), false);

    // IN_PROGRESS
    assert.equal(canTransition('IN_PROGRESS', 'IN_REVIEW'), true);
    assert.equal(canTransition('IN_PROGRESS', 'PLANNING'), true);
    assert.equal(canTransition('IN_PROGRESS', 'BLOCKED'), true);
    assert.equal(canTransition('IN_PROGRESS', 'VALIDATION'), false);
    assert.equal(canTransition('IN_PROGRESS', 'DONE'), false);

    // IN_REVIEW
    assert.equal(canTransition('IN_REVIEW', 'VALIDATION'), true);
    assert.equal(canTransition('IN_REVIEW', 'IN_PROGRESS'), true);
    assert.equal(canTransition('IN_REVIEW', 'BLOCKED'), true);
    assert.equal(canTransition('IN_REVIEW', 'READY_TO_SHIP'), false);

    // VALIDATION
    assert.equal(canTransition('VALIDATION', 'READY_TO_SHIP'), true);
    assert.equal(canTransition('VALIDATION', 'IN_PROGRESS'), true);
    assert.equal(canTransition('VALIDATION', 'BLOCKED'), true);
    assert.equal(canTransition('VALIDATION', 'DONE'), false, 'Validator cannot jump directly to DONE');

    // READY_TO_SHIP
    assert.equal(canTransition('READY_TO_SHIP', 'DONE'), true);
    assert.equal(canTransition('READY_TO_SHIP', 'IN_PROGRESS'), true);
    assert.equal(canTransition('READY_TO_SHIP', 'BLOCKED'), true);
    assert.equal(canTransition('READY_TO_SHIP', 'VALIDATION'), false);

    // BLOCKED
    assert.equal(canTransition('BLOCKED', 'BACKLOG'), true);
    assert.equal(canTransition('BLOCKED', 'READY'), true);
    assert.equal(canTransition('BLOCKED', 'PLANNING'), true);
    assert.equal(canTransition('BLOCKED', 'IN_PROGRESS'), true);
    assert.equal(canTransition('BLOCKED', 'IN_REVIEW'), true);
    assert.equal(canTransition('BLOCKED', 'VALIDATION'), true);
    assert.equal(canTransition('BLOCKED', 'DONE'), false);

    // DONE is terminal
    assert.equal(canTransition('DONE', 'IN_PROGRESS'), false);
    assert.equal(canTransition('DONE', 'BACKLOG'), false);
    assert.equal(canTransition('DONE', 'READY'), false);
  });

  it('canRoleTransition enforces role boundaries', () => {
    // Privileged bypass
    for (const role of ['runner', 'system', 'human', 'admin']) {
      assert.equal(canRoleTransition(role, 'DONE', 'IN_PROGRESS'), true);
      assert.equal(canRoleTransition(role, 'BACKLOG', 'BLOCKED'), true);
      assert.equal(canRoleTransition(role, 'READY_TO_SHIP', 'DONE'), true);
    }

    // Nobody unprivileged can set BLOCKED manually
    for (const role of ['planner', 'builder', 'reviewer', 'tester', 'validator', 'releaser']) {
      assert.equal(canRoleTransition(role, 'IN_PROGRESS', 'BLOCKED'), false);
    }

    // planner role
    assert.equal(canRoleTransition('planner', 'BACKLOG', 'READY'), true);
    assert.equal(canRoleTransition('planner', 'READY', 'PLANNING'), true);
    assert.equal(canRoleTransition('planner', 'PLANNING', 'IN_PROGRESS'), true);
    assert.equal(canRoleTransition('planner', 'PLANNING', 'READY'), true);
    assert.equal(canRoleTransition('planner', 'IN_PROGRESS', 'IN_REVIEW'), false);

    // builder role
    assert.equal(canRoleTransition('builder', 'READY', 'IN_PROGRESS'), true);
    assert.equal(canRoleTransition('builder', 'PLANNING', 'IN_PROGRESS'), true);
    assert.equal(canRoleTransition('builder', 'IN_PROGRESS', 'IN_REVIEW'), true);
    assert.equal(canRoleTransition('builder', 'IN_REVIEW', 'VALIDATION'), false);
    assert.equal(canRoleTransition('builder', 'IN_PROGRESS', 'DONE'), false);

    // reviewer role
    assert.equal(canRoleTransition('reviewer', 'IN_REVIEW', 'VALIDATION'), true);
    assert.equal(canRoleTransition('reviewer', 'IN_REVIEW', 'IN_PROGRESS'), true);
    assert.equal(canRoleTransition('reviewer', 'IN_REVIEW', 'READY_TO_SHIP'), false);

    // tester / validator role
    assert.equal(canRoleTransition('tester', 'VALIDATION', 'READY_TO_SHIP'), true);
    assert.equal(canRoleTransition('validator', 'VALIDATION', 'READY_TO_SHIP'), true);
    assert.equal(canRoleTransition('tester', 'VALIDATION', 'IN_PROGRESS'), true);
    assert.equal(canRoleTransition('tester', 'VALIDATION', 'DONE'), false, 'Tester cannot set DONE');

    // releaser role
    assert.equal(canRoleTransition('releaser', 'READY_TO_SHIP', 'DONE'), true);
    assert.equal(canRoleTransition('releaser', 'READY_TO_SHIP', 'IN_PROGRESS'), true);
    assert.equal(canRoleTransition('releaser', 'IN_PROGRESS', 'IN_REVIEW'), false);
  });
});

/**
 * v3.9.4 — the ACTIVE_STATUSES drift guard.
 *
 * This list is consumed in three places and had already drifted once: adding
 * READY_TO_SHIP to the server set left `client/src/lib/status.ts` (dashboard WIP
 * and signal stats) and a private copy in `server/askKnowledge.js` (the Ask
 * snapshot) still believing there were four active statuses. Same board, two
 * answers about whether a card is "in flight".
 *
 * The state machine is the source of truth. This test fails the moment either
 * consumer disagrees, so the next person who edits one list is told to edit the
 * other in the same commit.
 */
describe('ACTIVE_STATUSES is one list, not three', () => {
  it('the client copy matches the state machine exactly', () => {
    const clientSrc = readFileSync(new URL('../../client/src/lib/status.ts', import.meta.url), 'utf8');
    const block = clientSrc.match(/export const ACTIVE_STATUSES[^=]*=\s*\[([\s\S]*?)\]/);
    assert.ok(block, 'client/src/lib/status.ts must declare ACTIVE_STATUSES');
    const clientActive = [...block[1].matchAll(/CANONICAL_STATUSES\.([A-Z_]+)/g)].map((m) => m[1]);
    assert.deepEqual(
      [...clientActive].sort(),
      [...ACTIVE_STATUSES].sort(),
      'client ACTIVE_STATUSES must equal server ACTIVE_STATUSES',
    );
  });

  it('askKnowledge imports the list instead of copying it', () => {
    const askSrc = readFileSync(new URL('../askKnowledge.js', import.meta.url), 'utf8');
    assert.doesNotMatch(
      askSrc,
      /const ACTIVE_STATUSES\s*=/,
      'server/askKnowledge.js must import ACTIVE_STATUSES from state-machine.js, not keep a local copy',
    );
    assert.match(
      askSrc,
      /import \{[^}]*ACTIVE_STATUSES[^}]*\} from '\.\/state-machine\.js'/,
      'server/askKnowledge.js must import ACTIVE_STATUSES from state-machine.js',
    );
  });
});
