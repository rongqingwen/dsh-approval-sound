/**
 * Dev-only harness for dsh-approval-sound's host half. Not shipped (excluded
 * from package.json `files`): it fakes the Cordis context and the webServer
 * routes so the waterfall observation, the pending bookkeeping and the config
 * route can be exercised without booting DSH.
 *
 * The harness owns a throwaway `$DSH_HOME`, so running it can never read or
 * write the live plugin configuration.
 *
 * Run: node scripts/dev-harness.mjs
 */

import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Must be set before the plugin module is imported: `stateDir()` reads it.
const sandboxHome = await mkdtemp(join(tmpdir(), 'dsh-approval-sound-harness-'))
process.env.DSH_HOME = sandboxHome

const { apply, resolveConfig } = await import('../host.js')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Minimal Cordis-shaped context: only what the plugin body touches. */
function makeCtx() {
  // The plugin guards duplicates through a process-global symbol; reset it so
  // each harness section starts from a clean, unmounted plugin.
  globalThis[Symbol.for('dsh-approval-sound.mounted')]?.clear()

  const listeners = new Map()
  const routes = new Map()
  const effects = []

  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const at = current.indexOf(handler)
        if (at !== -1) current.splice(at, 1)
      }
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    get() {
      return undefined
    },
    webServer: {
      register(route) {
        if (routes.has(`${route.kind}:${route.path}`)) throw new Error(`duplicate route ${route.path}`)
        routes.set(`${route.kind}:${route.path}`, route)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    },
  }

  return {
    ctx,
    effects,
    /**
     * Fire one waterfall exactly as its service does.
     *
     * @param req - the request payload the service dispatches.
     * @param answerer - the terminal answerer the waterfall ends in.
     * @param event - which seam to dispatch (defaults to the approval seam).
     */
    async waterfall(req, answerer, event = 'approval/request') {
      const list = listeners.get(event) ?? []
      let index = -1
      const next = () => {
        index += 1
        const handler = list[index]
        if (handler === undefined) return Promise.resolve(answerer())
        // The real waterfall passes a trailing `next`.
        return Promise.resolve(handler(req, next))
      }
      return next()
    },
    /**
     * Drive one registered route the way the http server does.
     *
     * `binary: true` sends `body` as raw bytes and collects the response as raw
     * bytes, which is what the uploaded-audio route needs; otherwise the body is
     * a JSON string and the response is parsed.
     */
    async request(path, { method = 'GET', headers = {}, body, binary = false } = {}) {
      const route = [...routes.values()].find((candidate) => candidate.kind === 'exact'
        ? candidate.path === path
        : path === candidate.path || path.startsWith(candidate.path))
      if (route === undefined) throw new Error(`no route for ${path}`)

      const request = {
        url: path,
        method,
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          host: '127.0.0.1:19387',
          'sec-fetch-site': 'same-origin',
          origin: 'http://127.0.0.1:19387',
          ...headers,
        },
        async *[Symbol.asyncIterator]() {
          if (body === undefined) return
          yield binary ? Buffer.from(body) : Buffer.from(body, 'utf8')
        },
        destroy() {},
      }

      const chunks = []
      let status
      let responseHeaders
      const response = {
        writeHead(code, extra) {
          status = code
          responseHeaders = extra
        },
        end(payload) { if (payload !== undefined) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))) },
        destroy() {},
      }
      await route.handler(request, response)

      const raw = Buffer.concat(chunks)
      if (binary) {
        // Return both shapes: a JSON error body is still JSON when the caller
        // asked for bytes, and tests want to read its `error` field.
        let parsed
        try {
          parsed = JSON.parse(raw.toString('utf8'))
        } catch {
          parsed = undefined
        }
        return { status, headers: responseHeaders, bytes: raw, body: parsed }
      }
      const text = raw.toString('utf8')
      return { status, headers: responseHeaders, body: text === '' ? undefined : JSON.parse(text) }
    },
  }
}

