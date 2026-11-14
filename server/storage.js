/**
 * Pluggable storage backends (KB-09) — partitioned per project (§2.1/§2.8),
 * extracted verbatim from store.js (ENH-11, v2.10.0).
 *
 * Two interchangeable backends implement the same surface:
 *   - JsonStorage     : a single atomic JSON file per project (+ archive,
 *                       trash, settings siblings, and an optional append-only
 *                       journal under KANBAN_STORAGE_JOURNAL=1).
 *   - GitYamlStorage  : one YAML card per task, one real git commit per write.
 *
 * store.js re-exports both so existing `../store.js` importers are unaffected.
 */
import { readFile, rename, mkdir, readdir, rm, stat, open } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'yaml';
import {
  writeAtomic,
  fsyncDir,
  toBranch,
  toMilestone,
  defaultProjectName,
  jsonDataDir,
  backfillLeaseFields,
} from './task-identity.js';
import { STATUSES } from './state-machine.js';

const execFileAsync = promisify(execFile);

/**
 * Batch 3: durable journal I/O. Each append opens the journal, writes, fsyncs
 * and closes it (a persistent handle would keep writing to a journal that
 * load moved aside); a newly created journal also fsyncs its directory.
 */
async function appendDurable(file, data, { syncDir = true } = {}) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const created = !existsSync(file);
  const handle = await open(file, 'a+');
  let before = 0;
  try {
    before = (await handle.stat()).size;
    let payload = data;
    if (before > 0) {
      // COR-102: a crash can leave an unterminated last line; start the new
      // record on its own line so it cannot merge with the torn fragment.
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, before - 1);
      if (last[0] !== 0x0a) payload = `\n${data}`;
    }
    try {
      await handle.writeFile(payload, 'utf-8');
      await handle.sync();
    } catch (err) {
      // COR-103: a failed append must not be replayed after a restart. Roll
      // back by truncating; if that fails, replace the journal atomically
      // with its pre-append prefix. If neither works the record may still be
      // on disk, so flag the error and let the storage refuse journal appends
      // until a canonical write supersedes the journal.
      let rolledBack = false;
      try { await handle.truncate(before); await handle.sync(); rolledBack = true; } catch { /* try the fallback */ }
      if (!rolledBack) {
        try {
          const prefix = (await readFile(file)).subarray(0, before);
          await writeAtomic(file, prefix);
          rolledBack = true;
        } catch { /* flagged below */ }
      }
      if (!rolledBack) {
        err.journalRollbackFailed = true;
        err.journalOffset = before;
      }
      throw err;
    }
  } finally {
    await handle.close();
  }
  if (created && syncDir) await fsyncDir(dir);
  return before;
}

