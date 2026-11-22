// Master password, client side: the click gate, the rail's locked activity
// feed, the unlock storage rules, and source-contract guards for the removed
// inline title editor. esbuild bundles the TS (see signalStats.test.mjs for
// why): CI also runs Node 20, which cannot execute .ts files.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..')
const read = (...parts) => readFileSync(join(SRC, ...parts), 'utf8')

const result = await build({
  entryPoints: [join(__dirname, 'detailLock.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'detailLock-test-'))
const bundlePath = join(tmpDir, 'detailLock.mjs')
await writeFile(bundlePath, result.outputFiles[0].text)
const m = await import(pathToFileURL(bundlePath).href)
after(() => rm(tmpDir, { recursive: true, force: true }))

const open = { id: 'a', project: 'p', title: 'Open card', agent_logs: [{ timestamp: '2026-01-02T00:00:00Z', agent_id: 'x', message: 'did a thing' }] }
const locked = {
  id: 'b', project: 'p', title: 'Locked card', agent_logs: [], details_locked: true,
  activity: [{ timestamp: '2026-01-03T00:00:00Z', agent_id: 'y' }],
}

test('a task is locked only when the server marked it so', () => {
  assert.equal(m.isDetailsLocked(locked), true)
  assert.equal(m.isDetailsLocked(open), false)
  assert.equal(m.isDetailsLocked({ details_locked: 'true' }), false)
  assert.equal(m.isDetailsLocked(null), false)
  assert.equal(m.boardDetailsLocked([open, locked]), true)
  assert.equal(m.boardDetailsLocked([open]), false)
  assert.equal(m.boardDetailsLocked([]), false)
})

test('click gate: an unlocked task opens by project/id, a locked or unknown one does nothing', () => {
  const tasks = [open, locked, { id: 'a', project: 'other' }]
  assert.equal(m.openKeyFor(tasks, 'p', 'a'), 'p/a')
  assert.equal(m.openKeyFor(tasks, 'other', 'a'), 'other/a', 'ids repeat across projects: the key carries the project')
  assert.equal(m.openKeyFor(tasks, 'p', 'b'), null, 'locked: the click must not open anything')
  assert.equal(m.openKeyFor(tasks, 'p', 'missing'), null)
  assert.equal(m.openKeyFor(tasks, 'a', 'p'), null, 'arguments are (project, id), never swapped')
})

test('rail activity: locked tasks contribute who/when without any text', () => {
  const items = m.railActivity([open, locked])
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((i) => i.taskId), ['b', 'a'], 'newest first')
  assert.deepEqual(items[0], { project: 'p', taskId: 'b', taskTitle: 'Locked card', agentId: 'y', message: '', timestamp: '2026-01-03T00:00:00Z', locked: true })
  assert.equal(items[1].message, 'did a thing')
  assert.equal(items[1].locked, false)
  const many = { ...open, agent_logs: Array.from({ length: 30 }, (_, i) => ({ timestamp: new Date(1e12 + i * 1000).toISOString(), agent_id: 'x', message: `m${i}` })) }
  assert.equal(m.railActivity([many]).length, 20)
  assert.deepEqual(m.railActivity([{ id: 'c', project: 'p', title: 't', details_locked: true }]), [])
})

test('stored unlock: only a well-formed, unexpired token counts', () => {
  const now = 1000
  assert.deepEqual(m.parseStoredUnlock(JSON.stringify({ token: 'abc.def', exp: 2000 }), now), { token: 'abc.def', exp: 2000 })
  assert.equal(m.parseStoredUnlock(JSON.stringify({ token: 'abc.def', exp: 1000 }), now), null, 'expired')
  assert.equal(m.parseStoredUnlock(JSON.stringify({ token: '', exp: 2000 }), now), null)
  assert.equal(m.parseStoredUnlock(JSON.stringify({ token: 'abc' }), now), null)
  assert.equal(m.parseStoredUnlock('not json', now), null)
  assert.equal(m.parseStoredUnlock(null, now), null)
  assert.deepEqual(m.unlockHeaders({ token: 'abc.def', exp: 2000 }), { 'X-Kanban-Unlock': 'abc.def' })
  assert.deepEqual(m.unlockHeaders(null), {})
})

test('readStoredUnlock / writeStoredUnlock keep only the token, drop an expired one, and survive blocked storage', () => {
  const data = new Map()
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  }
  m.writeStoredUnlock({ token: 'abc.def', exp: 5000 })
  assert.deepEqual(JSON.parse(data.get(m.UNLOCK_KEY)), { token: 'abc.def', exp: 5000 })
  assert.deepEqual(m.readStoredUnlock(1000), { token: 'abc.def', exp: 5000 })
  assert.equal(m.readStoredUnlock(6000), null)
  assert.equal(data.has(m.UNLOCK_KEY), false, 'an expired unlock is removed')
  m.writeStoredUnlock({ token: 'abc.def', exp: 5000 })
  m.writeStoredUnlock(null)
  assert.equal(data.has(m.UNLOCK_KEY), false)
  globalThis.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } }
  assert.equal(m.readStoredUnlock(), null)
  assert.doesNotThrow(() => m.writeStoredUnlock({ token: 'x', exp: 1 }))
  delete globalThis.localStorage
})