console.log('dsh-approval-sound host harness\n')

/**
 * A WAV-shaped buffer: the RIFF/WAVE header the validator actually inspects,
 * followed by `payload` bytes of filler. It is not a decodable recording — the
 * host never decodes — but it exercises the magic-byte and size paths exactly.
 */
function wavClip(payload) {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4, 1),
    Buffer.from('WAVEfmt '),
    Buffer.alloc(Math.max(0, payload), 3),
  ])
}

/** Write the plugin's persisted config straight to the sandbox home. */
async function writeConfig(document) {
  const directory = join(sandboxHome, 'dsh-approval-sound')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'config.json'), JSON.stringify(document), 'utf8')
}


console.log('resolveConfig')
{
  const defaults = resolveConfig(undefined)
  check('defaults are enabled', defaults.enabled === true)
  check('the default volume is unity', defaults.volume === 1)
  check('volume clamps above the boost ceiling', resolveConfig({ volume: 9 }).volume === 1.5)
  check('a boosted volume is preserved', resolveConfig({ volume: 1.4 }).volume === 1.4)
  check('volume clamps below 0', resolveConfig({ volume: -3 }).volume === 0)
  check('volume 0 is preserved (silent, not defaulted)', resolveConfig({ volume: 0 }).volume === 0)
  check('unknown sound falls back to alert', resolveConfig({ sound: 'nope' }).sound === 'alert')
  check('the custom profile is accepted', resolveConfig({ sound: 'custom' }).sound === 'custom')
  check('repeat clamps to 5', resolveConfig({ repeat: 99 }).repeat === 5)
  check('repeatIntervalMs clamps low', resolveConfig({ repeatIntervalMs: 1 }).repeatIntervalMs === 120)
  check('onlyWhenUnfocused is strict', resolveConfig({ onlyWhenUnfocused: 'yes' }).onlyWhenUnfocused === false)
  check('custom metadata defaults to empty', resolveConfig({}).customName === '')
  check('custom metadata survives a round trip', resolveConfig({ customName: 'custom.wav', customBytes: 12, customAt: 5 }).customBytes === 12)
}

