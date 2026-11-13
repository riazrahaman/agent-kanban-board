/**
 * Hardening: expected_version accepts only a non-negative integer or a digit
 * string; everything else is a version conflict.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { versionConflict } from '../store/core.js';

describe('strict expected_version', () => {
  const task = { version: 3 };

  it('accepts the current version as a number or a digit string', () => {
    assert.equal(versionConflict(task, 3), null);
    assert.equal(versionConflict(task, '3'), null);
  });

  it('treats absent guards as no precondition', () => {
    assert.equal(versionConflict(task, undefined), null);
    assert.equal(versionConflict(task, null), null);
  });

  it('rejects coerced look-alikes with the usual 409 shape', () => {
    const bad = [true, false, [3], ['3'], '0x3', ' ', '', ' 3', '3 ', '3.0', '+3', '-3', '1e1', 3.5, -3, NaN, Infinity, {}, '٣'];
    for (const value of bad) {
      const r = versionConflict(task, value);
      assert.ok(r, `rejects ${JSON.stringify(value)}`);
      assert.equal(r.status, 409);
      assert.equal(r.error, 'Version mismatch');
      assert.equal(r.details.expected, 3);
    }
  });

  it('still conflicts on a plain stale version', () => {
    assert.equal(versionConflict(task, 2).status, 409);
    assert.equal(versionConflict(task, '2').details.provided, 2);
  });
});
