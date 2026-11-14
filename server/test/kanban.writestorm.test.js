import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';

// v3.12.3 — perf B1 (Board Health Check): write amplification on the sibling
// lease-renewal path. Previously renewAllLeasesInner persisted each held card
// with its own `saveTask`; on the JSON backend (journal OFF = the default)
// every one of those degrades to a FULL-partition rewrite, so an agent holding
// N cards produced N stringify+write passes of the whole partition file on
// every heartbeat / holder write. The fix groups all candidates per project
// and persists each project ONCE via `storage.saveTasks(changed, bucket)`.
//
// This suite pins the grouped write path with a counting storage bound through
// `store.setStorage` (the same injection seam the lease suites use): the
// assertion target is exactly ONE save per affected project per renewal pass,
// with byte-identical final on-disk state and unchanged event semantics.

const NOW = 1_735_000_000_000; // fixed injectable clock (§2.4)
const TTL_MS = 60_000;

class CountingStorage extends store.JsonStorage {
  constructor(filePath, options = {}) {
    super(filePath, options);
    this.saveCount = 0;
    this.savedBuckets = [];
  }
  async save(tasks) {
    this.saveCount += 1;
    this.savedBuckets.push(tasks.map((t) => t.id));
    // Real disk write so the final on-disk state is verifiable, not just the
    // call count.
    await super.save(tasks);
  }
}

function seedHeldTask(id, project, agent, { status = 'IN_PROGRESS', expired = false } = {}) {
  const t = {
    id,
    project,
    title: id,
    status,
    round: 1,
    assigned_agent: agent,
    claim_lease_ms: TTL_MS,
    claim_expires_at: new Date(expired ? NOW - 1000 : NOW + TTL_MS).toISOString(),
    created_at: new Date(NOW).toISOString(),
    updated: new Date(NOW).toISOString(),
    version: 1,
    agent_logs: [],
    comments: [],
    issues: [],
    metadata: {},
  };
  store.setTaskInMemory(t);
  return t;
}

function resetCounts(...storages) {
  for (const s of storages) {
    s.saveCount = 0;
    s.savedBuckets = [];
  }
}