console.log('\nwaterfall observation')
{
  const harness = makeCtx()
  apply(harness.ctx, {})

  // Nothing pending before any request.
  let snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('pending route answers 200', snapshot.status === 200)
  check('starts with no pending requests', snapshot.body.pending.length === 0)

  // One request, answered by the stub answerer after a beat.
  const controller = new AbortController()
  const seen = []
  const run = harness.waterfall({ agent: { id: 's1' }, toolName: 'bash', callId: 'c1', signal: controller.signal }, () => {
    seen.push('answerer')
    return new Promise((resolve) => {
      setTimeout(() => resolve('allowed-once'), 30)
    })
  })

  // The listener ran synchronously ahead of the answerer.
  check('answerer was reached', seen.length === 1)

  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('the open request is pending', snapshot.body.pending.length === 1)
  check('the pending entry carries the tool name as its label', snapshot.body.pending[0].label === 'bash', String(snapshot.body.pending[0].label))
  check('the pending entry is tagged as an approval', snapshot.body.pending[0].kind === 'approval', String(snapshot.body.pending[0].kind))
  check('the pending entry has an opaque id', typeof snapshot.body.pending[0].id === 'string' && snapshot.body.pending[0].id.length > 0)

  controller.abort()
  const outcome = await run
  check('the waterfall outcome passes through untouched', outcome === 'allowed-once', String(outcome))

  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('the settled request leaves the pending set', snapshot.body.pending.length === 0)

  const diagnostics = await harness.request('/api/dsh-approval-sound/diagnostics')
  // One request produces two log lines: the accept and its close.
  check('the diagnostics log records the request and its close', diagnostics.body.log.length === 2, JSON.stringify(diagnostics.body.log))
  check('the accept line has no close timestamp', diagnostics.body.log[0]?.closedAt === undefined)
  check('the close line carries the close timestamp', diagnostics.body.log[1]?.closedAt !== undefined)
  check('the close line records the outcome', diagnostics.body.log[1]?.outcome === 'closed')
  check('the listener ran once', diagnostics.body.observed === 1)

  // A request with no signal at all: closing must still happen on settle.
  const run2 = harness.waterfall({ agent: { id: 's1' }, toolName: 'write' }, () => Promise.resolve('rejected'))
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('a signal-less request is tracked while open', snapshot.body.pending.length === 1)
  await run2
  await new Promise((resolve) => setTimeout(resolve, 0))
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('a signal-less request closes when the answerer settles', snapshot.body.pending.length === 0)

  // A request that is already aborted must never be reported as pending.
  const already = new AbortController()
  already.abort()
  await harness.waterfall({ agent: { id: 's1' }, toolName: 'edit', signal: already.signal }, () => Promise.resolve('cancelled'))
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('an already-aborted request is never pending', snapshot.body.pending.length === 0)

  // A missing toolName degrades to `unknown` rather than throwing.
  const run4 = harness.waterfall({ agent: { id: 's1' } }, () => Promise.resolve('unavailable'))
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('a nameless request is labelled unknown', snapshot.body.pending[0]?.label === 'unknown', String(snapshot.body.pending[0]?.label))
  await run4

  // Three concurrent requests are all visible at once.
  const gates = []
  const concurrent = [1, 2, 3].map((n) => harness.waterfall(
    { agent: { id: 's1' }, toolName: `tool${n}` },
    () => new Promise((resolve) => gates.push(() => resolve('allowed-once'))),
  ))
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('concurrent requests are all pending', snapshot.body.pending.length === 3, String(snapshot.body.pending.length))
  check('pending ids are unique', new Set(snapshot.body.pending.map((p) => p.id)).size === 3)
  for (const gate of gates) gate()
  await Promise.all(concurrent)

  // A throwing sibling answerer must not leave an entry behind.
  let threw = false
  try {
    await harness.waterfall({ agent: { id: 's1' }, toolName: 'boom' }, () => { throw new Error('answerer blew up') })
  } catch {
    threw = true
  }
  check('a throwing answerer still propagates', threw)
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('a throwing answerer leaves nothing pending', snapshot.body.pending.length === 0)
}

