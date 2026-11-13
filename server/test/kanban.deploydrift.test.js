import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import {
  evaluateDrift,
  runDeployDriftCheck,
  deployDriftStatus,
  deployDriftConfig,
  deriveTagsApiUrl,
  resetDeployDriftState,
  formatDeployDriftMessage,
  normalizeTag,
  DEFAULT_API_URL,
  DEFAULT_GRACE_MS,
  DEFAULT_TAGS_API_URL,
} from '../deployDrift.js';
import { compareSemver, parseSemver, pickHighestTag } from '../semver.js';

// §2.10 (v3.9.5) — deploy-drift monitor.
//
// The whole decision lives in the pure `evaluateDrift()` helper: these tests
// drive it with an explicit clock, and drive `runDeployDriftCheck()` with an
// injected fetch/env so nothing here touches the network or a timer.
//
// Why the behaviour matters: Railway's `checkSuites: true` SKIPS a deployment
// when CI is red. The old build keeps serving with a green /api/health, so a
// skipped deploy is invisible unless two version strings are compared. The
// grace window is what keeps a GOOD deploy (tag cut minutes before the new
// container boots) from alerting.
//
// v3.12.7 - the comparison is semver and one-directional: only `running <
// latest` can be drift. A build AHEAD of the newest release is in sync, and a
// release feed that lags the tag list (the v3.10.5-era false alarm) falls back
// to `/tags`. The tests below pin both corrections with no real network.

const GRACE = 1000;

/**
 * A fetch stub that records every call and routes by URL.
 *
 * `release` is the release feed's `tag_name`; `tags` is the array the tags
 * endpoint returns. A non-200 status or `failAll` throws/returns a failed
 * response for the matching feed.
 */
function githubFetch({
  release = null,
  releaseStatus = 200,
  tags = null,
  tagsStatus = 200,
  failAll = false,
  telegramOk = true,
} = {}) {
  const calls = [];
  const impl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('api.telegram.org')) {
      return { ok: telegramOk, status: telegramOk ? 200 : 500, json: async () => ({}) };
    }
    if (href.includes('/tags')) {
      if (failAll || tagsStatus !== 200) {
        return { ok: false, status: tagsStatus === 200 ? 500 : tagsStatus, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => tags ?? [] };
    }
    if (failAll || releaseStatus !== 200) {
      return {
        ok: false,
        status: releaseStatus === 200 ? 500 : releaseStatus,
        json: async () => ({}),
      };
    }
    return { ok: true, status: 200, json: async () => ({ tag_name: release }) };
  };
  impl.calls = calls;
  return impl;
}

const RELEASE_URL = DEFAULT_API_URL;
const TAGS_URL = DEFAULT_TAGS_API_URL;

describe('v3.12.7 semver helper', () => {
  it('11. orders numeric components, so 3.12.10 is newer than 3.12.9', () => {
    assert.equal(compareSemver('3.12.10', '3.12.9'), 1);
    assert.equal(compareSemver('v3.12.9', '3.12.10'), -1);
    assert.equal(compareSemver('3.12.9', '3.12.9'), 0);
    assert.equal(compareSemver('v3.9.5', '3.9.5'), 0, 'the leading v is not part of the version');
    assert.equal(compareSemver('4.0.0', '3.99.99'), 1);
    // Unparsable is null, never an ordering guess.
    assert.equal(compareSemver('main', '3.12.7'), null);
    assert.equal(compareSemver('3.12.7', 'unknown'), null);
    assert.equal(parseSemver('3.12.7-rc.1').prerelease.join('.'), 'rc.1');
    assert.equal(parseSemver('not-a-version'), null);
  });

  it('12. ranks a prerelease below its release and picks the highest tag from a list', () => {
    assert.equal(compareSemver('3.12.7-rc.1', '3.12.7'), -1);
    assert.equal(compareSemver('3.12.7-rc.2', '3.12.7-rc.10'), -1, 'numeric identifiers compare numerically');
    assert.equal(compareSemver('3.12.7-alpha', '3.12.7-beta'), -1);
    // GitHub returns tags in creation order, so neither first nor last wins:
    // the HIGHEST semver does (note 3.12.10 > 3.12.9 as numbers, not strings).
    assert.equal(pickHighestTag(['v3.12.9', 'v3.12.10', 'v3.12.2']), 'v3.12.10');
    assert.equal(pickHighestTag([{ name: 'v3.10.5' }, { name: 'v3.12.0' }, { name: 'nope' }]), 'v3.12.0');
    assert.equal(pickHighestTag(['nightly', 'main']), null);
    assert.equal(pickHighestTag(null), null);
  });
});