describe('v3.12.3 B1 — sibling lease renewals grouped into one save per project', () => {
  let tmpDir;
  let realNow;
  let defaultStorage;
  let atlasStorage;
  let betaStorage;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    process.env.KANBAN_STORAGE_JOURNAL = '0';
    delete process.env.KANBAN_DEFAULT_PROJECT;
    process.env.KANBAN_REAP_ENABLED = 'false';
    process.env.KANBAN_CLAIM_TTL_MS = String(TTL_MS);
    realNow = () => Date.now();
    store.setNowFn(() => NOW);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-writestorm-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    store.setStorage(null);
    defaultStorage = new CountingStorage(path.join(tmpDir, 'tasks.json'), { project: 'default', isDefault: true });
    atlasStorage = new CountingStorage(path.join(tmpDir, 'atlas.json'), { project: 'atlas', isDefault: false });
    betaStorage = new CountingStorage(path.join(tmpDir, 'beta.json'), { project: 'beta', isDefault: false });
    store.setStorage(defaultStorage);
    store.setStorage(atlasStorage, 'atlas');
    store.setStorage(betaStorage, 'beta');
  });

  after(async () => {
    store.stopReaper();
    store.setNowFn(realNow);
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_CLAIM_TTL_MS;
    delete process.env.KANBAN_REAP_ENABLED;
    process.env.KANBAN_STORAGE_JOURNAL = '0';
    store.setStorage(null);
  });

  it('1. bulk renewal of N held cards in ONE project persists exactly ONE save (was N)', async () => {
    const storage = store.getStorage('default');
    for (let i = 1; i <= 3; i++) seedHeldTask(`ws-a${i}`, 'default', 'ws-agent');
    // A foreign card the sweep must not renew or bump.
    seedHeldTask('ws-foreign', 'default', 'other-agent');
    // A lapsed lease must NOT be revived (v2.12.0 semantics) — its on-disk
    // expiry stays at the lapsed value even though it sits in the bucket.
    seedHeldTask('ws-lapsed', 'default', 'ws-agent', { expired: true });

    resetCounts(storage);
    const result = await store.renewAllLeases('ws-agent', {});

    assert.equal(result.status, 200);
    assert.equal(result.count, 3, 'exactly the 3 non-lapsed held cards renewed');
    assert.deepEqual(
      [...result.renewed].sort(),
      ['default/ws-a1', 'default/ws-a2', 'default/ws-a3'],
    );
    assert.equal(storage.saveCount, 1, `ONE partition save for 3 renewals (pre-fix: 3)`);
    assert.deepEqual(storage.savedBuckets[0].sort(), ['ws-a1', 'ws-a2', 'ws-a3', 'ws-foreign', 'ws-lapsed']);

    // Final on-disk state: all 5 cards present, renewed cards carry the new
    // expiry, the foreign and lapsed cards are untouched.
    const raw = JSON.parse(await readFile(path.join(tmpDir, 'tasks.json'), 'utf-8'));
    const byId = new Map(raw.tasks.map((t) => [t.id, t]));
    assert.equal(raw.tasks.length, 5);
    for (const id of ['ws-a1', 'ws-a2', 'ws-a3']) {
      assert.equal(byId.get(id).claim_expires_at, new Date(NOW + TTL_MS).toISOString());
      assert.equal(byId.get(id).assigned_agent, 'ws-agent');
    }
    assert.equal(
      byId.get('ws-lapsed').claim_expires_at,
      new Date(NOW - 1000).toISOString(),
      'lapsed lease not revived',
    );
    assert.equal(byId.get('ws-foreign').assigned_agent, 'other-agent');
  });

  it('2. one renewal pass across THREE projects saves each project exactly once', async () => {
    const defaultStorage = store.getStorage('default');
    const atlas = store.getStorage('atlas');
    const beta = store.getStorage('beta');
    seedHeldTask('ws-x1', 'atlas', 'ws-multi');
    seedHeldTask('ws-x2', 'atlas', 'ws-multi');
    seedHeldTask('ws-y1', 'beta', 'ws-multi');
    seedHeldTask('ws-y2', 'beta', 'ws-multi', { status: 'PLANNING' });
    seedHeldTask('ws-z1', 'default', 'ws-multi');

    resetCounts(defaultStorage, atlas, beta);
    const result = await store.renewAllLeases('ws-multi', {});

    assert.equal(result.count, 5);
    assert.equal(atlas.saveCount, 1, 'atlas: one save for 2 renewals (was 2)');
    assert.equal(beta.saveCount, 1, 'beta: one save for 2 renewals (was 2)');
    assert.equal(defaultStorage.saveCount, 1, 'default: one save for 1 renewal');
    assert.deepEqual(atlas.savedBuckets[0].sort(), ['ws-x1', 'ws-x2']);
    assert.deepEqual(beta.savedBuckets[0].sort(), ['ws-y1', 'ws-y2']);

    // On-disk: each named partition contains exactly its own project's cards
    // with the renewed expiry (no cross-project leakage).
    for (const [file, ids] of [
      ['atlas.json', ['ws-x1', 'ws-x2']],
      ['beta.json', ['ws-y1', 'ws-y2']],
    ]) {
      const raw = JSON.parse(await readFile(path.join(tmpDir, file), 'utf-8'));
      assert.equal(raw.project, file.replace('.json', ''));
      assert.deepEqual(raw.tasks.map((t) => t.id).sort(), ids);
      for (const t of raw.tasks) {
        assert.equal(t.claim_expires_at, new Date(NOW + TTL_MS).toISOString());
      }
    }
  });

  it('3. holder write (appendLog) still renews siblings, primary and siblings in ONE save', async () => {
    const storage = store.getStorage('default');
    seedHeldTask('ws-h1', 'default', 'ws-holder');
    seedHeldTask('ws-h2', 'default', 'ws-holder');
    seedHeldTask('ws-h3', 'default', 'ws-holder');

    resetCounts(storage);
    const result = await store.appendLog('ws-h1', 'ws-holder', 'progress on h1', 'default');

    assert.equal(result.status, 200);
    // v3.12.3: 1 primary saveTask + 3 sibling saveTask = 4 full-partition
    // writes became 1 primary + 1 grouped sibling save. Batch 3: the primary
    // and its siblings persist together in ONE save.
    assert.equal(storage.saveCount, 1, 'primary write and sibling renewals in ONE save');
    // The single save is the live project bucket: every card present exactly
    // once, with all three h-cards included.
    const siblingBucket = storage.savedBuckets[0];
    assert.equal(new Set(siblingBucket).size, siblingBucket.length, 'no duplicate cards in the bucket');
    for (const id of ['ws-h1', 'ws-h2', 'ws-h3']) {
      assert.ok(siblingBucket.includes(id), `bucket includes ${id}`);
    }

    const raw = JSON.parse(await readFile(path.join(tmpDir, 'tasks.json'), 'utf-8'));
    const byId = new Map(raw.tasks.map((t) => [t.id, t]));
    const primaryExpiry = byId.get('ws-h1').claim_expires_at;
    for (const id of ['ws-h2', 'ws-h3']) {
      assert.equal(
        byId.get(id).claim_expires_at,
        primaryExpiry,
        'sibling renewed to the same expiry as the primary card',
      );
    }
    // Sibling renewal must not bump the CAS version (I-1, unchanged).
    assert.equal(byId.get('ws-h2').version, 1);
    // The primary card got the log; the siblings did not.
    assert.equal(byId.get('ws-h1').agent_logs.length, 1);
    assert.equal(byId.get('ws-h2').agent_logs.length, 0);
  });

  it('4. journal ON: the grouped batch appends N journal lines and does NOT rewrite the partition', async () => {
    const storage = store.getStorage('default');
    seedHeldTask('ws-j1', 'default', 'ws-journal');
    seedHeldTask('ws-j2', 'default', 'ws-journal');
    seedHeldTask('ws-j3', 'default', 'ws-journal');

    process.env.KANBAN_STORAGE_JOURNAL = '1';
    try {
      resetCounts(storage);
      const result = await store.renewAllLeases('ws-journal', {});
      assert.equal(result.count, 3);
      assert.equal(storage.saveCount, 0, 'journal mode must not rewrite the partition');

      const journalPath = `${path.join(tmpDir, 'tasks.json')}.journal.jsonl`;
      assert.ok(existsSync(journalPath), 'journal file created');
      const lines = (await readFile(journalPath, 'utf-8')).trim().split('\n');
      assert.equal(lines.length, 3, 'one journal line per renewed card, single append');
      const entries = lines.map((l) => JSON.parse(l));
      assert.deepEqual(entries.map((e) => e.id).sort(), ['ws-j1', 'ws-j2', 'ws-j3']);
      for (const e of entries) {
        assert.equal(e.op, 'upsert');
        assert.equal(e.task.claim_expires_at, new Date(NOW + TTL_MS).toISOString());
      }
      // In-memory state is updated exactly as before.
      for (const id of ['ws-j1', 'ws-j2', 'ws-j3']) {
        assert.equal(store.getTask(id).claim_expires_at, new Date(NOW + TTL_MS).toISOString());
      }
    } finally {
      process.env.KANBAN_STORAGE_JOURNAL = '0';
    }
  });

  it('5. a failing grouped save still cannot throw out of the sweep (I-6 preserved)', async () => {
    // Bind a one-shot failing storage for a dedicated project, run the sweep,
    // then restore. The failure is isolated to that project and never rejects.
    class FailingStorage extends store.JsonStorage {
      async saveTasks() {
        throw new Error('disk full (simulated)');
      }
    }
    const failing = new FailingStorage(path.join(tmpDir, 'failing.json'), { project: 'failing', isDefault: false });
    store.setStorage(failing, 'failing');
    seedHeldTask('ws-f1', 'failing', 'ws-fail');
    seedHeldTask('ws-f2', 'failing', 'ws-fail');
    try {
      const result = await store.renewAllLeases('ws-fail', {});
      assert.equal(result.status, 200);
      assert.equal(result.count, 0, 'failing project contributes no renewed keys');
      // The sibling tasks were NOT applied to memory (persist-first ordering).
      assert.equal(store.getTask('ws-f1', 'failing').claim_expires_at, new Date(NOW + TTL_MS).toISOString());
    } finally {
      // setStorage(null, ...) clears the whole cache, so rebind all counting
      // instances explicitly for any later test.
      store.setStorage(defaultStorage);
      store.setStorage(atlasStorage, 'atlas');
      store.setStorage(betaStorage, 'beta');
    }
  });
});
