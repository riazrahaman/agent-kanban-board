/**
 * §2.10 (v3.9.5) — deploy-drift monitor.
 *
 * Answers one question, out loud: is the version this process is RUNNING the
 * version the project last RELEASED? A Railway service with `checkSuites: true`
 * does not fail a deploy when CI is red — it SKIPS it, and the board keeps
 * serving the previous build with a healthy `/api/health`. That is a silent
 * failure mode: nothing is broken, so nothing alerts, and the fix (re-run the
 * deployment) is invisible unless someone compares two version strings.
 *
 * Design constraints, all deliberate:
 *   - OFF is impossible; DISABLING is possible. One check runs shortly after
 *     boot, then every KANBAN_DEPLOY_DRIFT_INTERVAL_MS (default 30 min; ≤ 0
 *     disables the monitor entirely, in which case `status` stays `unknown`
 *     with a null `checked_at` and the client chip stays hidden).
 *   - NEVER throws. Any fetch/parse failure is `unknown` — GitHub being
 *     unreachable says nothing about this deployment's health.
 *   - NO new secret and no GitHub token. `releases/latest` and `tags` are
 *     public reads; the only credentials it uses are the Telegram pair the
 *     notifier already owns, and if either is unset it stays silent.
 *   - GRACE. A release tag appears on GitHub the moment it is cut, minutes
 *     before the redeploy lands. Reporting drift in that window would alert on
 *     every single good deploy, so a mismatch only becomes `drift` once it has
 *     persisted longer than KANBAN_DEPLOY_DRIFT_GRACE_MS (default 45 min).
 *   - The timer is unref()'d and started ONLY from `startServer`, never from
 *     `createApp`, so the HTTP-contract tests never make a network call.
 *
 * v3.12.7 - drift means BEHIND, and only behind. Two corrections to the
 * original comparison:
 *
 *   - SEMVER, not string equality (server/semver.js). A build that is AHEAD of
 *     the newest release is `in_sync`: nothing is missing, the release just has
 *     not been published. Only `running < latest` can ever become `drift`.
 *   - TAGS fallback. This repo historically cut git tags without GitHub
 *     Releases, so `releases/latest` sat at v3.10.5 while the board ran 3.12.x
 *     and every check after the grace window reported a "skipped" deploy. When
 *     the release feed 404s/403s/throws, or its tag is older than the highest
 *     tag on `/tags`, the monitor now reads the tags endpoint and compares
 *     against the highest semver tag there. `source` records which feed won so
 *     an operator can tell a release-based verdict from a tags-based one.
 *
 * Everything the monitor decides is in the pure `evaluateDrift()` helper, which
 * takes an explicit clock — the tests drive it without network or timers.
 */

// C4 (v3.12.5): the deployed version comes from the one shared helper.
import { APP_VERSION } from './version.js';
import { compareSemver, parseSemver, pickHighestTag } from './semver.js';

export const DEFAULT_API_URL =
  'https://api.github.com/repos/riazrahaman/agent-kanban-board/releases/latest';
// The same repo's tag list, used when `releases/latest` is missing or stale
// (see the header). Public read; no credential.
export const DEFAULT_TAGS_API_URL =
  'https://api.github.com/repos/riazrahaman/agent-kanban-board/tags?per_page=100';
export const DEFAULT_INTERVAL_MS = 1800000; // 30 min
export const DEFAULT_GRACE_MS = 2700000; // 45 min
export const DEFAULT_BOARD_URL = 'https://agent-kanban.riazrahaman.com';
const FETCH_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 5000;
// "Once shortly after boot": late enough that the deploy's own healthcheck has
// settled, early enough to be in the first log scroll.
const BOOT_CHECK_DELAY_MS = 5000;

// ============================================================================
// Config — read at call time, matching the reaper/backup/notifier convention.
// ============================================================================

function envInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * Resolve monitor configuration from `process.env` at call time.
 *
 * `intervalMs <= 0` disables the timer (the endpoint keeps reporting `unknown`
 * with `checked_at: null`, which the client treats as "no check configured" and
 * hides). `graceMs` is a floor of 0 so a test/deployment may opt into
 * "report the mismatch immediately".
 *
 * `tagsApiUrl` defaults to the tags endpoint of the SAME repo the release feed
 * points at (see `deriveTagsApiUrl`), so pointing the monitor at a fork needs
 * one env var, not two.
 */