test('the server decides what the typed value is; an unclear answer stores nothing', () => {
  assert.deepEqual(m.classifyUnlockResponse(200, { unlocked: true, token: 't.m', expires_at: 99 }), { kind: 'unlocked', unlock: { token: 't.m', exp: 99 } })
  assert.deepEqual(m.classifyUnlockResponse(200, { unlocked: false }), { kind: 'token' })
  assert.deepEqual(m.classifyUnlockResponse(429, { retry_after_ms: 1234 }), { kind: 'throttled', retryAfterMs: 1234 })
  assert.deepEqual(m.classifyUnlockResponse(429, null), { kind: 'throttled', retryAfterMs: 60000 })
  for (const [status, body] of [[500, null], [200, null], [200, { unlocked: true }], [400, { error: 'password_required' }], [404, null]]) {
    assert.deepEqual(m.classifyUnlockResponse(status, body), { kind: 'unverified' }, `${status}`)
  }
})

// --- source contracts -------------------------------------------------------

test('TaskCard: no inline title editor; a double-click is just a click', () => {
  const card = read('components', 'TaskCard.tsx')
  for (const banned of ['onDoubleClick', 'editingTitle', 'draftTitle', 'handleSaveTitle', 'Double-click', 'patchTask', 'useState', '<input']) {
    assert.ok(!card.includes(banned), `TaskCard.tsx must not contain ${banned}`)
  }
  assert.doesNotMatch(card, /from '\.\.\/api'/, 'a card performs no API write')
})

test('TaskCard: a locked card has no click handler, a default cursor and the hint tooltip', () => {
  const card = read('components', 'TaskCard.tsx')
  assert.match(card, /const locked = isDetailsLocked\(task\)/)
  assert.match(card, /onClick=\{locked \? undefined : \(\) => onOpen\(task\.project, task\.id\)\}/)
  assert.match(card, /title=\{locked \? LOCKED_HINT : undefined\}/)
  assert.match(card, /locked \? 'cursor-default' : 'cursor-pointer'/)
  assert.match(card, /prev\.task\.details_locked === next\.task\.details_locked/, 'the memo comparator must see a lock flip at the same version')
  assert.equal(m.LOCKED_HINT, 'Enter the master password to view details')
})

test('App: onOpen takes (project, id) end to end and goes through the lock gate', () => {
  const app = read('App.tsx')
  assert.match(app, /const handleOpen = useCallback\(\(taskProject: string, id: string\) => \{\s*const key = openKeyFor\(tasksRef\.current, taskProject, id\)\s*if \(key\) setOpenTaskId\(key\)/)
  assert.doesNotMatch(app, /handleOpen = useCallback\(\(id: string\) => setOpenTaskId\(id\)/, 'the one-argument handler stored the PROJECT as the open id')
  assert.match(read('components', 'Board.tsx'), /onOpen: \(project: string, id: string\) => void/)
  assert.match(read('components', 'Column.tsx'), /onOpen: \(project: string, id: string\) => void/)
  assert.match(read('components', 'SignalRail.tsx'), /onOpen: \(project: string, id: string\) => void/)
  // An open sheet never shows a locked task.
  assert.match(app, /return found && !isDetailsLocked\(found\) \? found : null/)
})

test('App: the header box asks the server what the value is and never stores an unverified one', () => {
  const app = read('App.tsx')
  assert.match(app, /const outcome = await requestUnlock\(value\)/)
  const commit = app.slice(app.indexOf('const commitToken = async'), app.indexOf('const lockDetails'))
  const tokenBranch = commit.slice(commit.indexOf("outcome.kind === 'token'"), commit.indexOf('} else {'))
  assert.match(tokenBranch, /writeStoredToken\(value\)/)
  const otherBranches = commit.replace(tokenBranch, '')
  assert.doesNotMatch(otherBranches, /writeStoredToken\(value\)/, 'only an explicit "not the master password" answer may store the value as a token')
  assert.match(commit, /writeStoredUnlock\(outcome\.unlock\)/)
  // The stream is re-opened when credentials change, so details follow the lock.
  assert.match(app, /\}, \[project, authEpoch\]\)/)
  // Still the one token box, still no "read-only" chip.
  assert.match(app, /aria-label="API token for mutating requests"/)
  assert.match(app, /data-testid="detail-lock-mark"/)
})

test('api: the password goes in a POST body; the unlock token only ever in a header', () => {
  const api = read('api.ts')
  const unlockFn = api.slice(api.indexOf('export async function requestUnlock'), api.indexOf('async function mintStreamTicket'))
  assert.match(unlockFn, /fetch\(`\$\{API_BASE\}\/auth\/unlock`, \{\s*method: 'POST'/)
  assert.match(unlockFn, /body: JSON\.stringify\(\{ password: value \}\)/)
  assert.doesNotMatch(api, /[?&](unlock|password)=/, 'neither the password nor the unlock may appear in a URL')
  assert.doesNotMatch(api, /params\.set\('(unlock|password)'/)
  assert.match(api, /return \{ \.\.\.authHeaders\(readStoredToken\(\)\), \.\.\.unlockHeaders\(\) \}/)
  // saveSettings no longer swallows a refusal.
  assert.match(api, /throw new SettingsSaveError\(res\.status/)
})

test('HeaderHelp explains both uses of the box and offers Lock', () => {
  const help = read('components', 'HeaderHelp.tsx')
  assert.match(help, /master password/)
  assert.match(help, /never stored/)
  assert.match(help, /12-hour unlock/)
  assert.match(help, /onLock\(\)/)
  const lockButton = help.slice(help.indexOf('onLock()'), help.indexOf('Lock\n'))
  assert.match(lockButton, /pointer-coarse:min-h-11/, 'the Lock button needs a 44px touch height')
})

test('Columns popover: a refused save is announced, not swallowed', () => {
  const control = read('components', 'ColumnColorsControl.tsx')
  assert.match(control, /data-testid="column-colors-save-error"/)
  assert.match(control, /role="alert"/)
  const app = read('App.tsx')
  assert.match(app, /Not saved\. Enter the master password in the header token box to save column colours\./)
})
