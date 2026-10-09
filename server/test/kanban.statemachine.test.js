/**
 * Unit tests for the AgentOS 8-state state machine and role RBAC matrix (ADR-004).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES,
  VALID_STATUS_LIST,
  VALID_TRANSITIONS,
  normalizeStatus,
  isValidStatus,
  canTransition,
  canRoleTransition,
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
