// Pure logic for the "Report a bug" form (v2.16.0, opt-public-bug-reports).
// esbuild-bundles the TS source into ESM at test time (same pattern as
// sanitize.test.mjs / stageOwners.test.mjs) so this runs on every Node
// version CI covers, with no ts-node/vitest dependency.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'bugReport.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})

const tmpDir = await mkdtemp(join(tmpdir(), 'bugreport-test-'))
const tmpFile = join(tmpDir, 'bugReport.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const mod = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const {
  TITLE_MIN,
  TITLE_MAX,
  DESCRIPTION_MIN,
  DESCRIPTION_MAX,
  HONEYPOT_FIELD,
  TURNSTILE_ACTION,
  validateTitle,
  validateDescription,
  validateBugReport,
  canSubmitBugReport,
  remainingChars,
  formatViewport,
  buildBugReportPayload,
  describeSubmitError,
} = mod

test('constants mirror the server limits (routes/bugReports.js)', () => {
  assert.equal(TITLE_MIN, 1)
  assert.equal(TITLE_MAX, 120)
  assert.equal(DESCRIPTION_MIN, 10)
  assert.equal(DESCRIPTION_MAX, 5000)
  assert.equal(HONEYPOT_FIELD, 'website')
  assert.equal(TURNSTILE_ACTION, 'bug-report')
})

test('validateTitle: empty/whitespace-only is rejected', () => {
  assert.ok(validateTitle(''))
  assert.ok(validateTitle('   '))
  assert.equal(validateTitle('a'), undefined)
})

test('validateTitle: accepts exactly 120 chars, rejects 121', () => {
  assert.equal(validateTitle('x'.repeat(120)), undefined)
  assert.ok(validateTitle('x'.repeat(121)))
})

test('validateTitle: trims before measuring, like the server', () => {
  // 120 real chars plus surrounding whitespace must still pass.
  assert.equal(validateTitle(`  ${'x'.repeat(120)}  `), undefined)
})

test('validateDescription: rejects under 10 and over 5000 chars', () => {
  assert.ok(validateDescription('short'))
  assert.ok(validateDescription('x'.repeat(5001)))
  assert.equal(validateDescription('x'.repeat(10)), undefined)
  assert.equal(validateDescription('x'.repeat(5000)), undefined)
})

test('validateBugReport returns both field errors independently', () => {
  const errors = validateBugReport('', 'short')
  assert.ok(errors.title)
  assert.ok(errors.description)
  assert.deepEqual(validateBugReport('ok title', 'a'.repeat(20)), {})
})

test('canSubmitBugReport requires a captcha token AND valid fields', () => {
  assert.equal(canSubmitBugReport('ok title', 'a'.repeat(20), null), false)
  assert.equal(canSubmitBugReport('', 'a'.repeat(20), 'tok'), false)
  assert.equal(canSubmitBugReport('ok title', 'short', 'tok'), false)
  assert.equal(canSubmitBugReport('ok title', 'a'.repeat(20), 'tok'), true)
})

test('remainingChars counts down and goes negative past the max (caller renders that as an error)', () => {
  assert.equal(remainingChars('abc', 10), 7)
  assert.equal(remainingChars('x'.repeat(12), 10), -2)
})

test('formatViewport renders WIDTHxHEIGHT and rounds fractional values', () => {
  assert.equal(formatViewport(1280, 720), '1280x720')
  assert.equal(formatViewport(390.5, 844.2), '391x844')
})

test('buildBugReportPayload trims title/description and defaults website to empty', () => {
  const payload = buildBugReportPayload({
    title: '  padded title  ',
    description: '  padded description text  ',
    turnstileToken: 'tok-123',
    viewport: '1280x720',
  })
  assert.deepEqual(payload, {
    title: 'padded title',
    description: 'padded description text',
    turnstileToken: 'tok-123',
    website: '',
    meta: { viewport: '1280x720' },
  })
})

test('buildBugReportPayload forwards a non-empty website (what a bot-filled honeypot looks like)', () => {
  const payload = buildBugReportPayload({
    title: 't',
    description: 'd'.repeat(10),
    turnstileToken: 'tok',
    viewport: '1x1',
    website: 'http://spam.example',
  })
  assert.equal(payload.website, 'http://spam.example')
})

test('describeSubmitError maps every documented status/code to distinct, non-leaking copy', () => {
  assert.equal(describeSubmitError(429), 'Too many reports, try later.')
  assert.equal(describeSubmitError(502), 'Could not file the report, please try again.')
  assert.match(describeSubmitError(403, 'invalid_captcha'), /verification/i)
  assert.match(describeSubmitError(403, 'invalid_captcha_hostname'), /verification/i)
  assert.match(describeSubmitError(400, 'invalid_title'), /120/)
  assert.match(describeSubmitError(400, 'invalid_description'), /5000/)
  assert.ok(describeSubmitError(400, 'invalid_payload'))
  assert.ok(describeSubmitError(500))
})

test('describeSubmitError never echoes the raw HTTP status code as user copy', () => {
  for (const [status, code] of [
    [429, undefined],
    [502, undefined],
    [403, 'invalid_captcha'],
    [400, 'invalid_title'],
    [400, 'invalid_description'],
  ]) {
    const msg = describeSubmitError(status, code)
    assert.ok(
      !msg.includes(String(status)),
      `message must not leak the raw HTTP status ${status}: ${msg}`,
    )
  }
})