console.log('\ncustom audio')
{
  const harness = makeCtx()
  apply(harness.ctx, {})

  const soundPath = '/api/dsh-approval-sound/sound'

  // Nothing installed yet.
  let read = await harness.request(soundPath, { binary: true })
  check('the sound route 404s with no upload', read.status === 404)

  // A wrongly labelled file is rejected: the extension and the bytes must agree.
  const liar = await harness.request(soundPath, {
    method: 'POST',
    binary: true,
    headers: { 'x-dsh-sound-name': encodeURIComponent('alert.mp3') },
    body: wavClip(64),
  })
  check('a mislabelled upload is rejected', liar.status === 400, `${liar.status} ${liar.body?.error ?? 'no error field'}`)
  check('the rejection names the mismatch', /does not look like/.test(liar.body?.error ?? ''), String(liar.body?.error))

  // An unsupported extension is rejected before the bytes are even considered.
  const unsupported = await harness.request(soundPath, {
    method: 'POST',
    binary: true,
    headers: { 'x-dsh-sound-name': encodeURIComponent('alert.txt') },
    body: Buffer.from('not audio at all'),
  })
  check('an unsupported extension is rejected', unsupported.status === 400)
  check('the rejection lists the accepted formats', /wav/.test(unsupported.body?.error ?? ''))

  // An empty body is rejected.
  const empty = await harness.request(soundPath, {
    method: 'POST',
    binary: true,
    headers: { 'x-dsh-sound-name': encodeURIComponent('alert.wav') },
    body: Buffer.alloc(0),
  })
  check('an empty upload is rejected', empty.status === 400)

  // A real WAV-shaped upload is accepted.
  const clip = wavClip(900)
  const uploaded = await harness.request(soundPath, {
    method: 'POST',
    binary: true,
    headers: { 'x-dsh-sound-name': encodeURIComponent('我的提示音.wav') },
    body: clip,
  })
  check('a valid WAV upload answers 200', uploaded.status === 200, JSON.stringify(uploaded.body))
  check('the upload selects the custom voice', uploaded.body.config.sound === 'custom')
  check('the upload records the file name', uploaded.body.config.customName === 'custom.wav')
  check('the upload records the byte count', uploaded.body.config.customBytes === clip.length, `${uploaded.body.config.customBytes} vs ${clip.length}`)
  check('the upload records a timestamp', uploaded.body.config.customAt > 0)

  // …and comes back byte-identical, with a real content type.
  read = await harness.request(soundPath, { binary: true })
  check('the stored sound is served with 200', read.status === 200)
  check('the stored sound is byte-identical', Buffer.compare(read.bytes, clip) === 0)
  check('the stored sound carries an audio content type', read.headers?.['content-type'] === 'audio/wav', String(read.headers?.['content-type']))
  check('the stored sound is not sniffable', read.headers?.['x-content-type-options'] === 'nosniff')

  // Replacing with another format must leave exactly one file behind.
  const mp3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03]), Buffer.alloc(300, 7)])
  const replaced = await harness.request(soundPath, {
    method: 'POST',
    binary: true,
    headers: { 'x-dsh-sound-name': encodeURIComponent('new-alert.mp3') },
    body: mp3,
  })
  check('replacing with an mp3 answers 200', replaced.status === 200, JSON.stringify(replaced.body))
  check('the replacement updates the name', replaced.body.config.customName === 'custom.mp3')

  const listing = await readdir(join(sandboxHome, 'dsh-approval-sound'))
  const customFiles = listing.filter((name) => name.startsWith('custom.'))
  check('exactly one custom file survives a format change', customFiles.length === 1, JSON.stringify(listing))

  read = await harness.request(soundPath, { binary: true })
  check('the replacement is the bytes served', Buffer.compare(read.bytes, mp3) === 0)
  check('the replacement content type follows the new format', read.headers?.['content-type'] === 'audio/mpeg')

  // A restart must re-derive the metadata from the file on disk, not from the
  // config document, so a tampered config cannot invent an alert.
  await writeConfig({
    sound: 'custom',
    customName: 'custom.flac',
    customBytes: 999,
  })
  const rebooted = makeCtx()
  apply(rebooted.ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  const after = await rebooted.request('/api/dsh-approval-sound/pending')
  check('a restart reconciles the name from disk', after.body.config.customName === 'custom.mp3', String(after.body.config.customName))
  check('a restart reconciles the size from disk', after.body.config.customBytes === mp3.length, String(after.body.config.customBytes))

  // Deletion clears the file, the metadata, and a now-dangling selection.
  const removed = await harness.request(soundPath, { method: 'DELETE', binary: true })
  check('deleting the sound answers 200', removed.status === 200)
  check('deletion clears the name', removed.body.config.customName === '')
  check('deletion clears the byte count', removed.body.config.customBytes === 0)
  check('deletion falls back to a voice that exists', removed.body.config.sound === 'alert', String(removed.body.config.sound))

  read = await harness.request(soundPath, { binary: true })
  check('the sound route 404s again after deletion', read.status === 404)
  const listingAfter = await readdir(join(sandboxHome, 'dsh-approval-sound'))
  check('no custom file outlives the deletion', listingAfter.filter((name) => name.startsWith('custom.')).length === 0)

  // The write path is fenced and method-checked like every other route.
  const remote = await harness.request(soundPath, {
    method: 'POST',
    binary: true,
    headers: { 'x-dsh-sound-name': encodeURIComponent('x.wav'), host: '192.168.1.9:19387' },
    body: wavClip(64),
  })
  check('a non-loopback upload is a 403', remote.status === 403)
  const badMethod = await harness.request(soundPath, { method: 'PATCH', binary: true })
  check('an unsupported method on the sound route is a 405', badMethod.status === 405)
}