/** Truncates (or creates) the journal and fsyncs it. */
async function truncateDurable(file) {
  const handle = await open(file, 'w');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Runs a boot-time journal fold / set-aside step and tags any failure with
 * `journalFold`, so `JsonStorage.load()` can refuse to start with an accurate
 * message instead of reporting a corrupt data file.
 */
async function journalFoldStep(fn) {
  try {
    return await fn();
  } catch (cause) {
    const err = new Error(`journal fold failed: ${cause && cause.message ? cause.message : String(cause)}`, { cause });
    err.journalFold = true;
    throw err;
  }
}

/**
 * Raised when a journal append failed, could not be rolled back and could not
 * be superseded: the change may or may not survive a restart.
 */
export class StorageOutcomeUnknownError extends Error {
  constructor(cause, changedTasks, diskReadable = true) {
    super(
      `Storage unavailable: the outcome of this change is unknown and it may have been applied. Re-read the task before retrying (expected_version will expose it). (${cause && cause.message ? cause.message : String(cause)})`,
      { cause },
    );
    this.outcomeUnknown = true;
    this.status = 503;
    // Only the tasks a restart would actually load (empty when the disk state
    // could not be read: fail closed, apply nothing).
    this.changedTasks = changedTasks;
    this.diskReadable = diskReadable;
  }
}

export class JsonStorage {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    // project may be undefined (legacy default), 'default', or a named project.
    this.project = options.project;
    this.isDefault = options.isDefault === true || !this.project || this.project === defaultProjectName();
    // Archive lives in a sibling `archive/` directory next to the tasks dir.
    const dir = path.dirname(filePath);
    this.archiveFile = path.join(dir, 'archive', `${this.project || defaultProjectName()}.json`);
    // v2.5.0: per-project display settings sink, mirroring the archive sibling
    // precedent. The default project anchors its settings next to the live
    // tasks file (KANBAN_DATA_FILE / server/tasks.json) so a deploy without
    // KANBAN_DATA_DIR never falls into the cross-repo jsonDataDir() fallback.
    this.settingsFile = this.isDefault
      ? path.join(dir, 'settings.json')
      : path.join(jsonDataDir(), 'settings', `${this.project}.json`);
    // PERF-02: append-only journal path (sibling of the main file).
    this.journalFile = `${filePath}.journal.jsonl`;
  }

  // PERF-02: journal env-var helpers. When KANBAN_STORAGE_JOURNAL is not '1',
  // the journal is OFF and behavior is byte-identical to the pre-2.8 path.
  _journalEnabled() {
    return process.env.KANBAN_STORAGE_JOURNAL === '1';
  }
  _journalCompactBytes() {
    const raw = process.env.KANBAN_JOURNAL_COMPACT_BYTES;
    if (raw === undefined || raw === '') return 1024 * 1024;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 1024 * 1024;
  }

  /**
   * Batch 3 — journal generations. The base file records an integer
   * `generation` in its JSON wrapper (`{ generation, tasks }` for the default
   * project, `{ project, generation, tasks }` for a named one; both shapes are
   * already objects, so no sidecar file is needed and older readers ignore the
   * extra key). Every journal line carries the generation of the base it was
   * appended against, and every full base write increments it. On load only
   * lines whose generation equals the base's are replayed, so lines that
   * survive a base rewrite (crash before truncation) are ignored however the
   * clocks moved. A base without the key is generation 0.
   *
   * Journals written before this release carry no generation; for those the
   * previous mtime rule still decides, once, until the next base write.
   */
  static generationOf(parsed) {
    const g = parsed && parsed.generation;
    return Number.isInteger(g) && g >= 0 ? g : 0;
  }

  /**
   * The one replay rule, shared by load and by failure reconciliation: apply
   * the journal entries of the base's generation (and untagged ones only when
   * `applyUntagged`) over `baseList`, never letting an older version replace a
   * newer one. Pure: returns the resulting map, the count of ignored (stale)
   * lines and, per id, the entry that produced the final record.
   */
  static replayEntries(baseList, entries, baseGeneration, applyUntagged = false) {
    const tagged = (e) => Number.isInteger(e && e.generation);
    const byId = new Map(baseList.map((t) => [t.id, t]));
    const winners = new Map();
    let ignored = 0;
    for (const entry of entries) {
      if (tagged(entry) ? entry.generation !== baseGeneration : !applyUntagged) {
        ignored += 1;
        continue;
      }
      if (entry.op === 'upsert' && entry.task) {
        // Never let an older version of a task overwrite a newer one.
        const existing = byId.get(entry.task.id);
        if (existing && Number.isInteger(existing.version) && Number.isInteger(entry.task.version)
            && entry.task.version < existing.version) continue;
        byId.set(entry.task.id, entry.task);
        winners.set(entry.task.id, entry);
      } else if (entry.op === 'remove' && entry.id) {
        byId.delete(entry.id);
        winners.delete(entry.id);
      }
    }
    return { byId, ignored, winners };
  }

  /** Parses journal text the way load does: bad lines are skipped. */
  static parseJournal(text) {
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skipped, as on load */ }
    }
    return entries;
  }

  /** Generation of the base on disk (cached after load or the first lookup). */
  async _baseGeneration() {
    if (Number.isInteger(this.generation)) return this.generation;
    try {
      this.generation = JsonStorage.generationOf(JSON.parse(await readFile(this.filePath, 'utf-8')));
    } catch {
      this.generation = 0; // absent (or unreadable: load refuses to boot on it)
    }
    return this.generation;
  }

  async load() {
    if (!existsSync(this.filePath)) {
      this.generation = 0;
      // PERF-02: absent base file but journal may have entries (first boot
      // with journaling ON — saveTask only appends to the journal until
      // compaction). Replay the journal over an empty list.
      if (existsSync(this.journalFile)) {
        const list = [];
        try {
          await this._replayJournal(list, 0);
        } catch (err) {
          if (err && err.journalFold) {
            console.error(
              `[kanban JsonStorage] could not fold the journal ${this.journalFile} into a new base or set it aside: ${err.cause?.message || err.message} — refusing to start (fix the cause, e.g. directory permissions, and restart; no data was discarded)`
            );
          }
          throw err;
        }
        return list;
      }
      return []; // absent file: normal first boot
    }
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
       // §2.6: legacy JSON records predate the CAS version field; backfill to 1
       // so the first patch bumps a well-defined baseline.
      const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      backfillLeaseFields(list);
      this.generation = JsonStorage.generationOf(parsed);
      // Replay an existing journal over the base whatever the flag says; the
      // generation check (or, for an old journal, the mtime rule) drops lines
      // that the base already supersedes.
      if (existsSync(this.journalFile)) {
        await this._replayJournal(list, this.generation);
      }
      return list;
    } catch (err) {
      if (err && err.journalFold) {
        // The base parsed fine; folding the journal or moving it aside failed
        // (e.g. a refused rename). Still refuse to start, but say so instead
        // of blaming the data file. Nothing has been discarded: the journal is
        // still on disk and the base, if rewritten, was written atomically.
        console.error(
          `[kanban JsonStorage] could not fold the journal ${this.journalFile} into the base or set it aside: ${err.cause?.message || err.message} — refusing to start (fix the cause, e.g. directory permissions, and restart; no data was discarded)`
        );
        throw err;
      }
      // BUG-01 (v2.5.2): the file EXISTS but is corrupt (parse failure, wrong
      // shape, unreadable). Fail closed — loading an empty list here would let
      // the next save overwrite the corrupt file and destroy the board's
      // data. startServer awaits loadStore(), so the throw refuses to boot.
      console.error(
        `[kanban JsonStorage] corrupt data file ${this.filePath}: ${err.message} — refusing to start (fix or remove the file; a backup may be recoverable)`
      );
      throw err;
    }
  }

  /** Pre-generation rule: the journal is not older than the base (no side effects). */
  async _journalNewerThanBase() {
    try {
      const base = await stat(this.filePath);
      const journal = await stat(this.journalFile);
      return journal.mtimeMs >= base.mtimeMs;
    } catch {
      return true; // no base to compare against (or journal vanished)
    }
  }

  /**
   * Legacy (generation-less) journals only: true when the journal is not older
   * than the base file. An older, non-empty journal is moved aside
   * (recoverable) so a later append cannot make it look fresh again; an older
   * empty one is simply removed.
   */
  async _journalIsCurrent() {
    if (await this._journalNewerThanBase()) return true;
    let size = 0;
    try {
      size = (await stat(this.journalFile)).size;
    } catch {
      return false;
    }
    if (size === 0) {
      await rm(this.journalFile, { force: true });
      return false;
    }
    const aside = `${this.journalFile}.stale-${Date.now()}`;
    await rename(this.journalFile, aside);
    console.warn(`[kanban JsonStorage] journal older than base ignored and moved to ${path.basename(aside)}`);
    return false;
  }

  /**
   * PERF-02 — replay the append-only journal over the base task list.
   * Each journal line is `{op:'upsert'|'remove', id, task?, generation}`. An
   * `upsert` replaces or appends the task by id; a `remove` drops it. Only
   * lines of the base's generation apply (see `generationOf`). After replay,
   * if the journal exceeds the compact threshold, compact it into the base
   * file and truncate the journal.
   */
  async _replayJournal(baseList, baseGeneration) {
    const journalRaw = await readFile(this.journalFile, 'utf-8');
    const entries = [];
    for (const line of journalRaw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch (err) {
        console.warn(`[kanban JsonStorage] journal replay skip bad line: ${err.message}`);
      }
    }
    const tagged = (e) => Number.isInteger(e && e.generation);
    let applyUntagged;
    if (!entries.some(tagged)) {
      // A journal from before generations: the old mtime rule, exactly as
      // before (including moving a stale journal aside).
      if (!(await journalFoldStep(() => this._journalIsCurrent()))) return;
      applyUntagged = true;
    } else {
      applyUntagged = entries.some((e) => !tagged(e)) ? await this._journalNewerThanBase() : false;
    }

    const { byId, ignored } = JsonStorage.replayEntries(baseList, entries, baseGeneration, applyUntagged);
    const replayed = [...byId.values()];
    backfillLeaseFields(replayed);

    if (ignored > 0) {
      // Superseded lines must not stay in the live journal: a later append
      // would make an untagged line look current again by mtime (and a
      // tagged one could match a future generation after a downgrade and
      // upgrade). Fold the lines that DID apply into a new base (which bumps
      // the generation), then move the journal aside, recoverable, exactly
      // like the all-untagged stale path.
      const aside = `${this.journalFile}.stale-${Date.now()}`;
      await journalFoldStep(async () => {
        await this._writeCanonical(replayed);
        await rename(this.journalFile, aside);
        await fsyncDir(path.dirname(this.journalFile));
      });
      console.warn(
        `[kanban JsonStorage] ${ignored} superseded journal line(s) ignored; journal folded into the base and moved to ${path.basename(aside)}`
      );
    } else if (Buffer.byteLength(journalRaw, 'utf8') >= this._journalCompactBytes()) {
      // Compact if the journal is large: write the replayed list to the base
      // file (writeAtomic) and truncate the journal. This keeps the journal
      // bounded while the base file stays the canonical source.
      await journalFoldStep(async () => {
        await this._writeCanonical(replayed);
        await truncateDurable(this.journalFile);
      });
    }
    // Mutate baseList in place so the caller sees the replayed state.
    baseList.length = 0;
    for (const t of replayed) baseList.push(t);
  }

  /**
   * Writes the canonical base file (the full `{generation, tasks:[...]}` or
   * `{project, generation, tasks:[...]}` shape) with the NEXT generation, so
   * any journal line written against the previous base is superseded. Used by
   * both `save()` and journal compaction.
   */
  async _writeCanonical(tasks, opts) {
    const generation = (await this._baseGeneration()) + 1;
    const payload = this.isDefault
      ? { generation, tasks }
      : { project: this.project, generation, tasks };
    // B1: compact JSON. The partition is rewritten on every mutation, so the
    // two-space indentation cost real bytes and stringify time; the loader is
    // a plain JSON.parse and reads either form.
    await writeAtomic(this.filePath, JSON.stringify(payload), opts);
    this.generation = generation;
    // A new generation supersedes every earlier journal line, rejected ones included.
    this._journalPoison = null;
  }

  /** Appends journal entries tagged with the current base generation (fsynced). */
  async _appendJournal(entries, opts) {
    if (this._journalPoison) {
      throw new Error(
        `journal unusable after an unrecoverable append failure (${this._journalPoison.message}); restart after freeing the disk problem`,
        { cause: this._journalPoison },
      );
    }
    const generation = await this._baseGeneration();
    let payload = '';
    for (const e of entries) payload += JSON.stringify({ ...e, generation }) + '\n';
    try {
      return await appendDurable(this.journalFile, payload, opts);
    } catch (err) {
      if (err && err.journalRollbackFailed) {
        this._journalPoison = err;
        console.error(`[kanban JsonStorage] journal append failed and could not be rolled back: ${err.message}`);
        // Memory must equal what a restart would load. First try to supersede
        // the rejected record with a canonical rewrite of the state without it.
        if (await this._supersedeRejectedTail(err.journalOffset)) throw err;
        // That failed too: some of the rejected records may replay. Derive,
        // with the same replay rule load uses, which of them reached the disk.
        console.error('[kanban JsonStorage] could not supersede the rejected journal record; outcome unknown, journal appends refused until a full rewrite');
        let applied = [];
        let readable = false;
        try {
          const derived = this._deriveReplayState(await readFile(this.journalFile, 'utf-8'));
          if (derived) {
            readable = true;
            applied = entries
              .filter((e) => e.op === 'upsert' && e.task)
              .map((e) => e.task)
              .filter((t) => {
                const w = derived.winners.get(t.id);
                return w && isDeepStrictEqual(w.task, JSON.parse(JSON.stringify(t)));
              });
          }
        } catch { /* unreadable: fail closed, apply nothing */ }
        throw new StorageOutcomeUnknownError(err, applied, readable);
      }
      throw err;
    }
  }

  /**
   * State a restart would load from the on-disk base plus the given journal
   * text, via the shared replay rule. Null when it cannot be derived reliably
   * (unreadable base, or legacy untagged lines whose rule depends on mtimes).
   */
  _deriveReplayState(journalText) {
    let list = [];
    let generation = 0;
    if (existsSync(this.filePath)) {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      generation = JsonStorage.generationOf(parsed);
    }
    const entries = JsonStorage.parseJournal(journalText);
    if (entries.some((e) => !Number.isInteger(e && e.generation))) return null;
    const { byId, winners } = JsonStorage.replayEntries(list, entries, generation, false);
    return { state: [...byId.values()], generation, winners };
  }

  /**
   * Rewrites the base (full durability, next generation) from the state a
   * restart would load WITHOUT the journal bytes after `offset`. The new
   * generation supersedes every journal line, the rejected one included, and
   * clears the append refusal. Returns false when it cannot be derived/written.
   */
  async _supersedeRejectedTail(offset) {
    try {
      const prefix = (await readFile(this.journalFile)).subarray(0, offset).toString('utf-8');
      const derived = this._deriveReplayState(prefix);
      if (!derived) return false;
      backfillLeaseFields(derived.state);
      this.generation = derived.generation;
      await this._writeCanonical(derived.state);
      return true;
    } catch {
      return false;
    }
  }

  /** One compaction check after an append. */
  async _maybeCompact(allTasks) {
    let size;
    try {
      size = (await stat(this.journalFile)).size;
    } catch {
      return; // stat failure: the journal is advisory, not authoritative.
    }
    if (size >= this._journalCompactBytes()) {
      // COR-103: the append is already durable, so a failed compaction must
      // not turn the (successful) write into an error. The journal stays
      // authoritative and the next write retries the compaction.
      try {
        await this._writeCanonical(allTasks);
        await truncateDurable(this.journalFile);
      } catch (err) {
        console.warn(`[kanban JsonStorage] journal compaction deferred: ${err.message}`);
      }
    }
  }

  async save(tasks, opts) {
    // PERF-02: when journaling is ON, `save` is a full canonical rewrite
    // (used by archive sweep / delete / purge — the partition must reflect the
    // surviving set). The journal is truncated because the base file is now
    // authoritative for the full set (and its new generation would make any
    // surviving line inert even if the truncation did not happen).
    if (this._journalEnabled()) {
      await this._writeCanonical(tasks);
      await truncateDurable(this.journalFile);
      return;
    }
    // Default project keeps the legacy `{ tasks: [...] }` shape (plus the
    // generation key). Named partitions embed the project name so the
    // partition is self-describing.
    // PERF-101: a journal about to be retired may hold acknowledged writes that
    // only this base now carries, so that rewrite always gets the full fsync
    // pair, whatever the caller asked for.
    const retiring = existsSync(this.journalFile);
    await this._writeCanonical(tasks, retiring ? undefined : opts);
    // A full base save supersedes any journal left by an earlier run with the
    // flag on, so it can never be replayed over this newer base.
    if (retiring) await rm(this.journalFile, { force: true });
  }

  /**
   * PERF-02 — single-task save with an append-only journal fast path.
   * When the journal is enabled, append one JSON line `{op:'upsert', task}`
   * instead of rewriting the entire partition file. This reduces write
   * amplification from O(partition) to O(1) per mutation. The journal is
   * replayed on `load()` and compacted when it exceeds the threshold.
   *
   * With the journal OFF (default), this delegates to the whole-partition
   * rewrite.
   */
  async saveTask(task, allTasks, opts = {}) {
    const durability = opts.syncDir === false ? { syncDir: false } : undefined;
    if (this._journalEnabled()) {
      await this._appendJournal([{ op: 'upsert', id: task.id, task }], durability);
      await this._maybeCompact(allTasks);
      return;
    }
    await this.save(allTasks, durability);
  }

  /**
   * B1 (v3.12.3) — batched persist for a holder write plus its sibling lease
   * renewals.
   *
   * `changed` is the set of tasks mutated in this batch; `allTasks` is the full
   * project bucket AFTER those mutations. The two backends persist at different
   * granularity, so the arguments carry both shapes:
   *   - JsonStorage persists the WHOLE partition file, so with the journal OFF
   *     the batch collapses into ONE `save(allTasks)` write. With the journal
   *     ON the batch appends N journal lines in a single (fsynced) append and
   *     runs ONE compaction check for the whole batch.
   *   - GitYamlStorage persists ONE card file per task and commits the batch
   *     at most once.
   */
  async saveTasks(changed, allTasks, opts = {}) {
    // PERF-101: opts.syncDir === false marks a pure lease renewal (see writeAtomic).
    const durability = opts.syncDir === false ? { syncDir: false } : undefined;
    if (this._journalEnabled()) {
      await this._appendJournal(changed.map((task) => ({ op: 'upsert', id: task.id, task })), durability);
      await this._maybeCompact(allTasks);
      return;
    }
    await this.save(allTasks, durability);
  }

  async deleteTask(task, survivors) {
    if (this._journalEnabled()) {
      // A delete changes the partition set, so the base file is rewritten.
      // Nothing is journaled first (COR-103): if the rewrite fails the journal
      // is untouched, and if it succeeds its new generation supersedes every
      // earlier line, so no rejected removal can ever be replayed.
      await this._writeCanonical(survivors);
      try {
        await truncateDurable(this.journalFile);
      } catch (err) {
        console.warn(`[kanban JsonStorage] journal truncate deferred: ${err.message}`);
      }
      return;
    }
    await this.save(survivors);
  }

  async loadArchive() {
    try {
      if (!existsSync(this.archiveFile)) return [];
      const parsed = JSON.parse(await readFile(this.archiveFile, 'utf-8'));
       // §2.6: backfill version 1 on legacy archived JSON records.
      const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      backfillLeaseFields(list);
      return list;
    } catch (err) {
      console.warn(`[kanban JsonStorage] loadArchive error: ${err.message} — starting empty`);
      return [];
    }
  }

  async saveArchive(tasks) {
    const payload = {
      project: this.project || defaultProjectName(),
      archived_at: new Date().toISOString(),
      tasks,
    };
    await writeAtomic(this.archiveFile, JSON.stringify(payload)); // B1: compact
  }

  // v2.5.6: trash sink, mirroring the archive sibling. Deleted tasks land here
  // (stamped deleted_at/deleted_by) so an admin can restore or hard-purge them.
  get trashFile() {
    const dir = path.dirname(this.filePath);
    return path.join(dir, 'trash', `${this.project || defaultProjectName()}.json`);
  }

  async loadTrash() {
    try {
      if (!existsSync(this.trashFile)) return [];
      const parsed = JSON.parse(await readFile(this.trashFile, 'utf-8'));
      const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      backfillLeaseFields(list);
      return list;
    } catch (err) {
      console.warn(`[kanban JsonStorage] loadTrash error: ${err.message} — starting empty`);
      return [];
    }
  }

  async saveTrash(tasks) {
    const payload = {
      project: this.project || defaultProjectName(),
      updated_at: new Date().toISOString(),
      tasks,
    };
    await writeAtomic(this.trashFile, JSON.stringify(payload)); // B1: compact
  }

  async loadSettings() {
    try {
      if (!existsSync(this.settingsFile)) return {};
      const parsed = JSON.parse(await readFile(this.settingsFile, 'utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      console.warn(`[kanban JsonStorage] loadSettings error: ${err.message} — using defaults`);
      return {};
    }
  }

  async saveSettings(settings) {
    const payload = {
      project: this.project || defaultProjectName(),
      updated_at: new Date().toISOString(),
      ...settings,
    };
    await writeAtomic(this.settingsFile, JSON.stringify(payload, null, 2));
  }
}

export class GitYamlStorage {
  constructor(dirPath, options = {}) {
    this.dir = dirPath;
    this.root = options.rootPath || dirPath;
    // this.project is the owning project; undefined means "write flat at root"
    // (the legacy / default behaviour).
    this.project = options.project;
    this.autoCommit = options.autoCommit !== false;
  }

  get ownedProject() {
    return this.project || defaultProjectName();
  }

  get isDefaultProject() {
    return !this.project || this.project === defaultProjectName();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // COR-14: every git invocation that names a path passes `--` before the
  // path list, so a path can never be parsed as an option.
  _git(args, cwd) {
    return execFileAsync('git', args, { cwd });
  }

  // Traversal guard: the resolved path must remain inside the git root
  // (extended to the intermediate `<project>` directory level).
  _guard(filePath, task, label = '') {
    const targetDir = path.resolve(this.root);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in ${label}task id: ${task.id}`);
    }
  }

  _composite(id) {
    return this.isDefaultProject ? id : `${this.project}/${id}`;
  }

  // C7: capture a file's current state so a failed commit can put it back.
  async _snapshot(filePath) {
    try {
      return { filePath, existed: true, content: await readFile(filePath, 'utf-8') };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { filePath, existed: false, content: null };
      throw err;
    }
  }

  /**
   * C7: undo the working-tree side of a write whose commit failed — restore
   * each file's previous content, or remove a file the write created — and
   * re-stage those paths so a half-staged change cannot ride along with the
   * next unrelated commit. Best effort per file: the original commit error is
   * what the caller rethrows.
   */
  async _rollback(snaps) {
    for (const s of snaps) {
      try {
        if (s.existed) await writeAtomic(s.filePath, s.content);
        else await rm(s.filePath, { force: true });
      } catch (err) {
        console.error(`[kanban GitYamlStorage] rollback of ${s.filePath} failed: ${err.message}`);
      }
      if (this.autoCommit) {
        try {
          await this._git(['add', '-A', '--', path.basename(s.filePath)], path.dirname(s.filePath));
        } catch {
          // Path unknown to git (never staged) — nothing to unstage.
        }
      }
    }
  }

  _cardTarget(task) {
    if (!Number.isInteger(task.round) || task.round < 1) {
      throw new Error('Git-backed task persistence requires a positive integer round');
    }
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(this.dir, filename);
    this._guard(filePath, task);
    return { filename, filePath };
  }

  async _readCardDir(dir, label) {
    const entries = await readdir(dir);
    const files = entries.filter(
      (f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('.')
    );
    const tasks = [];
    for (const file of files) {
      try {
        const raw = await readFile(path.join(dir, file), 'utf-8');
        const parsed = yaml.parse(raw);
        if (parsed && parsed.id) {
          backfillLeaseFields([parsed]);
          tasks.push({ file, task: parsed });
        }
      } catch (err) {
        console.warn(`[kanban GitYamlStorage] ${label}${file}: ${err.message}`);
      }
    }
    return tasks;
  }

  async load() {
    let entries;
    try {
      await mkdir(this.dir, { recursive: true });
      entries = await this._readCardDir(this.dir, 'error reading ');
    } catch (err) {
      // BUG-01 (v2.5.2): a readdir/environmental failure is not "no data" —
      // fail closed rather than starting empty (the JSON backend's corrupt
      // file does not apply here: cards are independent files, and the
      // per-file loop above already warns + skips bad cards).
      console.error(
        `[kanban GitYamlStorage] cannot read card dir ${this.dir}: ${err.message} — refusing to start`
      );
      throw err;
    }
    const tasks = [];
    for (const { file, task } of entries) {
      if (await this._isArchivedLeftover(file, task)) continue;
      tasks.push(task);
    }
    // Deep-review: readdir order is filesystem order, which degrades the
    // array-index FIFO tiebreak in nextClaim on every restart. Sort by
    // created_at so boot order matches creation order.
    tasks.sort((a, b) => {
      const ta = Date.parse(a.created_at || '') || 0;
      const tb = Date.parse(b.created_at || '') || 0;
      return ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    return tasks;
  }

  /**
   * COR-10: before this fix, archiving with auto-commit off wrote the archive
   * card but left the live card in place, so it reloaded on every restart and
   * was archived again (duplicating it in the in-memory archive). A live card
   * whose archive twin is the same card (identical apart from `archived_at`)
   * is such a leftover: skip it, and with auto-commit off remove the stale file
   * (with auto-commit on the archive path always `git rm`s the live card, so a
   * twin there is left for the operator rather than silently deleted).
   * A re-created task that reuses an archived id differs in at least
   * `created_at`, so it is never mistaken for a leftover.
   */
  async _isArchivedLeftover(file, task) {
    const twinPath = path.join(this.root, 'archive', this.ownedProject, file);
    if (!existsSync(twinPath)) return false;
    try {
      const twin = yaml.parse(await readFile(twinPath, 'utf-8'));
      if (!twin || twin.id !== task.id || !twin.archived_at) return false;
      backfillLeaseFields([twin]);
      const strip = (c) => JSON.stringify({ ...c, archived_at: undefined });
      if (strip(twin) !== strip(task)) return false;
      if (!this.autoCommit) await rm(path.join(this.dir, file), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async loadArchive() {
    const archDir = path.join(this.root, 'archive', this.ownedProject);
    try {
      await mkdir(archDir, { recursive: true });
      const entries = await this._readCardDir(archDir, 'archive read ');
      // COR-10: deduplicate by id (e.g. both `<id>.yml` and `<id>.yaml`
      // present); the most recently archived copy wins.
      const byId = new Map();
      for (const { task } of entries) {
        const prev = byId.get(task.id);
        if (!prev || String(task.archived_at || '') >= String(prev.archived_at || '')) {
          byId.set(task.id, task);
        }
      }
      return [...byId.values()];
    } catch (err) {
      console.warn(`[kanban GitYamlStorage] loadArchive error: ${err.message}`);
      return [];
    }
  }

  async saveTask(task) {
    await mkdir(this.dir, { recursive: true });
    const { filename, filePath } = this._cardTarget(task);
    const ymlContent = yaml.stringify(this.serializeCard(task, task.status));
    // C7: remember the previous card so a failed commit leaves the working
    // tree exactly as it was (memory is not updated on a throw either).
    const snap = this.autoCommit ? await this._snapshot(filePath) : null;
    await writeAtomic(filePath, ymlContent);

    if (this.autoCommit) {
      try {
        await this._tryGitCommit(task, filename);
      } catch (err) {
        await this._rollback([snap]);
        throw err;
      }
    }
  }

  serializeCard(task, status) {
    const cardData = {
      id: task.id,
      project: this.ownedProject,
      title: task.title,
      status: task.status,
      // No fabrication: a branch is a *claim about a real git ref*, so an
      // absent value must round-trip as null rather than being invented here
      // (the notifier renders this field to a human). Blank/whitespace-only and
      // non-string values are treated as absent — see `toBranch`, the single
      // shared rule used by all three write paths.
      branch: toBranch(task.branch),
      milestone: toMilestone(task.milestone),
      depends_on: task.depends_on || [],
      round: task.round,
      issues: task.issues || [],
      assigned_agent: task.assigned_agent ?? null,
      stage_owners: task.stage_owners || {},
      created_at: task.created_at || task.updated || new Date().toISOString(),
      completed_at: task.completed_at,
      updated: task.updated || new Date().toISOString(),
      description: task.description || '',
      priority: task.priority || 'medium',
      agent_logs: task.agent_logs || [],
      comments: Array.isArray(task.comments) ? task.comments : [],
      metadata: task.metadata || {},
      // §2.6: persist the CAS version; default to 1 for legacy cards.
      version: task.version ?? 1,
      // §2.4: persist lease + reclaim observability so a git card round-trips
      // them; default to null/0 for legacy cards.
      claim_expires_at: task.claim_expires_at ?? null,
      claim_lease_ms: task.claim_lease_ms ?? null,
      last_progress_at: task.last_progress_at ?? null,
      reclaim_count: task.reclaim_count ?? 0,
    };
    if (task.archived_at) cardData.archived_at = task.archived_at;
    // Deep-review: keep soft-delete/restore provenance (was silently dropped,
    // which made git trash retention anchor on `updated` instead of
    // `deleted_at` and lost audit trail).
    if (task.deleted_at) cardData.deleted_at = task.deleted_at;
    if (task.deleted_by) cardData.deleted_by = task.deleted_by;
    if (task.restored_at) cardData.restored_at = task.restored_at;
    return cardData;
  }

  async saveArchiveTask(task) {
    const p = this.ownedProject;
    const archDir = path.join(this.root, 'archive', p);
    await mkdir(archDir, { recursive: true });
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(archDir, filename);
    this._guard(filePath, task, 'archive ');
    const livePath = path.resolve(this.dir, filename);
    this._guard(livePath, task, 'archive ');
    const archived = Object.assign({}, task, { archived_at: task.archived_at || new Date().toISOString() });
    const ymlContent = yaml.stringify(this.serializeCard(archived, STATUSES.DONE));

    // C7: snapshot both sides so a failed commit restores the live card and
    // the previous archive entry (or removes a newly created one).
    const snaps = this.autoCommit
      ? [await this._snapshot(filePath), await this._snapshot(livePath)]
      : null;
    await writeAtomic(filePath, ymlContent);

    if (!this.autoCommit) {
      // COR-10: the live card is removed whether or not commits are on; the
      // archive entry written above replaces it.
      await rm(livePath, { force: true });
      return;
    }

    try {
      if (existsSync(livePath)) {
        try {
          // git rm the live card if it is tracked; the archive entry replaces it.
          await this._git(['rm', '-f', '-q', '--ignore-unmatch', '--', filename], this.dir);
        } catch {
          // Index unavailable for the rm: fall through, the commit below
          // decides whether the archive move succeeds.
        }
        // An untracked live card is not touched by `git rm --ignore-unmatch`.
        await rm(livePath, { force: true });
      }
      const relativeArchive = path.join('archive', p, filename);
      await this._git(['add', '--', relativeArchive], this.root);
      const commitMsg = `ops(archive): ${this._composite(task.id)} DONE at ${archived.archived_at}`;
      await this._git(['commit', '-m', commitMsg], this.root);
    } catch (err) {
      await this._rollback(snaps);
      throw err;
    }
  }

  async save(tasks) {
    for (const task of tasks) {
      await this.saveTask(task);
    }
  }

  /**
   * True when `next` differs from the card currently on disk only in the
   * lease fields a renewal touches (`claim_expires_at`, `updated`). Both
   * sides are compared after a YAML round-trip so serialisation details
   * (dropped undefined keys, number/string forms) cannot cause a mismatch.
   * Any doubt (missing/unreadable card) answers false, which only means the
   * card is committed as before.
   */
  _isLeaseOnly(snap, nextYaml) {
    if (!snap || !snap.existed) return false;
    try {
      const prev = yaml.parse(snap.content);
      const next = yaml.parse(nextYaml);
      if (!prev || !next || prev.id !== next.id) return false;
      for (const c of [prev, next]) {
        delete c.claim_expires_at;
        delete c.updated;
      }
      return JSON.stringify(prev) === JSON.stringify(next);
    } catch {
      return false;
    }
  }

  /**
   * B1 (v3.12.3) — batched persist for grouped sibling lease renewals. The git
   * backend is per-card, so only the CHANGED tasks are written (`allTasks` is
   * ignored — rewriting every card in the bucket would be a write regression).
   *
   * PERF-02: the batch writes every card file first, then makes at most ONE
   * `git add` and ONE commit for the whole batch. Cards whose only change is
   * the lease renewal itself (`claim_expires_at` / `updated`) are written to
   * the working tree but not committed — a heartbeat is not history; the next
   * real change to the card commits the current lease along with it, and
   * loading reads the working tree, so restarts see the renewed lease.
   *
   * C7: if any write or the commit fails, every card in the batch is put back
   * to its previous content before the error propagates (the caller then
   * leaves memory unchanged, as before).
   */
  async saveTasks(changed, allTasks, opts = {}) {
    if (!changed || changed.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const plan = [];
    for (const task of changed) {
      const { filename, filePath } = this._cardTarget(task);
      const content = yaml.stringify(this.serializeCard(task, task.status));
      const snap = await this._snapshot(filePath);
      const leaseOnly = this.autoCommit && this._isLeaseOnly(snap, content);
      plan.push({ task, filename, filePath, content, snap, leaseOnly });
    }

    const written = [];
    let committing = false;
    try {
      for (const item of plan) {
        await writeAtomic(item.filePath, item.content, opts.syncDir === false ? { syncDir: false } : undefined);
        written.push(item.snap);
      }
      if (!this.autoCommit) return;
      const toCommit = plan.filter((item) => !item.leaseOnly);
      if (toCommit.length === 0) return;
      committing = true;
      await this._git(['add', '--', ...toCommit.map((item) => item.filename)], this.dir);
      const commitMsg = toCommit.length === 1
        ? `ops(${this._composite(toCommit[0].task.id)}): kanban ${toCommit[0].task.status}`
        : `ops(${this.ownedProject}): kanban batch update (${toCommit.length} cards: ${toCommit.map((i) => i.task.id).join(', ')})`;
      await this._git(['commit', '-m', commitMsg], this.dir);
    } catch (err) {
      await this._rollback(written);
      if (committing) {
        throw new Error(`Git-backed persistence commit failed: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }

  // v2.5.6: trash sink for the git backend. Cards are parked as plain YAML
  // under <root>/trash/<project>/ (NOT git-tracked — the trash is an operator
  // safety net, not history); restore re-writes the live card via saveTask,
  // which resumes normal git commits.
  //
  // Batch 3: an id can be deleted, re-created and deleted again, so the trash
  // can hold two rows with the same id. Files are keyed by id AND deletion
  // time (`<id>.<deletedAtSafe>.yml`) so those rows no longer overwrite each
  // other on disk. Ids cannot contain '.', so the name is unambiguous. Files
  // written by earlier releases (`<id>.yml`) still load and are removed by
  // matching their recorded `deleted_at`.
  static trashStamp(deletedAt) {
    return String(deletedAt || '').replace(/[^0-9A-Za-z]/g, '');
  }

  _trashDir() {
    return path.join(this.root, 'trash', this.ownedProject);
  }

  _trashPath(task, deletedAt) {
    const stamp = GitYamlStorage.trashStamp(deletedAt);
    const filename = stamp ? `${task.id}.${stamp}.yml` : `${task.id}.yml`;
    const filePath = path.resolve(this._trashDir(), filename);
    this._guard(filePath, task, 'trash ');
    return filePath;
  }

  async trashTask(task) {
    await mkdir(this._trashDir(), { recursive: true });
    const filename = `${task.id}.yml`;
    const trashed = Object.assign({}, task, {
      deleted_at: task.deleted_at || new Date().toISOString(),
    });
    const filePath = this._trashPath(task, trashed.deleted_at);
    await writeAtomic(filePath, yaml.stringify(this.serializeCard(trashed, task.status)));
    const livePath = path.join(this.dir, filename);
    if (!existsSync(livePath)) return;
    if (!this.autoCommit) {
      await rm(livePath, { force: true });
      return;
    }
    // COR-107: commit the removal like every other git mutation, so history
    // and clones agree with the board. An untracked card has nothing to commit.
    const snap = await this._snapshot(livePath);
    try {
      const tracked = (await this._git(['ls-files', '--', filename], this.dir)).stdout.trim() !== '';
      await this._git(['rm', '-f', '-q', '--ignore-unmatch', '--', filename], this.dir);
      await rm(livePath, { force: true });
      if (tracked) {
        await this._git(['commit', '-m', `ops(${this._composite(task.id)}): kanban trashed`], this.root);
      }
    } catch (err) {
      await this._rollback([snap]);
      await rm(filePath, { force: true });
      throw err;
    }
  }

  async loadTrash() {
    try {
      // Both `<id>.<stamp>.yml` and legacy `<id>.yml` names load; the row's
      // identity comes from the card content.
      return (await this._readCardDir(this._trashDir(), 'trash read ')).map((e) => e.task);
    } catch {
      return []; // absent trash dir is the normal first-boot case
    }
  }

  /** Removes exactly the trash file of this row (same id AND deleted_at). */
  async trashRemove(task) {
    if (task.deleted_at) await rm(this._trashPath(task, task.deleted_at), { force: true });
    // Legacy `<id>.yml`: remove it only when it is this row.
    const legacy = this._trashPath(task, null);
    if (!existsSync(legacy)) return;
    try {
      const parsed = yaml.parse(await readFile(legacy, 'utf-8'));
      if (!parsed || parsed.id !== task.id) return;
      if (String(parsed.deleted_at || '') !== String(task.deleted_at || '')) return;
    } catch {
      return; // unreadable: leave it for the operator
    }
    await rm(legacy, { force: true });
  }

  async deleteTask(task) {
    await mkdir(this.dir, { recursive: true });
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(this.dir, filename);
    // Traversal guard, mirroring saveTask/saveArchiveTask.
    this._guard(filePath, task);
    if (!existsSync(filePath)) return;
    if (!this.autoCommit) {
      // Commits off: a plain unlink (the directory need not be a git repo).
      await rm(filePath, { force: true });
      return;
    }
    // C7: keep the card so a failed commit can put it back.
    const snap = await this._snapshot(filePath);
    try {
      await this._git(['rm', '-f', '-q', '--ignore-unmatch', '--', filename], this.dir);
      // An untracked card is not touched by `git rm --ignore-unmatch`.
      await rm(filePath, { force: true });
      const commitMsg = `ops(${this._composite(task.id)}): kanban deleted`;
      await this._git(['commit', '-m', commitMsg], this.root);
    } catch (err) {
      await this._rollback([snap]);
      throw err;
    }
  }

  async _tryGitCommit(task, filename) {
    try {
      await this._git(['add', '--', filename], this.dir);
      const commitMsg = `ops(${this._composite(task.id)}): kanban ${task.status}`;
      await this._git(['commit', '-m', commitMsg], this.dir);
    } catch (err) {
      throw new Error(`Git-backed persistence commit failed: ${err.message}`, { cause: err });
    }
  }

  // v2.5.0: per-project display settings live in a `settings.yml` sibling of the
  // task cards. The file carries no `id` key, so the card loader (which skips
  // every parsed file without one) ignores it harmlessly.
  settingsPath() {
    return path.join(this.dir, 'settings.yml');
  }

  async loadSettings() {
    try {
      const raw = await readFile(this.settingsPath(), 'utf-8');
      const parsed = yaml.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async saveSettings(settings) {
    await mkdir(this.dir, { recursive: true });
    const payload = {
      project: this.ownedProject,
      updated_at: new Date().toISOString(),
      ...settings,
    };
    const snap = this.autoCommit ? await this._snapshot(this.settingsPath()) : null;
    await writeAtomic(this.settingsPath(), yaml.stringify(payload));
    if (this.autoCommit) {
      try {
        await this._git(['add', '--', 'settings.yml'], this.dir);
        const composite = this.isDefaultProject ? 'default' : this.ownedProject;
        await this._git(['commit', '-m', `ops(${composite}): kanban settings updated`], this.dir);
      } catch (err) {
        await this._rollback([snap]);
        throw new Error(`Git-backed settings commit failed: ${err.message}`, { cause: err });
      }
    }
  }
}
