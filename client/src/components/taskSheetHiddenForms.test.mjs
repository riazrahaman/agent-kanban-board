// The task sheet's human write controls (comment composer, log composer with
// its Agent ID field, and the Assignment block) are hidden at the owner's
// request ("Hidden completely"). They are commented out, not deleted, so a
// restore is an un-comment. Source-level, like taskSheetGuard.test.mjs:
// commented JSX never renders, so stripping `{/* ... */}` blocks gives what the
// browser actually gets, and the raw source proves the code is still there.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sheet = readFileSync(join(__dirname, 'TaskSheet.tsx'), 'utf8')
const jsxComments = [...sheet.matchAll(/\{\/\*[\s\S]*?\*\/\}/g)].map((m) => m[0])
const live = sheet.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const hiddenBlock = (marker) => {
  const block = jsxComments.find((c) => c.includes(marker))
  assert.ok(block, `TaskSheet.tsx must keep the hidden block marked "${marker}"`)
  return block
}

const CONTROLS = [
  ['comment box', 'placeholder="Add a comment..."'],
  ['Post comment button', 'Post comment'],
  ['Agent ID field', 'placeholder="Agent ID"'],
  ['log message box', 'placeholder="Add a log message..."'],
  ['Add log entry button', 'Add log entry'],
  ['comment form submit', 'onSubmit={handleComment}'],
  ['log form submit', 'onSubmit={handleSubmit}'],
  ['Assign button', 'onClick={() => handleAssign(false)}'],
  ['Release button', 'onClick={() => handleAssign(true)}'],
  ['Assignment help text', 'A privileged token can assign this card'],
]

test('the comment, log-entry and assignment controls do not render', () => {
  for (const [label, needle] of CONTROLS) {
    assert.ok(!live.includes(needle), `the ${label} must be hidden (commented out), but it is live JSX`)
  }
  assert.doesNotMatch(live, /<form\b/, 'the sheet must render no form while the composers are hidden')
  assert.doesNotMatch(live, /<textarea\b|<input\b/, 'the sheet must render no text input while the composers are hidden')
  assert.doesNotMatch(live, />\s*Assignment\s*</, 'the Assignment heading must be hidden with its buttons')
})

test('the hidden controls are commented out with a restore note, not deleted', () => {
  const composers = hiddenBlock('Comment composer and log composer hidden')
  const assignment = hiddenBlock('Assignment block hidden')
  for (const block of [composers, assignment]) {
    assert.match(block, /owner's request/, 'each hidden block must say it is hidden at the owner\'s request')
    assert.match(block, /To restore/, 'each hidden block must say how to restore it')
  }
  for (const [label, needle] of CONTROLS) {
    assert.ok(
      composers.includes(needle) || assignment.includes(needle),
      `the ${label} code must be kept inside a hidden block so restoring it is an un-comment`,
    )
  }
  // Exactly one Agent ID field is kept (shared by both composers and Assign).
  assert.equal((sheet.match(/placeholder="Agent ID"/g) ?? []).length, 1)
})

test('handlers, state and API calls stay compiled and referenced', () => {
  assert.match(sheet, /import \{ addComment, appendLog, assignTask \} from '\.\.\/api'/)
  for (const fn of ['handleAssign', 'handleSubmit', 'handleComment']) {
    assert.match(live, new RegExp(`async function ${fn}\\(`), `${fn} must be kept`)
    assert.match(live, new RegExp(`^  void ${fn}$`, 'm'), `${fn} must stay referenced (void) while its control is hidden`)
  }
  assert.match(live, /await addComment\(task\.id/)
  assert.match(live, /await appendLog\(task\.id/)
  assert.match(live, /await assignTask\(task\.id/)
})

test('the read-only parts still render', () => {
  for (const needle of [
    'Description',
    '{decodeStored(task.description)',
    'Comments',
    'No comments yet.',
    '{decodeStored(comment.message)}',
    'Agent Log',
    "task.agent_logs.length === 1 ? 'entry' : 'entries'",
    '{decodeStored(log.message)}',
    'No log entries yet.',
    'aria-label="Close"',
    '{JSON.stringify(task.metadata, null, 2)}',
  ]) {
    assert.ok(live.includes(needle), `the sheet must still render ${needle}`)
  }
})

test('with the pinned composers gone, the content region fills the sheet and clears the safe area', () => {
  const region = live.match(/<div className="([^"]*\bflex-1\b[^"]*\boverflow-y-auto\b[^"]*)">/)?.[1]
  assert.ok(region, 'the scrollable content region must still render')
  assert.match(region, /\bflex-1\b/, 'the region must grow to fill the sheet below the header')
  assert.match(
    region,
    /pb-\[calc\(1rem_\+_env\(safe-area-inset-bottom\)\)\]/,
    'the region is now the lowest element, so it carries the safe-area bottom padding',
  )
  assert.doesNotMatch(live, /\bborder-t\b/, 'no pinned footer (border-t bar) may be left in the live sheet')
})