describe('deploy-drift: evaluateDrift (pure)', () => {
  it('1. reports in_sync when the running version matches the latest tag (v-prefix ignored)', () => {
    const d = evaluateDrift({ running: '3.9.5', latestTag: 'v3.9.5', now: 1000, graceMs: GRACE });
    assert.equal(d.status, 'in_sync');
    assert.equal(d.reason, 'match');
    assert.equal(d.drift_since, null);
    // normalizeTag is the one place the prefix is handled.
    assert.equal(normalizeTag('v3.9.5'), '3.9.5');
    assert.equal(normalizeTag('  V3.9.5 '), '3.9.5');
  });

  it('2. reports drift once a BEHIND mismatch has persisted past the grace window', () => {
    const d = evaluateDrift({
      running: '3.9.4',
      latestTag: 'v3.9.5',
      now: GRACE + 1,
      driftSince: 0,
      graceMs: GRACE,
    });
    assert.equal(d.status, 'drift');
    assert.equal(d.reason, 'behind');
    assert.equal(d.drift_since, 0, 'the first observation is preserved for the tooltip');
  });

  it('3. does NOT report drift inside the grace window (a deploy that has not landed yet)', () => {
    const d = evaluateDrift({
      running: '3.9.4',
      latestTag: 'v3.9.5',
      now: GRACE - 1,
      driftSince: 0,
      graceMs: GRACE,
    });
    assert.equal(d.status, 'in_sync');
    assert.equal(d.reason, 'behind_within_grace');
    assert.equal(d.drift_since, 0, 'the timer keeps running across checks');
    // First observation starts the clock rather than back-dating it.
    const first = evaluateDrift({
      running: '3.9.4',
      latestTag: 'v3.9.5',
      now: 5000,
      graceMs: DEFAULT_GRACE_MS,
    });
    assert.equal(first.status, 'in_sync');
    assert.equal(first.drift_since, 5000);
  });

  it('4. reports unknown with a distinct reason when a version string is missing or unparseable', () => {
    const noLatest = evaluateDrift({ running: '3.9.5', latestTag: null, now: 1 });
    assert.equal(noLatest.status, 'unknown');
    assert.equal(noLatest.reason, 'unparseable_latest');

    const noRunning = evaluateDrift({ running: null, latestTag: '3.9.5', now: 1 });
    assert.equal(noRunning.status, 'unknown');
    assert.equal(noRunning.reason, 'unparseable_running');

    const badClock = evaluateDrift({ running: '3.9.5', latestTag: '3.9.5', now: Number.NaN });
    assert.equal(badClock.status, 'unknown');
    assert.equal(badClock.reason, 'invalid_clock');

    // Even a version that LOOKS behind cannot become drift when unparsable.
    const garbage = evaluateDrift({
      running: 'main',
      latestTag: 'v99.9.9',
      now: 10 * GRACE,
      driftSince: 0,
      graceMs: GRACE,
    });
    assert.equal(garbage.status, 'unknown');
    assert.notEqual(garbage.status, 'drift');
  });

  it('13. treats a running build that is AHEAD of the newest release as in_sync, always', () => {
    const ahead = evaluateDrift({
      running: '3.13.0',
      latestTag: 'v3.12.6',
      now: 10 * GRACE,
      driftSince: 0,
      graceMs: GRACE,
    });
    assert.equal(ahead.status, 'in_sync');
    assert.equal(ahead.reason, 'running_ahead');
    assert.equal(ahead.drift_since, null, 'no timer: nothing is missing from the live build');

    // Equal counts as ahead-or-equal, and 3.12.10 beats 3.12.9 numerically.
    assert.equal(evaluateDrift({ running: '3.12.10', latestTag: 'v3.12.9', now: 5 }).status, 'in_sync');
  });
});

