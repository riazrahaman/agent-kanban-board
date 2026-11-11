/**
 * C6 (v3.12.5) — the structured logger's contract.
 *
 * The point of the module is not pretty output: it is that every migrated hot
 * path emits ONE line with a stable `[kanban <scope>]` prefix and machine-
 * readable `key=value` fields, and that the single dedupe helper really
 * suppresses a repeat inside its TTL. These three cases pin exactly that.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogger,
  formatLine,
  log,
  resetWarnOnce,
  serializeValue,
  warnOnce,
} from '../logger.js';

describe('C6 structured logger', () => {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  function capture() {
    lines.length = 0;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
  }
  afterEach(() => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    resetWarnOnce();
  });

  it('formats one line with a scope prefix and stable key=value fields', () => {
    assert.equal(
      formatLine('warn', 'webhook', 'delivery failed', { host: 'hooks.example', status: 502, event: 'updated' }),
      '[kanban webhook] delivery failed host=hooks.example status=502 event=updated',
    );
    // Scope-less records keep the historical `[kanban]` prefix.
    assert.equal(formatLine('info', null, 'ready'), '[kanban] ready');
    // Ambiguous string values are quoted so a field can never swallow the next.
    assert.equal(formatLine('error', '', 'boom', { error: 'two words' }), '[kanban] boom error="two words"');
    assert.equal(serializeValue(new Error('bad thing')), '"bad thing"');
  });

  it('dispatches to the level-appropriate console method', () => {
    capture();
    const log = createLogger('reaper');
    log.info('started', { interval_ms: 30 });
    log.warn('slow', { ms: 1200 });
    log.error('failed', { error: 'ECONNRESET' });
    assert.deepEqual(lines, [
      '[kanban reaper] started interval_ms=30',
      '[kanban reaper] slow ms=1200',
      '[kanban reaper] failed error=ECONNRESET',
    ]);
  });

  it('warnOnce emits once per key per ttl and says whether it emitted', () => {
    capture();
    assert.equal(warnOnce('webhook:host:502', 60000, 'answered 502', { status: 502 }, 'webhook'), true);
    assert.equal(warnOnce('webhook:host:502', 60000, 'answered 502', { status: 502 }, 'webhook'), false);
    // A different endpoint/status is a different key, so it still warns.
    assert.equal(warnOnce('webhook:other:503', 60000, 'answered 503', { status: 503 }, 'webhook'), true);
    // ttl 0 means "no dedupe" (always emit).
    assert.equal(warnOnce('webhook:host:502', 0, 'again', {}, 'webhook'), true);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '[kanban webhook] answered 502 status=502');
    // A throwing sink must never propagate into the request/sweep path.
    console.warn = () => {
      throw new Error('sink exploded');
    };
    assert.doesNotThrow(() => log('warn', 'x', 'still safe'));
  });
});
