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
import { readFile, writeFile, rename, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'yaml';
import {
  writeAtomic,
  toBranch,
  toMilestone,
  defaultProjectName,
  jsonDataDir,
  backfillLeaseFields,
} from './task-identity.js';
import { STATUSES } from './state-machine.js';

const execFileAsync = promisify(execFile);

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

  async load() {
    if (!existsSync(this.filePath)) {
      // PERF-02: absent base file but journal may have entries (first boot
      // with journaling ON — saveTask only appends to the journal until
      // compaction). Replay the journal over an empty list.
      if (this._journalEnabled() && existsSync(this.journalFile)) {
        const list = [];
        await this._replayJournal(list);
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
      // PERF-02: replay the journal over the base file if journaling is enabled.
      if (this._journalEnabled() && existsSync(this.journalFile)) {
        await this._replayJournal(list);
      }
      return list;
    } catch (err) {
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

  /**
   * PERF-02 — replay the append-only journal over the base task list.
   * Each journal line is `{op:'upsert'|'remove', id, task?}`. An `upsert`
   * replaces or appends the task by id; a `remove` drops it. After replay,
   * if the journal exceeds the compact threshold, compact it into the base
   * file and truncate the journal.
   */
  async _replayJournal(baseList) {
    const journalRaw = await readFile(this.journalFile, 'utf-8');
    const lines = journalRaw.split('\n').filter((l) => l.trim());
    const byId = new Map(baseList.map((t) => [t.id, t]));
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.op === 'upsert' && entry.task) {
          byId.set(entry.task.id, entry.task);
        } else if (entry.op === 'remove' && entry.id) {
          byId.delete(entry.id);
        }
      } catch (err) {
        console.warn(`[kanban JsonStorage] journal replay skip bad line: ${err.message}`);
      }
    }
    const replayed = [...byId.values()];
    backfillLeaseFields(replayed);

    // Compact if the journal is large: write the replayed list to the base
    // file (writeAtomic) and truncate the journal. This keeps the journal
    // bounded while the base file stays the canonical source.
    const journalBytes = Buffer.byteLength(journalRaw, 'utf8');
    if (journalBytes >= this._journalCompactBytes()) {
      await this._writeCanonical(replayed);
      await writeFile(this.journalFile, '', 'utf-8');
    }
    // Mutate baseList in place so the caller sees the replayed state.
    baseList.length = 0;
    for (const t of replayed) baseList.push(t);
  }

  /**
   * Writes the canonical base file (the full `{tasks:[...]}` or
   * `{project, tasks:[...]}` shape). Used by both `save()` and journal
   * compaction so the on-disk format stays byte-compatible.
   */
  async _writeCanonical(tasks) {
    const payload = this.isDefault
      ? { tasks }
      : { project: this.project, tasks };
    await writeAtomic(this.filePath, JSON.stringify(payload, null, 2));
  }

  async save(tasks) {
    // PERF-02: when journaling is ON, `save` is a full canonical rewrite
    // (used by archive sweep / delete / purge — the partition must reflect the
    // surviving set). The journal is truncated because the base file is now
    // authoritative for the full set.
    if (this._journalEnabled()) {
      await this._writeCanonical(tasks);
      await writeFile(this.journalFile, '', 'utf-8');
      return;
    }
    // Default project keeps the legacy `{ tasks: [...] }` shape so an existing
    // single-project file is byte-for-byte compatible. Named partitions embed
    // the project name so the partition is self-describing.
    const payload = this.isDefault
      ? { tasks }
      : { project: this.project, tasks };
    await writeAtomic(this.filePath, JSON.stringify(payload, null, 2));
  }

  /**
   * PERF-02 — single-task save with an append-only journal fast path.
   * When the journal is enabled, append one JSON line `{op:'upsert', task}`
   * instead of rewriting the entire partition file. This reduces write
   * amplification from O(partition) to O(1) per mutation. The journal is
   * replayed on `load()` and compacted when it exceeds the threshold.
   *
   * With the journal OFF (default), this delegates to the original
   * whole-partition rewrite — byte-identical to the pre-2.8 behavior.
   */
  async saveTask(task, allTasks) {
    if (this._journalEnabled()) {
      const entry = JSON.stringify({ op: 'upsert', id: task.id, task }) + '\n';
      await mkdir(path.dirname(this.journalFile), { recursive: true });
      await writeFile(this.journalFile, entry, { encoding: 'utf-8', flag: 'a' });
      // Compact if the journal has grown past the threshold.
      if (existsSync(this.journalFile)) {
        const stat = await import('node:fs/promises').then((m) => m.stat);
        try {
          const st = await stat(this.journalFile);
          if (st.size >= this._journalCompactBytes()) {
            // Compact: write the full partition and truncate the journal.
            await this._writeCanonical(allTasks);
            await writeFile(this.journalFile, '', 'utf-8');
          }
        } catch {
          // stat failure: fall through — the journal is advisory, not authoritative.
        }
      }
      return;
    }
    await this.save(allTasks);
  }

  async deleteTask(task, survivors) {
    if (this._journalEnabled()) {
      // Record the removal in the journal, then rewrite the canonical file
      // (a delete changes the partition set, so the base file must reflect it).
      const entry = JSON.stringify({ op: 'remove', id: task.id }) + '\n';
      await mkdir(path.dirname(this.journalFile), { recursive: true });
      await writeFile(this.journalFile, entry, { encoding: 'utf-8', flag: 'a' });
      await this._writeCanonical(survivors);
      await writeFile(this.journalFile, '', 'utf-8');
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
    await writeAtomic(this.archiveFile, JSON.stringify(payload, null, 2));
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
    await writeAtomic(this.trashFile, JSON.stringify(payload, null, 2));
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

  async load() {
    try {
      await mkdir(this.dir, { recursive: true });
      const entries = await readdir(this.dir);
      const yamlFiles = entries.filter(
        (f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('.')
      );

      const tasks = [];
      for (const file of yamlFiles) {
        try {
          const raw = await readFile(path.join(this.dir, file), 'utf-8');
          const parsed = yaml.parse(raw);
          if (parsed && parsed.id) {
            backfillLeaseFields([parsed]);
            tasks.push(parsed);
           }
        } catch (err) {
          console.warn(`[kanban GitYamlStorage] error reading ${file}: ${err.message}`);
        }
      }
      return tasks;
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
  }

  async loadArchive() {
    const archDir = path.join(this.root, 'archive', this.ownedProject);
    try {
      await mkdir(archDir, { recursive: true });
      const entries = await readdir(archDir);
      const files = entries.filter(
        (f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('.')
      );
      const tasks = [];
      for (const file of files) {
        try {
          const raw = await readFile(path.join(archDir, file), 'utf-8');
          const parsed = yaml.parse(raw);
          if (parsed && parsed.id) {
            backfillLeaseFields([parsed]);
            tasks.push(parsed);
            }
         } catch (err) {
          console.warn(`[kanban GitYamlStorage] archive read ${file}: ${err.message}`);
         }
       }
      return tasks;
     } catch (err) {
      console.warn(`[kanban GitYamlStorage] loadArchive error: ${err.message}`);
      return [];
     }
   }

  async saveTask(task) {
    await mkdir(this.dir, { recursive: true });
    if (!Number.isInteger(task.round) || task.round < 1) {
      throw new Error('Git-backed task persistence requires a positive integer round');
    }
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(this.dir, filename);
    // Traversal guard, extended to the intermediate `<project>` directory level:
    // the resolved path must remain inside the git root.
    const targetDir = path.resolve(this.root);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in task id: ${task.id}`);
    }

    const status = task.status;
    const cardData = this.serializeCard(task, status);
    const ymlContent = yaml.stringify(cardData);
    await writeAtomic(filePath, ymlContent);

    if (this.autoCommit) {
      await this._tryGitCommit(task, filename);
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
    return cardData;
  }

  async saveArchiveTask(task) {
    const p = this.ownedProject;
    const archDir = path.join(this.root, 'archive', p);
    await mkdir(archDir, { recursive: true });
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(archDir, filename);
    const targetDir = path.resolve(this.root);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in archive task id: ${task.id}`);
    }
    const archived = Object.assign({}, task, { archived_at: task.archived_at || new Date().toISOString() });
    const ymlContent = yaml.stringify(this.serializeCard(archived, STATUSES.DONE));
    await writeAtomic(filePath, ymlContent);

    if (this.autoCommit) {
      // git rm the live card if it is tracked; the archive entry replaces it.
      try {
        if (existsSync(path.join(this.dir, filename))) {
          await execFileAsync('git', ['rm', '-f', '--ignore-unmatch', filename], { cwd: this.dir });
        }
      } catch {
        // Untracked / already removed: ignore, the archive write is authoritative.
      }
      const relativeArchive = path.join('archive', p, filename);
      await execFileAsync('git', ['add', relativeArchive], { cwd: this.root });
      const composite = this.isDefaultProject ? task.id : `${this.project}/${task.id}`;
      const commitMsg = `ops(archive): ${composite} DONE at ${archived.archived_at}`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: this.root });
    }
  }

  async save(tasks) {
    for (const task of tasks) {
      await this.saveTask(task);
    }
  }

  // v2.5.6: trash sink for the git backend. Cards are parked as plain YAML
  // under <root>/trash/<project>/ (NOT git-tracked — the trash is an operator
  // safety net, not history); restore re-writes the live card via saveTask,
  // which resumes normal git commits.
  async trashTask(task) {
    const p = this.ownedProject;
    const trashDir = path.join(this.root, 'trash', p);
    await mkdir(trashDir, { recursive: true });
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(trashDir, filename);
    const targetDir = path.resolve(this.root);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in trash task id: ${task.id}`);
    }
    const trashed = Object.assign({}, task, {
      deleted_at: task.deleted_at || new Date().toISOString(),
    });
    await writeAtomic(filePath, yaml.stringify(this.serializeCard(trashed, task.status)));
    // Remove the live card file (untracked removal — no commit; the trash
    // write is authoritative and git status stays clean).
    if (existsSync(path.join(this.dir, filename))) {
      await rm(path.join(this.dir, filename), { force: true });
    }
  }

  async loadTrash() {
    const trashDir = path.join(this.root, 'trash', this.ownedProject);
    try {
      const entries = await readdir(trashDir);
      const files = entries.filter(
        (f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('.')
      );
      const tasks = [];
      for (const file of files) {
        try {
          const raw = await readFile(path.join(trashDir, file), 'utf-8');
          const parsed = yaml.parse(raw);
          if (parsed && parsed.id) {
            backfillLeaseFields([parsed]);
            tasks.push(parsed);
          }
        } catch (err) {
          console.warn(`[kanban GitYamlStorage] trash read ${file}: ${err.message}`);
        }
      }
      return tasks;
    } catch (err) {
      return []; // absent trash dir is the normal first-boot case
    }
  }

  async trashRemove(task) {
    const p = this.ownedProject;
    const filename = `${task.id}.yml`;
    const trashDir = path.join(this.root, 'trash', p);
    const trashPath = path.resolve(trashDir, filename);
    const targetDir = path.resolve(this.root);
    if (!trashPath.startsWith(targetDir + path.sep) && trashPath !== targetDir) {
      throw new Error(`Path traversal attempt detected in trash task id: ${task.id}`);
    }
    await rm(trashPath, { force: true });
  }

  async deleteTask(task) {
    await mkdir(this.dir, { recursive: true });
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(this.dir, filename);
    // Traversal guard, mirroring saveTask/saveArchiveTask: the resolved path
    // must remain inside the git root.
    const targetDir = path.resolve(this.root);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in task id: ${task.id}`);
    }
    if (existsSync(filePath)) {
      await execFileAsync('git', ['rm', '-f', '--ignore-unmatch', filename], { cwd: this.dir });
    }
    if (this.autoCommit) {
      const composite = this.isDefaultProject ? task.id : `${this.project}/${task.id}`;
      const commitMsg = `ops(${composite}): kanban deleted`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: this.root });
    }
  }

  async _tryGitCommit(task, filename) {
    try {
      await execFileAsync('git', ['add', filename], { cwd: this.dir });
      const composite = this.isDefaultProject ? task.id : `${this.project}/${task.id}`;
      const commitMsg = `ops(${composite}): kanban ${task.status}`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: this.dir });
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
    await writeAtomic(this.settingsPath(), yaml.stringify(payload));
    if (this.autoCommit) {
      try {
        await execFileAsync('git', ['add', 'settings.yml'], { cwd: this.dir });
        const composite = this.isDefaultProject ? 'default' : this.ownedProject;
        await execFileAsync(
          'git',
          ['commit', '-m', `ops(${composite}): kanban settings updated`],
          { cwd: this.dir }
        );
      } catch (err) {
        throw new Error(`Git-backed settings commit failed: ${err.message}`, { cause: err });
      }
    }
  }
}