console.log('\nquestion seam (user-questions/request)')
{
  const harness = makeCtx()
  apply(harness.ctx, {})

  // A question panel is the seam a user actually sees when the harness asks
  // them something — and the one an approval-only plugin silently misses.
  let release
  const held = harness.waterfall(
    { questions: [{ id: 'q1', header: '确认弹窗类型', question: '你看到的弹窗长什么样？' }], signal: undefined },
    () => new Promise((resolve) => { release = resolve }),
    'user-questions/request',
  )

  let snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('a question panel becomes pending', snapshot.body.pending.length === 1, JSON.stringify(snapshot.body.pending))
  check('the pending entry is tagged as a question', snapshot.body.pending[0]?.kind === 'question', String(snapshot.body.pending[0]?.kind))
  check('the pending entry carries the header as its label', snapshot.body.pending[0]?.label === '确认弹窗类型', String(snapshot.body.pending[0]?.label))

  const diagnostics = await harness.request('/api/dsh-approval-sound/diagnostics')
  check('the question seam is tallied separately', diagnostics.body.observedBySeam.question === 1, JSON.stringify(diagnostics.body.observedBySeam))
  check('the approval seam is untouched', diagnostics.body.observedBySeam.approval === 0, JSON.stringify(diagnostics.body.observedBySeam))
  check('the diagnostics list both watched seams', Array.isArray(diagnostics.body.seams) && diagnostics.body.seams.includes('user-questions/request'), JSON.stringify(diagnostics.body.seams))

  release({ answers: [{ id: 'q1', selected: ['1'] }] })
  await held
  await new Promise((resolve) => setTimeout(resolve, 0))
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('an answered question leaves the pending set', snapshot.body.pending.length === 0)

  // A plan review is a question with a decision attached, and must be labelled
  // so the page can give it its own voice.
  const plan = harness.waterfall(
    { questions: [{ id: 'p1', question: 'approve this plan?', intent: { kind: 'plan-review', approve: 'yes' } }] },
    () => Promise.resolve({ answers: [] }),
    'user-questions/request',
  )
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('a plan review is labelled plan-review', snapshot.body.pending[0]?.label === 'plan-review', String(snapshot.body.pending[0]?.label))
  await plan

  // A signal-carrying question closes on abort, exactly like an approval.
  const controller = new AbortController()
  const abortable = harness.waterfall(
    { questions: [{ id: 'q2', question: 'still there?' }], signal: controller.signal },
    () => new Promise((resolve) => setTimeout(() => resolve({ answers: [] }), 20)),
    'user-questions/request',
  )
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('a signal-carrying question is pending', snapshot.body.pending.length === 1)
  controller.abort()
  await abortable
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('an aborted question leaves the pending set', snapshot.body.pending.length === 0)

  // A signal that is supplied but never aborts must not strand the entry: the
  // answerer settling is an equally valid close edge, and wiring only the signal
  // would show the user a phantom pending prompt for the whole stale TTL.
  const neverAborts = new AbortController()
  const settledOnly = harness.waterfall(
    { questions: [{ id: 'q3', question: 'settles without aborting?' }], signal: neverAborts.signal },
    () => Promise.resolve({ answers: [] }),
    'user-questions/request',
  )
  await settledOnly
  await new Promise((resolve) => setTimeout(resolve, 0))
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('an answerer settling closes a signal-carrying entry', snapshot.body.pending.length === 0, JSON.stringify(snapshot.body.pending))
  check('that signal really never aborted', neverAborts.signal.aborted === false)

  // Both seams are observed independently in one composition.
  await harness.waterfall({ toolName: 'bash' }, () => Promise.resolve('allowed-once'))
  const both = await harness.request('/api/dsh-approval-sound/diagnostics')
  check('both seams are observed side by side', both.body.observedBySeam.approval === 1 && both.body.observedBySeam.question === 4, JSON.stringify(both.body.observedBySeam))
}

