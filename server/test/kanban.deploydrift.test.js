import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import {
  evaluateDrift,
  runDeployDriftCheck,
  deployDriftStatus,
  resetDeployDriftState,
  formatDeployDriftMessage,
  normalizeTag,
  DEFAULT_GRACE_MS,
} from '../deployDrift.js';

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

const GRACE = 1000;

function releaseResponse(tagName) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ tag_name: tagName }),
  };
}

/** A fetch stub that records every call and routes by URL. */
function recordingFetch({ tagName = null, failRelease = false, telegramOk = true } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.github.com') || String(url).includes('/releases/latest')) {
      if (failRelease) throw new Error('getaddrinfo ENOTFOUND api.github.com');
      return releaseResponse(tagName);
    }
    return { ok: telegramOk, status: telegramOk ? 200 : 500, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

describe('deploy-drift: evaluateDrift (pure)', () => {
  it('1. reports in_sync when the running version matches the latest tag (v-prefix ignored)', () => {
    const d = evaluateDrift({ running: '3.9.5', latestTag: 'v3.9.5', now: 1000, graceMs: GRACE });
    assert.equal(d.status, 'in_sync');
    assert.equal(d.drift_since, null);
    // normalizeTag is the one place the prefix is handled.
    assert.equal(normalizeTag('v3.9.5'), '3.9.5');
    assert.equal(normalizeTag('  V3.9.5 '), '3.9.5');
  });

  it('2. reports drift once the mismatch has persisted past the grace window', () => {
    const d = evaluateDrift({
      running: '3.9.4',
      latestTag: 'v3.9.5',
      now: GRACE + 1,
      driftSince: 0,
      graceMs: GRACE,
    });
    assert.equal(d.status, 'drift');
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

  it('4. reports unknown when a version string is missing or unparseable', () => {
    assert.equal(evaluateDrift({ running: '3.9.5', latestTag: null, now: 1 }).status, 'unknown');
    assert.equal(evaluateDrift({ running: null, latestTag: '3.9.5', now: 1 }).status, 'unknown');
    assert.equal(
      evaluateDrift({ running: '3.9.5', latestTag: '3.9.5', now: Number.NaN }).status,
      'unknown',
    );
  });
});

describe('deploy-drift: one check against an injected GitHub', () => {
  beforeEach(() => {
    resetDeployDriftState();
  });

  it('5. records in_sync against a reachable release feed', async () => {
    const running = deployDriftStatus().running;
    const fetchImpl = recordingFetch({ tagName: `v${running}` });
    const snapshot = await runDeployDriftCheck({ fetchImpl, env: {}, now: 1700000000000 });

    assert.equal(snapshot.status, 'in_sync');
    assert.equal(snapshot.running, running);
    assert.equal(snapshot.latest_tag, running);
    assert.equal(snapshot.checked_at, new Date(1700000000000).toISOString());

    // The request carries a User-Agent (GitHub rejects API calls without one)
    // and one request was made: the release feed, no Telegram (env unset).
    assert.deepEqual(fetchImpl.calls, [
      'https://api.github.com/repos/riazrahaman/agent-kanban-board/releases/latest',
    ]);
  });

  it('6. reports unknown on a fetch failure without throwing, and keeps the last observation', async () => {
    const running = deployDriftStatus().running;
    const ok = recordingFetch({ tagName: `v${running}` });
    await runDeployDriftCheck({ fetchImpl: ok, env: {}, now: 1000 });
    assert.equal(deployDriftStatus().latest_tag, running);

    const broken = recordingFetch({ failRelease: true });
    const snapshot = await runDeployDriftCheck({ fetchImpl: broken, env: {}, now: 2000 });
    assert.equal(snapshot.status, 'unknown');
    assert.equal(snapshot.checked_at, new Date(2000).toISOString());
    assert.equal(snapshot.latest_tag, running, 'a GitHub outage does not erase the last tag seen');
    assert.equal(snapshot.running, running);
  });

  it('7. stays silent on Telegram when the bot token or chat id is unset', async () => {
    // Fresh state: the first observation is a mismatch inside the grace window,
    // so no transition happens at all. Then force a real drift transition and
    // prove that only the release feed was called.
    const fetchImpl = recordingFetch({ tagName: 'v99.9.9' });
    const snapshot = await runDeployDriftCheck({
      fetchImpl,
      env: { KANBAN_TELEGRAM_CHAT_ID: '12345' }, // token missing -> not configured
      now: 0,
      graceMs: 0,
    });
    assert.equal(snapshot.status, 'drift');
    assert.equal(fetchImpl.calls.length, 1, 'only the GitHub read; no telegram POST');
    assert.ok(
      fetchImpl.calls.every((u) => !u.includes('api.telegram.org')),
      'no Telegram call may happen with a partial configuration',
    );
  });

  it('8. sends ONE message on the transition into drift and ONE when it returns to in_sync', async () => {
    const env = { KANBAN_TELEGRAM_BOT_TOKEN: 'tok', KANBAN_TELEGRAM_CHAT_ID: '42' };
    const fetchImpl = recordingFetch({ tagName: 'v99.9.9' });

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

    // The release feed now matches the running version -> one "back in sync".
    const back = recordingFetch({ tagName: `v${deployDriftStatus().running}` });
    await runDeployDriftCheck({ fetchImpl: back, env, now: 3001 });
    assert.equal(deployDriftStatus().status, 'in_sync');
    assert.equal(back.calls.filter((u) => u.includes('api.telegram.org')).length, 1);
  });

  it('9. never leaks a version-shaped secret in the message text and names both versions', () => {
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
    assert.match(text, /SKIPPED/, 'the message says a skipped deploy, not a failure');
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
        'running',
        'status',
      ]);
      assert.ok(['in_sync', 'drift', 'unknown'].includes(d.status));
      assert.equal(d.status, 'unknown', 'no check has run in a createApp-only process');
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
