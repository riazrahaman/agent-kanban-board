import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatReportMessage } from '../routes/bugReports.js';

describe('bug report metadata rendering', () => {
  it('drops a viewport that is not WxH digits', () => {
    const text = formatReportMessage({
      title: 't',
      description: 'desc text here',
      boardVersion: '1.0.0',
      userAgent: 'UA',
      viewport: '1x1\n<a href="http://e/p.png">x</a>',
    });
    assert.doesNotMatch(text, /viewport/);
    assert.doesNotMatch(text, /<a /);
  });

  it('renders the user agent on one escaped line with mentions neutralised, viewport kept', () => {
    const text = formatReportMessage({
      title: 't',
      description: 'desc text here',
      boardVersion: '1.0.0',
      userAgent: 'UA </i><b>\n# heading @bob',
      viewport: '1280x720',
    });
    assert.match(text, /viewport 1280x720/);
    assert.ok(text.includes('<i>UA: UA &lt;/i&gt;&lt;b&gt; # heading @​bob</i>'));
    assert.ok(!/\n# heading/.test(text), 'a newline in the UA must not start a new line');
  });
});
