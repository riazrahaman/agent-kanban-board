import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueBody } from '../routes/bugReports.js';

describe('bug report metadata rendering', () => {
  it('drops a viewport that is not WxH digits', () => {
    const body = buildIssueBody({ boardVersion: '1.0.0', userAgent: 'UA', viewport: '1x1\n![x](http://e/p.png)' })('desc text');
    assert.doesNotMatch(body, /viewport:/);
    assert.doesNotMatch(body, /!\[x\]/);
  });

  it('renders user-agent and viewport inside a fence even with backticks and newlines', () => {
    const body = buildIssueBody({ boardVersion: '1.0.0', userAgent: 'UA ```\n# heading @bob', viewport: '1280x720' })('desc text');
    const first = body.indexOf('`'.repeat(3));
    const uaIdx = body.indexOf('user-agent:');
    assert.ok(first !== -1 && first < uaIdx);
    assert.match(body, /viewport: 1280x720/);
    assert.ok(!/\n# heading/.test(body), 'newline in UA must not start a new markdown line');
    const m = body.match(/^(`{4,})text\nuser-agent:/m);
    assert.ok(m, 'fence is longer than backticks in the UA');
  });
});