export function deployDriftConfig() {
  const apiUrl = String(process.env.KANBAN_DEPLOY_DRIFT_API_URL || '').trim() || DEFAULT_API_URL;
  return {
    intervalMs: envInt(process.env.KANBAN_DEPLOY_DRIFT_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    graceMs: Math.max(0, envInt(process.env.KANBAN_DEPLOY_DRIFT_GRACE_MS, DEFAULT_GRACE_MS)),
    apiUrl,
    tagsApiUrl:
      String(process.env.KANBAN_DEPLOY_DRIFT_TAGS_API_URL || '').trim() ||
      deriveTagsApiUrl(apiUrl),
  };
}

/**
 * Map a `.../releases/latest` URL to the tag list of the same repository.
 *
 * The tag endpoint is the fallback feed, so it must follow a custom
 * `KANBAN_DEPLOY_DRIFT_API_URL` (a fork) rather than silently reading this
 * repo's tags. A URL that is not shaped like a release feed keeps the default
 * endpoint, which the env var can override explicitly.
 */
export function deriveTagsApiUrl(releaseUrl) {
  const trimmed = typeof releaseUrl === 'string' ? releaseUrl.trim().replace(/\/+$/, '') : '';
  const suffix = '/releases/latest';
  if (trimmed.endsWith(suffix)) {
    return `${trimmed.slice(0, -suffix.length)}/tags?per_page=100`;
  }
  return DEFAULT_TAGS_API_URL;
}

/** `v3.9.5` and `3.9.5` are the same release; compare the bare triple. */
export function normalizeTag(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, '');
}

// ============================================================================
// The decision — pure, no network, no clock of its own
// ============================================================================

/**
 * Decide the drift status from two version strings and a clock.
 *
 * Returns `{ status, reason, drift_since }` where `status` is one of
 * `'in_sync' | 'drift' | 'unknown'`, `reason` is a short machine-readable word
 * for the verdict (also surfaced in the health snapshot) and `drift_since` is
 * epoch milliseconds (the first observation of the current mismatch) or null.
 *
 * Semver rules (v3.12.7):
 *   - running < latest  -> `behind`; `drift` once the grace window has passed,
 *     `in_sync` before that (the release is simply newer than the deploy that
 *     has not landed yet). The observation is RETURNED in `drift_since` inside
 *     the grace window so the caller can keep timing it across checks.
 *   - running === latest -> `in_sync` (`match`); clears the timer.
 *   - running > latest  -> `in_sync` (`running_ahead`); nothing is missing.
 *   - unparsable on either side -> `unknown` (`unparseable_running` /
 *     `unparseable_latest` / `invalid_clock`), never `drift`.
 *
 * @param {object} args
 * @param {string} args.running Version this process runs (server/package.json).
 * @param {string|null} args.latestTag Newest release/tag from GitHub.
 * @param {number} args.now Clock, epoch ms.
 * @param {number|null} [args.driftSince] First observation of the mismatch.
 * @param {number} [args.graceMs] How long a mismatch must persist.
 */
export function evaluateDrift({
  running,
  latestTag,
  now,
  driftSince = null,
  graceMs = DEFAULT_GRACE_MS,
}) {
  const runningParsed = parseSemver(running);
  if (!runningParsed) {
    return { status: 'unknown', reason: 'unparseable_running', drift_since: null };
  }
  const latestParsed = parseSemver(latestTag);
  if (!latestParsed) {
    return { status: 'unknown', reason: 'unparseable_latest', drift_since: null };
  }
  if (!Number.isFinite(now)) {
    return { status: 'unknown', reason: 'invalid_clock', drift_since: null };
  }

  const order = compareSemver(running, latestTag);
  if (order === null) {
    // Defensive: parseSemver already agreed on both sides.
    return { status: 'unknown', reason: 'unparseable_version', drift_since: null };
  }
  if (order === 0) {
    return { status: 'in_sync', reason: 'match', drift_since: null };
  }
  if (order > 0) {
    // Ahead is not drift: the newest published release is older than the build
    // that is live. Keep no timer; there is nothing to recover from.
    return { status: 'in_sync', reason: 'running_ahead', drift_since: null };
  }

  const since = Number.isFinite(driftSince) ? driftSince : now;
  const elapsed = now - since;
  if (elapsed >= Math.max(0, graceMs)) {
    return { status: 'drift', reason: 'behind', drift_since: since };
  }
  return { status: 'in_sync', reason: 'behind_within_grace', drift_since: since };
}

// ============================================================================
// State
// ============================================================================

