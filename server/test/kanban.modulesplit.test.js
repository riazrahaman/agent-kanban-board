/**
 * ENH-11 (v2.10.0) — store.js module split. The pure state machine, task
 * identity, and field-validation helpers moved into dedicated modules; the
 * pluggable storage backends moved into storage.js. store.js re-exports every
 * extracted symbol, so existing `../store.js` importers must observe the SAME
 * function/object identities and behaviour.
 *
 * This suite is the guard that the split stayed faithful: it asserts both the
 * re-export identity (no accidental wrapper/duplicate) and a behavioural sample
 * of each module.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.js';
import * as stateMachine from '../state-machine.js';
import * as taskIdentity from '../task-identity.js';
import * as taskFields from '../task-fields.js';
import * as storage from '../storage.js';

describe('ENH-11 store module split', () => {
  it('(a) store.js re-exports the SAME identities as the extracted modules', () => {
    // State machine
    assert.equal(store.STATUSES, stateMachine.STATUSES);
    assert.equal(store.VALID_STATUS_LIST, stateMachine.VALID_STATUS_LIST);
    assert.equal(store.normalizeStatus, stateMachine.normalizeStatus);
    assert.equal(store.isValidStatus, stateMachine.isValidStatus);
    assert.equal(store.VALID_TRANSITIONS, stateMachine.VALID_TRANSITIONS);
    assert.equal(store.canTransition, stateMachine.canTransition);
    assert.equal(store.canRoleTransition, stateMachine.canRoleTransition);

    // Task identity
    assert.equal(store.writeAtomic, taskIdentity.writeAtomic);
    assert.equal(store.isValidProjectId, taskIdentity.isValidProjectId);
    assert.equal(store.isValidTaskId, taskIdentity.isValidTaskId);
    assert.equal(store.toBranch, taskIdentity.toBranch);
    assert.equal(store.defaultProjectName, taskIdentity.defaultProjectName);
    assert.equal(store.normalizeProject, taskIdentity.normalizeProject);
    assert.equal(store.resolveProjectScope, taskIdentity.resolveProjectScope);
    assert.equal(store.gitRoot, taskIdentity.gitRoot);
    assert.equal(store.jsonDataDir, taskIdentity.jsonDataDir);

    // Task fields
    assert.equal(store.PRIVILEGED_ROLE_SET, taskFields.PRIVILEGED_ROLE_SET);
    assert.equal(store.isPrivilegedRole, taskFields.isPrivilegedRole);
    assert.equal(store.validatePriority, taskFields.validatePriority);
    assert.equal(store.MAX_TITLE_LEN, taskFields.MAX_TITLE_LEN);
    assert.equal(store.MAX_DESCRIPTION_LEN, taskFields.MAX_DESCRIPTION_LEN);
    assert.equal(store.MAX_METADATA_BYTES, taskFields.MAX_METADATA_BYTES);
    assert.equal(store.validateDependsOn, taskFields.validateDependsOn);
    assert.equal(store.validateMetadata, taskFields.validateMetadata);
    assert.equal(store.priorityRank, taskFields.priorityRank);

    // Storage backends
    assert.equal(store.JsonStorage, storage.JsonStorage);
    assert.equal(store.GitYamlStorage, storage.GitYamlStorage);
  });

  it('(b) state-machine module: statuses, transitions, role matrix', () => {
    assert.deepEqual(stateMachine.STATUSES, {
      BACKLOG: 'BACKLOG',
      BUILDING: 'BUILDING',
      IN_REVIEW: 'IN_REVIEW',
      IN_TEST: 'IN_TEST',
      BLOCKED: 'BLOCKED',
      DONE: 'DONE',
    });
    assert.equal(stateMachine.normalizeStatus('todo'), 'BACKLOG');
    assert.equal(stateMachine.normalizeStatus('in_progress'), 'BUILDING');
    assert.equal(stateMachine.normalizeStatus('nope'), null);
    assert.equal(stateMachine.canTransition('BACKLOG', 'BUILDING'), true);
    assert.equal(stateMachine.canTransition('DONE', 'BUILDING'), false);
    assert.equal(stateMachine.canTransition('BACKLOG', 'BACKLOG'), true, 'self-transition allowed');
    assert.equal(stateMachine.canRoleTransition('builder', 'BACKLOG', 'IN_REVIEW'), true);
    assert.equal(stateMachine.canRoleTransition('builder', 'BUILDING', 'IN_TEST'), false);
    assert.equal(stateMachine.canRoleTransition('reviewer', 'IN_REVIEW', 'IN_TEST'), true);
    assert.equal(stateMachine.canRoleTransition('tester', 'IN_TEST', 'DONE'), true);
    assert.equal(stateMachine.canRoleTransition('admin', 'DONE', 'BUILDING'), true, 'privileged bypass');
  });

  it('(c) task-identity module: ids, branch normaliser, scope, backfill', () => {
    assert.equal(taskIdentity.isValidProjectId('alpha-1'), true);
    assert.equal(taskIdentity.isValidProjectId('bad id'), false);
    assert.equal(taskIdentity.isValidTaskId('t_1'), true);
    assert.equal(taskIdentity.toBranch('  fix/x  '), '  fix/x  ', 'kept verbatim untrimmed');
    assert.equal(taskIdentity.toBranch('   '), null);
    assert.equal(taskIdentity.toBranch(123), null);
    assert.deepEqual(taskIdentity.resolveProjectScope('atlas:foo', 'ignored'), {
      project: 'atlas',
      shortId: 'foo',
    });
    const backfilled = taskIdentity.backfillLeaseFields([{ id: 'x' }]);
    assert.equal(backfilled[0].version, 1);
    assert.equal(backfilled[0].claim_expires_at, null);
    assert.equal(backfilled[0].reclaim_count, 0);
    assert.deepEqual(backfilled[0].comments, []);
  });

  it('(d) task-fields module: priority/field validation + ranking', () => {
    assert.equal(taskFields.isPrivilegedRole('runner'), true);
    assert.equal(taskFields.isPrivilegedRole('builder'), false);
    assert.equal(taskFields.validatePriority('HIGH'), null);
    assert.equal(taskFields.validatePriority(7), 'priority must be a string (low, medium, or high)');
    assert.equal(typeof taskFields.validatePriority('urgent'), 'string');
    assert.equal(taskFields.validateDependsOn('not-an-array'), 'depends_on must be an array of task ids');
    assert.equal(taskFields.validateDependsOn(['a', 'b']), null);
    assert.equal(typeof taskFields.validateMetadata('str'), 'string');
    assert.equal(taskFields.validateMetadata({ a: 1 }), null);
    assert.equal(taskFields.priorityRank('high'), 0);
    assert.equal(taskFields.priorityRank('low'), 2);
    assert.equal(taskFields.priorityRank(undefined), 1);
  });

  it('(e) storage module: classes are constructible and independent of store.js', () => {
    assert.equal(typeof storage.JsonStorage, 'function');
    assert.equal(typeof storage.GitYamlStorage, 'function');
    const js = new storage.JsonStorage('/tmp/kanban-split-test/tasks.json', { project: 'alpha', isDefault: false });
    assert.equal(js.project, 'alpha');
    assert.equal(js.isDefault, false);
    assert.ok(js.filePath.endsWith('tasks.json'));
    // The class carries the full persistence surface used by the engine.
    for (const method of ['load', 'save', 'saveTask', 'deleteTask', 'loadArchive', 'saveArchive', 'loadTrash', 'saveTrash', 'loadSettings', 'saveSettings']) {
      assert.equal(typeof js[method], 'function', `JsonStorage.${method} exists`);
    }
  });
});
