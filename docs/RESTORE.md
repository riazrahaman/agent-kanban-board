# Restore Runbook

How to recover the board's data from a snapshot if the live data is lost or corrupted.

## How backups work

When `KANBAN_BACKUP_ENABLED` is set (and not `false`/`0`), the server copies its
data directory into a sibling `backups/` folder every
`KANBAN_BACKUP_INTERVAL_MS` (default 600000 = 10 min) and keeps the newest
`KANBAN_BACKUP_KEEP` (default 10) snapshots, named
`YYYY-MM-DDTHH-MM-SS-mmmZ`. The live status is exposed on
`GET /api/health` under `backup`:

```json
{
  "backup": {
    "enabled": true,
    "running": true,
    "interval_ms": 600000,
    "keep": 10,
    "backup_root": "/data/backups",
    "backup_count": 10,
    "last_backup_at": "2026-09-24T18:10:00.123Z"
  }
}
```

**Important:** these snapshots live on the SAME volume as the live data. They
protect against corruption and bad writes, not against volume loss. For
volume-loss protection, copy snapshots off the volume on a schedule (step 3
below).

## Deploy configuration

- **Render** (`render.yaml`): `KANBAN_BACKUP_ENABLED=1`,
  `KANBAN_BACKUP_INTERVAL_MS=600000`, `KANBAN_BACKUP_KEEP=10` are set on the
  web service — snapshots land in `/data/backups`.
- **Railway**: `railway.json` cannot declare environment variables, so set the
  same three variables in the dashboard (Service → Variables) yourself.

## Restore procedure

1. **Stop the service** (Railway dashboard → the service → Restart is *not*
   enough; the restore copies over the live tree, so pause traffic first).

2. **Verify the snapshot** you intend to restore:
   `GET /api/health` → confirm `backup.backup_count >= 1` and
   `backup.last_backup_at` is recent. Snapshot directories look like
   `/data/backups/2026-09-24T18-10-00-123Z/` and contain either a
   `tasks.json` (default project) or a non-empty `tasks/` directory (named
   projects) plus `archive/`.

3. **Copy the snapshot off the volume** (nightly, e.g. via cron / Railway
   cron service):

   ```bash
   # example: tar the newest snapshot to object storage or another host
   LATEST=$(ls -1d /data/backups/* | sort | tail -1)
   tar -czf "/tmp/kanban-backup-$(date +%Y%m%d).tgz" -C "$LATEST" .
   # then push /tmp/kanban-backup-*.tgz to S3 / R2 / another machine
   ```

4. **Restore** (from a host that has the snapshot and the volume mounted):

   ```bash
   node scripts/restore-backup.mjs /data/backups/2026-09-24T18-10-00-123Z --into /data
   ```

   Add `--dry-run` to list what would be copied without writing. The script
   refuses to restore from an empty or missing snapshot.

5. **Restart the service** and verify recovery:

   ```bash
   curl -s https://<your-board>/api/health
   ```

   `status` should be `ok`, `store_loaded` true, `tasks_total` matching the
   snapshot's task count, and `backup.last_backup_at` advancing on the next
   interval.

## Drill

Run a restore drill on a schedule (e.g. quarterly and after any storage-format
change): restore the newest snapshot into a scratch directory against a local
instance, then diff `GET /api/tasks` output against a pre-drill capture. Record
the drill date in this file.

- Latest drill: 2026-09-24 (v2.5.5 — `restore-backup.mjs` dry-run verified
  against a seeded fixture; full-volume drill pending first production backup
  rotation).