function emptyState() {
  return {
    status: 'unknown',
    // Why this verdict: `not_checked` before any run, `check_failed` when a
    // read fails, otherwise the evaluateDrift reason (match, running_ahead,
    // behind, behind_within_grace, unparseable_*). Additive in v3.12.7.
    reason: 'not_checked',
    running: APP_VERSION,
    latest_tag: null,
    // Which feed produced `latest_tag`: 'release', 'tags', or null before the
    // first successful check. Additive in v3.12.7.
    source: null,
    checked_at: null,
    drift_since: null,
  };
}

let state = emptyState();
let checkTimer = null;
let bootTimer = null;
let inFlight = false;
let lastLoggedFailure = null; // one log line per distinct failure, not per tick
let lastDecisionStatus = null; // transition memory: last of drift|in_sync (never 'unknown')

/**
 * Read-only snapshot for `GET /api/health`. Contains the running version, the
 * newest release tag seen, the last check time and the first observation of the
 * current mismatch — no secrets, nothing caller-specific.
 */
export function deployDriftStatus() {
  return { ...state };
}

/** Test/ops seam: forget the observation history without touching the timer. */
export function resetDeployDriftState() {
  state = emptyState();
  lastLoggedFailure = null;
  lastDecisionStatus = null;
  return deployDriftStatus();
}

// ============================================================================
// Telegram — transitions only
// ============================================================================

function telegramTarget(env = process.env) {
  const botToken = String(env.KANBAN_TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.KANBAN_TELEGRAM_CHAT_ID || '').trim();
  return {
    enabled: Boolean(botToken && chatId),
    botToken,
    chatId,
    boardUrl: String(env.KANBAN_BOARD_URL || DEFAULT_BOARD_URL).replace(/\/+$/, ''),
  };
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function humanDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * Render the one message a transition sends. `kind` is `'drift'`,
 * `'in_sync'` or `'unknown'`.
 *
 * Copy rule (v3.12.7): only a real behind-drift says the deploy is behind, and
 * only a behind-drift may call it a SKIPPED deploy. A build that is AHEAD gets
 * its own sentence ("not drift"), because the old message told an operator to
 * look for a skipped deploy that did not exist. `unknown` never mentions a
 * deploy at all: the check failed, the board did not.
 *
 * Exported only so the wording can be read in a test; the monitor calls it
 * with its own state.
 */
export function formatDeployDriftMessage(kind, snapshot, boardUrl = DEFAULT_BOARD_URL) {
  const running = esc(normalizeTag(snapshot.running) ?? 'unknown');
  const latest = esc(normalizeTag(snapshot.latest_tag) ?? 'unknown');
  const board = esc(boardUrl);
  const order = compareSemver(snapshot.running, snapshot.latest_tag);
  const behind = order !== null && order < 0;

  if (kind === 'drift' && behind) {
    const sinceMs = Date.parse(snapshot.drift_since || '');
    const forHowLong = Number.isNaN(sinceMs) ? '' : ` for ${humanDuration(Date.now() - sinceMs)}`;
    return [
      '🔻 <b>Deploy drift</b>',
      '',
      `Live board is running <b>v${running}</b>, which is BEHIND the newest release <b>v${latest}</b>${forHowLong}.`,
      'A deploy that is behind is most likely SKIPPED (red CI), not failed - the board itself is healthy.',
      '',
      `<b>Board:</b> ${board}`,
    ].join('\n');
  }

  if (kind === 'in_sync' && order !== null && order > 0) {
    return [
      '🔺 <b>Running ahead of the newest release</b>',
      '',
      `Live board runs <b>v${running}</b>, which is AHEAD of the newest published release <b>v${latest}</b>.`,
      'Not drift: nothing is missing from the live build, so no action is needed.',
      '',
      `<b>Board:</b> ${board}`,
    ].join('\n');
  }

  if (kind === 'drift') {
    // A drift verdict we cannot confirm as behind (unparsable on one side, or a
    // caller passing a hand-built snapshot). Stay neutral: never claim a
    // skipped deploy the comparison does not support.
    return [
      '⚠️ <b>Deploy version check needs attention</b>',
      '',
      `Live board runs <b>v${running}</b>; the newest version seen is <b>v${latest}</b>, and the comparison could not confirm the deploy is behind.`,
      '',
      `<b>Board:</b> ${board}`,
    ].join('\n');
  }

  if (kind === 'in_sync') {
    return [
      '✅ <b>Deploy back in sync</b>',
      '',
      `Live board now runs <b>v${running}</b>, matching the newest release <b>v${latest}</b>.`,
      '',
      `<b>Board:</b> ${board}`,
    ].join('\n');
  }

  const reason = esc(snapshot.reason || 'check failed');
  return [
    '❔ <b>Deploy-drift check unavailable</b>',
    '',
    `The board could not compare its version with GitHub (${reason}).`,
    'This is a check failure, not a board outage, and not a deploy verdict.',
    '',
    `<b>Board:</b> ${board}`,
  ].join('\n');
}

/**
 * POST one message to Telegram. Returns true/false, never throws, and logs at
 * most one line. Unconfigured (either env var unset) is a silent no-op.
 */
async function sendTelegram(text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const target = telegramTarget(env);
  if (!target.enabled || typeof fetchImpl !== 'function') return false;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res || !res.ok) {
      console.error(`[kanban deploy-drift] telegram alert failed: HTTP ${res && res.status}`);
      return false;
    }
    console.log('[kanban deploy-drift] delivered 1 alert to telegram');
    return true;
  } catch (err) {
    // Never rethrow: an alerting failure must not affect the board. The token
    // is in the URL, so only the message is logged — and it is already scrubbed
    // by dropping the URL from the error text.
    console.error(`[kanban deploy-drift] telegram alert failed: ${err && err.name}`);
    return false;
  }
}

