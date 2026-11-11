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
import * as core from '../store/core.js';
import * as listeners from '../store/listeners.js';
import * as aggregates from '../store/aggregates.js';
import * as leases from '../store/leases.js';
import * as archive from '../store/archive.js';
import * as trash from '../store/trash.js';
import * as backups from '../store/backups.js';

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

  it('(a2) C1 (v3.12.5): store.js re-exports the ./store/* split with the SAME identities', () => {
    // State/primitives module
    assert.equal(store.withMutationLock, core.withMutationLock);
    assert.equal(store.getStorage, core.getStorage);
    assert.equal(store.setStorage, core.setStorage);
    assert.equal(store.getTasks, core.getTasks);
    assert.equal(store.getTask, core.getTask);
    assert.equal(store.getTaskCount, core.getTaskCount);
    assert.equal(store.getArchivedTasks, core.getArchivedTasks);
    assert.equal(store.getProjectBucket, core.getProjectBucket);
    assert.equal(store.setTaskInMemory, core.setTaskInMemory);
    assert.equal(store.nextVersionFor, core.nextVersionFor);
    assert.equal(store.listGitProjects, core.listGitProjects);

    // Listener buses
    assert.equal(store.onDiff, listeners.onDiff);
    assert.equal(store.onAudit, listeners.onAudit);
    assert.equal(store.emitAudit, listeners.emitAudit);
    assert.equal(store.notify, listeners.notify);
    assert.equal(store.listenerCounts, listeners.listenerCounts);
    assert.equal(store.onChange, listeners.onChange);
    assert.equal(store.onSettings, listeners.onSettings);
    assert.equal(store.settingsListenerCount, listeners.settingsListenerCount);
    assert.equal(store.emitSettings, listeners.emitSettings);

    // Aggregates
    assert.equal(store.getProjectSummaries, aggregates.getProjectSummaries);
    assert.equal(store.getMetrics, aggregates.getMetrics);
    assert.equal(store.resetClaimContention, aggregates.resetClaimContention);

    // Leases / reaper
    assert.equal(store.setNowFn, leases.setNowFn);
    assert.equal(store.leaseWindowFor, leases.leaseWindowFor);
    assert.equal(store.getMinLeaseMs, leases.getMinLeaseMs);
    assert.equal(store.getMaxLeaseMs, leases.getMaxLeaseMs);
    assert.equal(store.getProgressStallMs, leases.getProgressStallMs);
    assert.equal(store.isReaperEnabled, leases.isReaperEnabled);
    assert.equal(store.reclaimTask, leases.reclaimTask);
    assert.equal(store.reapExpiredClaims, leases.reapExpiredClaims);
    assert.equal(store.startReaper, leases.startReaper);
    assert.equal(store.stopReaper, leases.stopReaper);
    assert.equal(store.isReaperRunning, leases.isReaperRunning);

    // Archive / trash / backups
    assert.equal(store.runArchiveSweep, archive.runArchiveSweep);
    assert.equal(store.getTrashedTasks, trash.getTrashedTasks);
    assert.equal(store.restoreFromTrash, trash.restoreFromTrash);
    assert.equal(store.hardDeleteFromTrash, trash.hardDeleteFromTrash);
    assert.equal(store.runTrashSweep, trash.runTrashSweep);
    assert.equal(store.startBackup, backups.startBackup);
    assert.equal(store.stopBackup, backups.stopBackup);
    assert.equal(store.isBackupRunning, backups.isBackupRunning);
    assert.equal(store.runBackupNow, backups.runBackupNow);
    assert.equal(store.backupStatus, backups.backupStatus);
  });

  it('(a3) C1: the split has ONE home for the live state, shared by identity', () => {
    // The live task array is the same binding the accessors read; the index and
    // archive sinks live beside it. A duplicated `tasks = []` would make the
    // accessors observe a different array than the mutation paths.
    const project = taskIdentity.defaultProjectName();
    const before = store.getTaskCount();
    core.setTaskInMemory({ id: 'split-probe', project, status: 'READY', version: 1 });
    assert.equal(store.getTaskCount(), before + 1, 'facade accessor sees the core array');
    assert.equal(core.getTaskCount(), before + 1);
    assert.equal(store.getTask('split-probe', project).id, 'split-probe', 'same composite index');
    core.removeFromMemory(project, 'split-probe');
    assert.equal(store.getTaskCount(), before, 'cleanup restored the count');
    assert.ok(core.index instanceof Map);
    assert.equal(typeof core.archive, 'object');
    assert.equal(typeof core.trash, 'object');
    // The extracted modules import that state rather than keeping copies.
    assert.equal(typeof leases.reapExpiredClaims, 'function');
    assert.equal(typeof archive.runArchiveSweep, 'function');
    assert.equal(typeof trash.restoreFromTrash, 'function');
  });

  it('(b) state-machine module: statuses, transitions, role matrix', () => {
    assert.deepEqual(stateMachine.STATUSES, {
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
    assert.equal(stateMachine.normalizeStatus('todo'), 'BACKLOG');
    assert.equal(stateMachine.normalizeStatus('building'), 'IN_PROGRESS');
    assert.equal(stateMachine.normalizeStatus('in_test'), 'VALIDATION');
    assert.equal(stateMachine.normalizeStatus('nope'), null);
    assert.equal(stateMachine.canTransition('BACKLOG', 'READY'), true);
    assert.equal(stateMachine.canTransition('READY', 'IN_PROGRESS'), true);
    assert.equal(stateMachine.canTransition('DONE', 'IN_PROGRESS'), false);
    assert.equal(stateMachine.canTransition('BACKLOG', 'BACKLOG'), true, 'self-transition allowed');
    assert.equal(stateMachine.canRoleTransition('builder', 'READY', 'IN_PROGRESS'), true);
    assert.equal(stateMachine.canRoleTransition('builder', 'IN_PROGRESS', 'IN_REVIEW'), true);
    assert.equal(stateMachine.canRoleTransition('builder', 'IN_PROGRESS', 'VALIDATION'), false);
    assert.equal(stateMachine.canRoleTransition('reviewer', 'IN_REVIEW', 'VALIDATION'), true);
    assert.equal(stateMachine.canRoleTransition('tester', 'VALIDATION', 'READY_TO_SHIP'), true);
    assert.equal(stateMachine.canRoleTransition('tester', 'VALIDATION', 'DONE'), false);
    assert.equal(stateMachine.canRoleTransition('releaser', 'READY_TO_SHIP', 'DONE'), true);
    assert.equal(stateMachine.canRoleTransition('admin', 'DONE', 'IN_PROGRESS'), true, 'privileged bypass');
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