console.log('\nroutes and fences')
{
  // Start from nothing: an earlier section leaves its own persisted config and
  // an uploaded clip in the shared sandbox home, and this section asserts on
  // loader-provided defaults.
  await rm(join(sandboxHome, 'dsh-approval-sound'), { recursive: true, force: true })
  const harness = makeCtx()
  apply(harness.ctx, { enabled: false, sound: 'bell' })

  let snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('loader config is reflected in the document', snapshot.body.enabled === false)
  check('loader config reaches the sound field', snapshot.body.config.sound === 'bell')

  const written = await harness.request('/api/dsh-approval-sound/config', {
    method: 'POST',
    body: JSON.stringify({ volume: 0.25, sound: 'drop', repeat: 4 }),
  })
  check('config POST answers 200', written.status === 200)
  check('config POST echoes the new volume', written.body.config.volume === 0.25)
  check('config POST echoes the new sound', written.body.config.sound === 'drop')
  check('config POST clamps repeat', written.body.config.repeat === 4)

  const bad = await harness.request('/api/dsh-approval-sound/config', { method: 'POST', body: '{oops' })
  check('a malformed body is a 400', bad.status === 400)

  const wrongMethod = await harness.request('/api/dsh-approval-sound/config')
  check('GET on the config route is a 405', wrongMethod.status === 405)

  const diagWrongMethod = await harness.request('/api/dsh-approval-sound/diagnostics', { method: 'POST' })
  check('POST on the diagnostics route is a 405', diagWrongMethod.status === 405)

  const pendingWrongMethod = await harness.request('/api/dsh-approval-sound/pending', { method: 'POST' })
  check('POST on the pending route is a 405', pendingWrongMethod.status === 405)

  const remote = await harness.request('/api/dsh-approval-sound/pending', { headers: { host: '192.168.1.9:19387' } })
  check('a non-loopback Host header is a 403', remote.status === 403)

  const crossSite = await harness.request('/api/dsh-approval-sound/pending', { headers: { 'sec-fetch-site': 'cross-site' } })
  check('a cross-site fetch is a 403', crossSite.status === 403)

  // A second apply must not double-register or double-observe.
  apply(harness.ctx, {})
  const before = (await harness.request('/api/dsh-approval-sound/diagnostics')).body.observed
  await harness.waterfall({ agent: { id: 's2' }, toolName: 'bash' }, () => Promise.resolve('allowed-once'))
  const after = (await harness.request('/api/dsh-approval-sound/diagnostics')).body.observed
  check('a duplicate apply does not double-register', after - before === 1, `${before} -> ${after}`)
}

console.log('\ndisposal')
{
  const harness = makeCtx()
  apply(harness.ctx, {})
  // A held answerer: the request is open for the whole check, then released so
  // the process can exit cleanly.
  let release
  const held = harness.waterfall({ agent: { id: 's1' }, toolName: 'bash' }, () => new Promise((resolve) => { release = resolve }))
  let snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('a held request is pending', snapshot.body.pending.length === 1)
  for (const dispose of harness.effects) dispose()
  snapshot = await harness.request('/api/dsh-approval-sound/pending')
  check('disposal clears the pending set', snapshot.body.pending.length === 0)
  release('allowed-once')
  const outcome = await held
  check('a disposed watcher still returns the answerer outcome', outcome === 'allowed-once')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} FAILED`)
  process.exitCode = 1
}

await rm(sandboxHome, { recursive: true, force: true }).catch(() => {})
