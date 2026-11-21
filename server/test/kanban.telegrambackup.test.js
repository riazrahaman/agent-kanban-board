import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  telegramBackupConfig,
  msUntilNextRun,
  stampInZone,
  runTelegramBackupNow,
  startTelegramBackup,
  stopTelegramBackup,
  MARKER_FILE,
  MAX_UPLOAD_BYTES,
} from '../telegramBackup.js';

const KEYS = [
  'KANBAN_TELEGRAM_BACKUP_ENABLED', 'KANBAN_TELEGRAM_BACKUP_HOUR', 'KANBAN_TELEGRAM_BACKUP_TZ',
  'KANBAN_TELEGRAM_BOT_TOKEN', 'KANBAN_TELEGRAM_CHAT_ID', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE',
];

describe('telegram daily backup (v3.17.0)', () => {
  let saved;
  let dir;
  beforeEach(async () => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    dir = await mkdtemp(path.join(tmpdir(), 'kanban-tgb-test-'));
    process.env.KANBAN_DATA_DIR = dir;
    process.env.KANBAN_DATA_FILE = path.join(dir, 'tasks.json');
    process.env.KANBAN_TELEGRAM_BOT_TOKEN = '123:SECRET-TOKEN';
    process.env.KANBAN_TELEGRAM_CHAT_ID = '42';
    process.env.KANBAN_TELEGRAM_BACKUP_ENABLED = '1';
    delete process.env.KANBAN_TELEGRAM_BACKUP_HOUR;
    delete process.env.KANBAN_TELEGRAM_BACKUP_TZ;
  });
  afterEach(async () => {
    stopTelegramBackup();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  test('config defaults to 03:00 Asia/Dubai and needs flag + token + chat', () => {
    const c = telegramBackupConfig();
    assert.equal(c.enabled, true);
    assert.equal(c.hour, 3);
    assert.equal(c.timeZone, 'Asia/Dubai');
    process.env.KANBAN_TELEGRAM_BACKUP_ENABLED = '0';
    assert.equal(telegramBackupConfig().enabled, false);
    process.env.KANBAN_TELEGRAM_BACKUP_ENABLED = '1';
    delete process.env.KANBAN_TELEGRAM_CHAT_ID;
    assert.equal(telegramBackupConfig().enabled, false);
  });

  test('config falls back on an invalid hour or time zone', () => {
    process.env.KANBAN_TELEGRAM_BACKUP_HOUR = '99';
    process.env.KANBAN_TELEGRAM_BACKUP_TZ = 'Not/AZone';
    const c = telegramBackupConfig();
    assert.equal(c.hour, 3);
    assert.equal(c.timeZone, 'Asia/Dubai');
  });

  test('03:00 Abu Dhabi time is 23:00 UTC the previous day', () => {
    const H = 3600000;
    assert.equal(msUntilNextRun(new Date('2026-11-21T12:00:00Z'), 3, 'Asia/Dubai'), 11 * H);
    assert.equal(msUntilNextRun(new Date('2026-11-21T22:59:00Z'), 3, 'Asia/Dubai'), 60000);
    // exactly on the hour -> next day, never 0
    assert.equal(msUntilNextRun(new Date('2026-11-21T23:00:00Z'), 3, 'Asia/Dubai'), 24 * H);
    assert.equal(stampInZone(new Date('2026-11-21T23:00:00Z'), 'Asia/Dubai').clock, '03:00');
  });

  test('sends a tar.gz via sendDocument to the chat, with every file in the snapshot', async () => {
    await mkdir(path.join(dir, 'tasks'), { recursive: true });
    await writeFile(path.join(dir, 'tasks', 'p.json'), JSON.stringify({ secret_field: 'keep-me' }));
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    };
    const res = await runTelegramBackupNow({ fetchImpl, now: () => new Date('2026-11-21T23:00:00Z') });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.filename, 'kanban-backup-2026-11-22-0300.tar.gz');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/bot123:SECRET-TOKEN\/sendDocument$/);
    const form = calls[0].init.body;
    assert.equal(form.get('chat_id'), '42');
    assert.match(form.get('caption'), /2026-11-22 03:00 \(Asia\/Dubai\)/);
    const doc = form.get('document');
    assert.equal(doc.name, res.filename);
    assert.ok(doc.size > 0);
    // marker written, so a restart will not re-send within 24 h
    const marker = await readFile(path.join(dir, 'backups', MARKER_FILE), 'utf-8');
    assert.equal(marker.trim(), '2026-11-21T23:00:00.000Z');
  });

  test('archive really contains the data (nothing stripped)', async () => {
    await mkdir(path.join(dir, 'tasks'), { recursive: true });
    await writeFile(path.join(dir, 'tasks', 'p.json'), '{"title":"UNSTRIPPED"}');
    let bytes;
    const fetchImpl = async (_u, init) => {
      bytes = Buffer.from(await init.body.get('document').arrayBuffer());
      return { ok: true, status: 200 };
    };
    const res = await runTelegramBackupNow({ fetchImpl });
    assert.equal(res.ok, true, res.error);
    const { gunzipSync } = await import('node:zlib');
    const tar = gunzipSync(bytes).toString('latin1');
    assert.match(tar, /tasks\/p\.json/);
    assert.match(tar, /UNSTRIPPED/);
    assert.match(tar, /backup-manifest\.json/);
  });

  test('a failed send retries, then alerts by text, scrubs the token and writes no marker', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith('/sendDocument')) throw new Error('boom 123:SECRET-TOKEN');
      return { ok: true, status: 200 };
    };
    const res = await runTelegramBackupNow({ fetchImpl, sleep: async () => {} });
    assert.equal(res.ok, false);
    assert.ok(!res.error.includes('SECRET-TOKEN'));
    assert.equal(calls.filter((u) => u.endsWith('/sendDocument')).length, 3);
    assert.equal(calls.filter((u) => u.endsWith('/sendMessage')).length, 1);
    await assert.rejects(stat(path.join(dir, 'backups', MARKER_FILE)));
  });

  test('an archive over the Telegram limit is refused with a text alert', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
    const pack = async (_dir, out) => {
      const { open } = await import('node:fs/promises');
      const h = await open(out, 'w');
      await h.truncate(MAX_UPLOAD_BYTES + 1);
      await h.close();
    };
    const res = await runTelegramBackupNow({ fetchImpl, pack });
    assert.equal(res.ok, false);
    assert.match(res.error, /over the Telegram upload limit/);
    assert.deepEqual(calls.map((u) => u.split('/').pop()), ['sendMessage']);
  });

  test('disabled -> inert: no timer, no network', async () => {
    process.env.KANBAN_TELEGRAM_BACKUP_ENABLED = '0';
    assert.equal(startTelegramBackup(), null);
    const res = await runTelegramBackupNow({ fetchImpl: async () => { throw new Error('no network'); } });
    assert.deepEqual(res, { ok: false, error: 'disabled' });
  });

  test('start schedules an unref-ed timer and stop clears it', () => {
    const t = startTelegramBackup();
    assert.ok(t);
    assert.equal(t.hasRef(), false);
    assert.equal(stopTelegramBackup(), true);
    assert.equal(stopTelegramBackup(), false);
  });
});