describe('deploy-drift: one check against an injected GitHub', () => {
  beforeEach(() => {
    resetDeployDriftState();
  });

  it('14. reports in_sync - and sends nothing - when the running build is ahead of the newest release', async () => {
    const env = { KANBAN_TELEGRAM_BOT_TOKEN: 'tok', KANBAN_TELEGRAM_CHAT_ID: '42' };
    const fetchImpl = githubFetch({ release: 'v3.0.0', tags: [{ name: 'v3.0.0' }] });
    const snapshot = await runDeployDriftCheck({ fetchImpl, env, now: 0, graceMs: 0 });

    assert.equal(snapshot.status, 'in_sync');
    assert.equal(snapshot.reason, 'running_ahead');
    assert.equal(snapshot.drift_since, null);
    assert.equal(snapshot.source, 'release');
    assert.equal(
      fetchImpl.calls.filter((u) => u.includes('api.telegram.org')).length,
      0,
      'running ahead must never produce a drift alert, even with a zero grace window',
    );
  });

  it('5. records in_sync against a reachable release feed and names the source', async () => {
    const running = deployDriftStatus().running;
    const fetchImpl = githubFetch({ release: `v${running}`, tags: [{ name: `v${running}` }] });
    const snapshot = await runDeployDriftCheck({ fetchImpl, env: {}, now: 1700000000000 });

    assert.equal(snapshot.status, 'in_sync');
    assert.equal(snapshot.reason, 'match');
    assert.equal(snapshot.running, running);
    assert.equal(snapshot.latest_tag, running);
    assert.equal(snapshot.source, 'release', 'the release feed is primary when it is current');
    assert.equal(snapshot.checked_at, new Date(1700000000000).toISOString());

    // The release feed and the tag list, no Telegram (env unset).
    assert.deepEqual(fetchImpl.calls, [RELEASE_URL, TAGS_URL]);
  });

  it('6. reports unknown on a fetch failure without throwing, and keeps the last observation', async () => {
    const running = deployDriftStatus().running;
    const ok = githubFetch({ release: `v${running}`, tags: [{ name: `v${running}` }] });
    await runDeployDriftCheck({ fetchImpl: ok, env: {}, now: 1000 });
    assert.equal(deployDriftStatus().latest_tag, running);

    const broken = githubFetch({ failAll: true });
    const snapshot = await runDeployDriftCheck({ fetchImpl: broken, env: {}, now: 2000 });
    assert.equal(snapshot.status, 'unknown');
    assert.equal(snapshot.reason, 'check_failed');
    assert.equal(snapshot.checked_at, new Date(2000).toISOString());
    assert.equal(snapshot.latest_tag, running, 'a GitHub outage does not erase the last tag seen');
    assert.equal(snapshot.source, 'release', 'nor which feed produced it');
    assert.equal(snapshot.running, running);
  });

  it('7. stays silent on Telegram when the bot token or chat id is unset', async () => {
    // Force a real behind-drift transition and prove that only GitHub was read.
    const fetchImpl = githubFetch({ release: 'v99.9.9', tags: [{ name: 'v99.9.9' }] });
    const snapshot = await runDeployDriftCheck({
      fetchImpl,
      env: { KANBAN_TELEGRAM_CHAT_ID: '12345' }, // token missing -> not configured
      now: 0,
      graceMs: 0,
    });
    assert.equal(snapshot.status, 'drift');
    assert.equal(fetchImpl.calls.length, 2, 'release feed + tag list; no telegram POST');
    assert.ok(
      fetchImpl.calls.every((u) => !u.includes('api.telegram.org')),
      'no Telegram call may happen with a partial configuration',
    );
  });

  it('8. sends ONE message on the transition into drift and ONE when it returns to in_sync', async () => {
    const env = { KANBAN_TELEGRAM_BOT_TOKEN: 'tok', KANBAN_TELEGRAM_CHAT_ID: '42' };
    const fetchImpl = githubFetch({ release: 'v99.9.9', tags: [{ name: 'v99.9.9' }] });

    // First observation: inside the grace window -> in_sync, no alert.
    await runDeployDriftCheck({ fetchImpl, env, now: 0, graceMs: 1000 });
    assert.equal(deployDriftStatus().status, 'in_sync');
    assert.equal(fetchImpl.calls.filter((u) => u.includes('api.telegram.org')).length, 0);

    // Same mismatch, now past the window -> drift, exactly one alert.
    await runDeployDriftCheck({ fetchImpl, env, now: 1001, graceMs: 1000 });
    assert.equal(deployDriftStatus().status, 'drift');
    const driftAlerts = fetchImpl.calls.filter((u) => u.includes('api.telegram.org'));
    assert.equal(driftAlerts.length, 1);
    // The bot token is in the URL, so the URL is never logged; the request is a
    // POST to the documented Bot API shape.
    assert.match(driftAlerts[0], /api\.telegram\.org\/bottok\/sendMessage$/);

    // Still drifting on the next tick -> NOT a second message.
    await runDeployDriftCheck({ fetchImpl, env, now: 2001, graceMs: 1000 });
    assert.equal(fetchImpl.calls.filter((u) => u.includes('api.telegram.org')).length, 1);

    // The feeds now match the running version -> one "back in sync".
    const running = deployDriftStatus().running;
    const back = githubFetch({ release: `v${running}`, tags: [{ name: `v${running}` }] });
    await runDeployDriftCheck({ fetchImpl: back, env, now: 3001 });
    assert.equal(deployDriftStatus().status, 'in_sync');
    assert.equal(back.calls.filter((u) => u.includes('api.telegram.org')).length, 1);
  });

  it('16. falls back to the tags endpoint when releases/latest is missing (404)', async () => {
    const running = deployDriftStatus().running;
    const fetchImpl = githubFetch({
      releaseStatus: 404,
      tags: [{ name: `v${running}` }, { name: 'v3.10.5' }],
    });
    const snapshot = await runDeployDriftCheck({ fetchImpl, env: {}, now: 5000 });

    assert.deepEqual(fetchImpl.calls, [RELEASE_URL, TAGS_URL]);
    assert.equal(snapshot.status, 'in_sync');
    assert.equal(snapshot.latest_tag, running);
    assert.equal(snapshot.source, 'tags', 'a missing release feed is not an unknown verdict');
  });

  it('17. prefers the tags result when the release feed is stale (v3.10.5 vs the tag list)', async () => {
    // The historical false alarm: releases/latest stuck at v3.10.5 while the
    // board ran 3.12.x. With release v3.10.5 and the highest tag equal to the
    // running version, the verdict is in_sync - not drift.
    const running = deployDriftStatus().running;
    const fetchImpl = githubFetch({
      release: 'v3.10.5',
      tags: [{ name: 'v3.12.0' }, { name: `v${running}` }, { name: 'v3.11.0' }],
    });
    const snapshot = await runDeployDriftCheck({ fetchImpl, env: {}, now: 6000, graceMs: 0 });

    assert.equal(snapshot.status, 'in_sync');
    assert.equal(snapshot.latest_tag, running);
    assert.equal(snapshot.source, 'tags');
  });

  it('18. chooses the highest semver tag, not the first or last array entry', async () => {
    const fetchImpl = githubFetch({
      release: 'v3.99.9',
      tags: [{ name: 'v3.99.9' }, { name: 'v3.99.10' }, { name: 'v3.99.2' }],
    });
    const snapshot = await runDeployDriftCheck({ fetchImpl, env: {}, now: 7000, graceMs: 0 });

    assert.equal(snapshot.latest_tag, '3.99.10', 'numeric ordering, not array order or string order');
    assert.equal(snapshot.source, 'tags');
    assert.equal(snapshot.status, 'drift', 'the running build is genuinely behind 3.99.10');
    assert.equal(snapshot.reason, 'behind');
  });

  it('19. keeps the release verdict when only the tag list fails', async () => {
    const running = deployDriftStatus().running;
    const fetchImpl = githubFetch({ release: `v${running}`, tagsStatus: 500 });
    const snapshot = await runDeployDriftCheck({ fetchImpl, env: {}, now: 8000 });

    assert.equal(snapshot.status, 'in_sync');
    assert.equal(snapshot.latest_tag, running);
    assert.equal(snapshot.source, 'release');
  });

  it('20. a fetch failure preserves the running drift timer and reports unknown', async () => {
    const behind = githubFetch({ release: 'v99.9.9', tags: [{ name: 'v99.9.9' }] });
    const first = await runDeployDriftCheck({
      fetchImpl: behind,
      env: {},
      now: 10000,
      graceMs: 0,
    });
    assert.equal(first.status, 'drift');
    const since = first.drift_since;
    assert.equal(since, new Date(10000).toISOString());

    const broken = githubFetch({ failAll: true });
    const snapshot = await runDeployDriftCheck({ fetchImpl: broken, env: {}, now: 20000 });
    assert.equal(snapshot.status, 'unknown');
    assert.equal(snapshot.reason, 'check_failed');
    assert.equal(snapshot.drift_since, since, 'the outage must not erase the first observation');
    assert.equal(snapshot.latest_tag, '99.9.9');
  });

  it('24. derives the tags endpoint from the release feed and honours the env override', () => {
    assert.equal(
      deriveTagsApiUrl('https://api.github.com/repos/someone/fork/releases/latest'),
      'https://api.github.com/repos/someone/fork/tags?per_page=100',
    );
    assert.equal(deriveTagsApiUrl(''), DEFAULT_TAGS_API_URL);
    assert.equal(deriveTagsApiUrl(null), DEFAULT_TAGS_API_URL);

    const saved = {
      api: process.env.KANBAN_DEPLOY_DRIFT_API_URL,
      tags: process.env.KANBAN_DEPLOY_DRIFT_TAGS_API_URL,
    };
    try {
      delete process.env.KANBAN_DEPLOY_DRIFT_API_URL;
      delete process.env.KANBAN_DEPLOY_DRIFT_TAGS_API_URL;
      assert.equal(deployDriftConfig().tagsApiUrl, DEFAULT_TAGS_API_URL);

      process.env.KANBAN_DEPLOY_DRIFT_API_URL =
        'https://api.github.com/repos/someone/fork/releases/latest';
      assert.equal(
        deployDriftConfig().tagsApiUrl,
        'https://api.github.com/repos/someone/fork/tags?per_page=100',
        'a fork needs one env var, not two',
      );

      process.env.KANBAN_DEPLOY_DRIFT_TAGS_API_URL = 'https://example.test/tags';
      assert.equal(deployDriftConfig().tagsApiUrl, 'https://example.test/tags');
    } finally {
      if (saved.api === undefined) delete process.env.KANBAN_DEPLOY_DRIFT_API_URL;
      else process.env.KANBAN_DEPLOY_DRIFT_API_URL = saved.api;
      if (saved.tags === undefined) delete process.env.KANBAN_DEPLOY_DRIFT_TAGS_API_URL;
      else process.env.KANBAN_DEPLOY_DRIFT_TAGS_API_URL = saved.tags;
    }
  });
});