// ============================================================================
// One check: GitHub reads - release first, tags as the fallback feed
// ============================================================================

const GITHUB_HEADERS = {
  // GitHub rejects API requests with no User-Agent.
  Accept: 'application/vnd.github+json',
};

async function readJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { ...GITHUB_HEADERS, 'User-Agent': `agent-kanban-board/${APP_VERSION}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  return res.json();
}

/** The newest release's tag, or a thrown error (404/403/network/no tag). */
async function readReleaseTag(url, fetchImpl) {
  const body = await readJson(url, fetchImpl);
  const tag = normalizeTag(body && body.tag_name);
  if (!tag) throw new Error('release payload has no tag_name');
  return tag;
}

/** The HIGHEST semver tag in the list, or a thrown error. */
async function readHighestTag(url, fetchImpl) {
  const body = await readJson(url, fetchImpl);
  if (!Array.isArray(body)) throw new Error('tags payload is not an array');
  const best = pickHighestTag(body);
  if (!best) throw new Error('tags payload has no semver tag');
  return best;
}

/**
 * Run a single check: read the newest version from GitHub, compare it with the
 * running version, record the state, and alert ONLY on a status transition.
 *
 * Both feeds are read on every check: the release feed is the primary source,
 * but "is this release stale?" can only be answered against the tag list. A
 * failed tag read is tolerated - the release verdict still stands - while a
 * failed release read falls back to tags. Only when BOTH fail does the check
 * report `unknown`.
 *
 * Injectable (`fetchImpl`, `now`, `env`, `graceMs`, `apiUrl`, `tagsApiUrl`) so
 * the tests drive every branch with no network, no timers and no clock.
 *
 * @returns {Promise<object>} the new `deployDriftStatus()` snapshot.
 */
export async function runDeployDriftCheck({
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  env = process.env,
  graceMs,
  apiUrl,
  tagsApiUrl,
  send = true,
} = {}) {
  const cfg = deployDriftConfig();
  const grace = Number.isFinite(graceMs) ? graceMs : cfg.graceMs;
  const url = apiUrl || cfg.apiUrl;
  const tagsUrl = tagsApiUrl || cfg.tagsApiUrl;
  const previous = state;
  const checkedAt = new Date(now).toISOString();

  let latestTag = null;
  let source = null;

  try {
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation');

    let releaseTag = null;
    let releaseError = null;
    try {
      releaseTag = await readReleaseTag(url, fetchImpl);
    } catch (err) {
      // 404/403/network/no tag_name: the tags endpoint may still know the
      // newest version (this repo published tags before GitHub Releases).
      releaseError = err;
    }

    let highestTag = null;
    let tagsError = null;
    try {
      highestTag = await readHighestTag(tagsUrl, fetchImpl);
    } catch (err) {
      tagsError = err;
    }

    if (highestTag) {
      // Stale = the release has no usable tag, or its tag is OLDER than the
      // highest tag on the repository. Prefer the tags verdict in both cases.
      const releaseIsStale =
        !parseSemver(releaseTag) || compareSemver(releaseTag, highestTag) < 0;
      if (releaseIsStale) {
        latestTag = highestTag;
        source = 'tags';
      } else {
        latestTag = releaseTag;
        source = 'release';
      }
    } else if (parseSemver(releaseTag)) {
      latestTag = releaseTag;
      source = 'release';
    } else {
      throw releaseError || tagsError || new Error('no usable version from GitHub');
    }

    const decision = evaluateDrift({
      running: APP_VERSION,
      latestTag,
      now,
      driftSince: previous.drift_since ? Date.parse(previous.drift_since) : null,
      graceMs: grace,
    });

    state = {
      status: decision.status,
      reason: decision.reason,
      running: APP_VERSION,
      latest_tag: normalizeTag(latestTag),
      source,
      checked_at: checkedAt,
      drift_since:
        decision.drift_since === null ? null : new Date(decision.drift_since).toISOString(),
    };
    lastLoggedFailure = null;
  } catch (err) {
    // Keep `latest_tag`/`source`/`drift_since` from the last SUCCESSFUL
    // observation: a GitHub outage must not erase a drift we are already
    // timing. The status is honest about this check alone.
    state = {
      ...previous,
      status: 'unknown',
      reason: 'check_failed',
      running: APP_VERSION,
      checked_at: checkedAt,
    };
    const line = `[kanban deploy-drift] check failed: ${err && err.message}`;
    // One line per distinct failure; a 30-minute tick would otherwise spam a
    // week of identical DNS errors into the log.
    if (line !== lastLoggedFailure) {
      console.error(line);
      lastLoggedFailure = line;
    }
    return deployDriftStatus();
  }

  if (send) {
    const target = telegramTarget(env);
    if (target.enabled) {
      // Deep-review: transitions are evaluated against the last DECISION state
      // (drift or in_sync), never the raw previous tick. An `unknown` interlude
      // (GitHub outage, unreachable release feed) used to make the same drift
      // alert twice (unknown -> drift) or silently swallow the recovery it was
      // covering (unknown -> in_sync).
      const decision = state.status;
      if (decision !== 'unknown') {
        let delivered = true;
        if (lastDecisionStatus !== 'drift' && decision === 'drift') {
          delivered = await sendTelegram(formatDeployDriftMessage('drift', state, target.boardUrl), {
            env,
            fetchImpl,
          });
        } else if (lastDecisionStatus === 'drift' && decision === 'in_sync') {
          delivered = await sendTelegram(formatDeployDriftMessage('in_sync', state, target.boardUrl), {
            env,
            fetchImpl,
          });
        }
        // Advance only when no send was needed or the send succeeded, so a
        // failed delivery is retried on the next tick.
        if (delivered) lastDecisionStatus = decision;
      }
    }
  }

  return deployDriftStatus();
}

// ============================================================================
// Lifecycle — mirrors startReaper/startBackup in store.js
// ============================================================================

/**
 * Start the monitor: one check shortly after boot, then every
 * `KANBAN_DEPLOY_DRIFT_INTERVAL_MS`. Idempotent. Returns the interval handle, or
 * null when disabled. Both timers are unref()'d so a monitor can never be the
 * reason a process stays alive.
 */
export function startDeployDrift({ fetchImpl = globalThis.fetch } = {}) {
  if (checkTimer) return checkTimer;
  const { intervalMs } = deployDriftConfig();
  if (!(intervalMs > 0)) {
    console.log('[kanban deploy-drift] disabled (KANBAN_DEPLOY_DRIFT_INTERVAL_MS <= 0)');
    return null;
  }

  const tick = () => {
    if (inFlight) return; // a slow GitHub call must not stack up ticks
    inFlight = true;
    runDeployDriftCheck({ fetchImpl })
      .catch((err) => {
        // runDeployDriftCheck already swallows; this is belt-and-braces so an
        // unexpected throw cannot kill the interval or the process.
        console.error('[kanban deploy-drift] check crashed:', err && err.message);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  bootTimer = setTimeout(tick, BOOT_CHECK_DELAY_MS);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();

  checkTimer = setInterval(tick, intervalMs);
  if (typeof checkTimer.unref === 'function') checkTimer.unref();

  console.log(`[kanban deploy-drift] started (interval=${intervalMs}ms)`);
  return checkTimer;
}

/** Stop both timers. Returns true when something was actually running. */
export function stopDeployDrift() {
  let stopped = false;
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
    stopped = true;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
    stopped = true;
  }
  return stopped;
}

export function isDeployDriftRunning() {
  return checkTimer !== null;
}