describe('deploy-drift: alert copy (neutral, one-directional)', () => {
  it('9. names both versions and calls a BEHIND deploy skipped, not failed', () => {
    const text = formatDeployDriftMessage(
      'drift',
      {
        running: '3.9.4',
        latest_tag: '3.9.5',
        drift_since: new Date(Date.now() - 50 * 60000).toISOString(),
      },
      'https://example.test',
    );
    assert.match(text, /v3\.9\.4/);
    assert.match(text, /v3\.9\.5/);
    assert.match(text, /example\.test/);
    assert.match(text, /BEHIND/);
    assert.match(text, /SKIPPED/, 'a behind deploy says skipped, not failed');
  });

  it('21. never says "skipped" or "deploy was" for a running-ahead snapshot', () => {
    const ahead = formatDeployDriftMessage(
      'in_sync',
      { running: '3.13.0', latest_tag: '3.12.6' },
      'https://example.test',
    );
    assert.match(ahead, /AHEAD/);
    assert.match(ahead, /v3\.13\.0/);
    assert.match(ahead, /v3\.12\.6/);
    assert.doesNotMatch(ahead, /skip/i);
    assert.doesNotMatch(ahead, /deploy was/i);

    // A hand-built "drift" kind that is not actually behind stays neutral too:
    // the copy may never claim a skipped deploy the comparison does not support.
    const notBehind = formatDeployDriftMessage(
      'drift',
      { running: '3.13.0', latest_tag: '3.12.6' },
      'https://example.test',
    );
    assert.doesNotMatch(notBehind, /skip/i);
    assert.doesNotMatch(notBehind, /deploy was/i);
  });

  it('22. gives unknown its own message with no deploy verdict', () => {
    const text = formatDeployDriftMessage(
      'unknown',
      { running: '3.12.7', latest_tag: '3.12.6', reason: 'check_failed' },
      'https://example.test',
    );
    assert.match(text, /check unavailable/);
    assert.match(text, /check failure, not a board outage/);
    assert.doesNotMatch(text, /skip/i);
    assert.doesNotMatch(text, /deploy was/i);
  });
});

describe('deploy-drift: GET /api/health', () => {
  it('10. exposes deploy_drift publicly with no secrets', async () => {
    resetDeployDriftState();
    const app = createApp();
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const d = body.deploy_drift;
      assert.ok(d && typeof d === 'object', '/api/health must carry deploy_drift');
      assert.deepEqual(Object.keys(d).sort(), [
        'checked_at',
        'drift_since',
        'latest_tag',
        'reason',
        'running',
        'source',
        'status',
      ]);
      assert.ok(['in_sync', 'drift', 'unknown'].includes(d.status));
      assert.equal(d.status, 'unknown', 'no check has run in a createApp-only process');
      assert.equal(d.reason, 'not_checked');
      assert.equal(d.source, null);
      assert.equal(d.checked_at, null);
      assert.equal(typeof d.running, 'string');
      // Nothing credential-shaped may ride along on a public endpoint.
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes('telegram'), 'no bot token/chat id in the payload');
      assert.ok(!/@|api\.github\.com/.test(JSON.stringify(d)), 'no URLs in the drift block');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
