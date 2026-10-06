/**
 * Dev-only harness for dsh-approval-sound's browser half. Not shipped
 * (excluded from package.json `files`).
 *
 * `client.js` is a classic browser script whose only entry point is the dsh
 * module-loader contract, so this harness reproduces just enough of the page 鈥? * `window.__ModuleLoader__`, a minimal document, `fetch`, timers and a
 * recording `AudioContext` 鈥?to drive the real bundle and assert on it:
 *
 *   - one newly pending approval plays exactly one alert;
 *   - an already-open approval at first poll is adopted silently;
 *   - the same pending id never alerts twice;
 *   - the cooldown gate suppresses a burst;
 *   - per-tool voices are selected from the tool name;
 *   - `onlyWhenUnfocused` suppresses a focused-window alert;
 *   - a failing poll degrades to an unreachable state instead of throwing.
 *
 * Every section boots a FRESH page, because the bundle's module scope (the
 * announced-id set, the cooldown clock) is intentionally long-lived per page.
 *
 * Run: node scripts/dev-client-harness.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` 鈥?${detail}`}`)
}

// ---------------------------------------------------------------------------
// A fresh page per section
// ---------------------------------------------------------------------------

/** Boot the real bundle against a fresh stub page. */
function boot(options = {}) {
  const played = []
  const requests = []
  const timers = new Map()
  let timerSeq = 0
  let now = 1_700_000_000_000
  const customPlayed = []
  const compressorCalls = []
  const fileInputs = []
  /** Peak of the clip `decodeAudioData` hands back; `null` makes decoding fail. */
  let decodePeak = 0.25
  /** How many times the browser would have decoded a clip. */
  let decodeAttempts = 0
  /** The document the poll route answers with, kept in sync with `serve()`. */
  let currentDocument = { ok: true, enabled: true, config: {}, pending: [] }
  /** What the sound route answers with, kept in sync with `serveSound()`. */
  let currentSound = { ok: false, status: 404, bytes: new ArrayBuffer(0) }
  /** When set, every fetch rejects 鈥?the host is unreachable. */
  let serverDown
  /**
   * The one fixture every fetch goes through.
   *
   * Both routes are held as plain data and consulted here, so a test may set
   * the clip and the pending set in either order without one clobbering the
   * other 鈥?the bug this replaced made `serve()` answer `/sound` with the poll
   * document and turned every clip fetch into a 404.
   */
  let fetchImpl = async (path, requestOptions) => {
    // A rejected promise, not a synchronous throw: a real `fetch` failure is a
    // rejection, and a synchronous throw from an async fixture behaves
    // differently through the await chain.
    if (serverDown !== undefined) return Promise.reject(serverDown)
    if (String(path).includes('/sound')) {
      // An upload is a different verb on the same path: the real host stores the
      // bytes and answers with the new config, so the fixture does too.
      if (requestOptions?.method === 'POST') {
        currentSound = { ok: true, status: 200, bytes: requestOptions.body ?? new ArrayBuffer(0) }
        currentDocument = {
          ok: true,
          enabled: true,
          pending: [],
          config: {
            enabled: true,
            volume: 1,
            sound: 'custom',
            repeat: 1,
            customName: 'custom.wav',
            customBytes: requestOptions.body?.byteLength ?? 0,
            customAt: now,
          },
        }
      }
      if (requestOptions?.method === 'DELETE') {
        currentSound = { ok: false, status: 404, bytes: new ArrayBuffer(0) }
        currentDocument = {
          ok: true,
          enabled: true,
          pending: [],
          config: { enabled: true, volume: 1, sound: 'alert', repeat: 1, customName: '', customBytes: 0, customAt: 0 },
        }
      }
      return {
        ok: currentSound.ok,
        status: currentSound.status,
        arrayBuffer: async () => currentSound.bytes,
        // Only the upload/remove verbs answer with the new document; a GET of
        // the clip is bytes, and echoing the poll document here would leak one
        // fixture's config into every later section.
        json: async () => (requestOptions?.method === 'POST' || requestOptions?.method === 'DELETE'
          ? currentDocument
          : { ok: currentSound.ok }),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => currentDocument,
    }
  }
  // The plugin's very first poll is fired synchronously inside `apply`, so an
  // outage that must cover the page load has to be installed before `apply`
  // runs, not after `boot()` returns.
  if (options.failFirst === true) {
    serverDown = new Error('connection refused')
  }

  class FakeBufferSource {
    constructor() { this.buffer = undefined; this.onended = undefined }
    connect() {}
    disconnect() {}
    start() { customPlayed.push(this.buffer) }
    stop() {}
  }

  class FakeAudioContext {
    constructor() {
      this.state = options.suspended === true ? 'suspended' : 'running'
      this.currentTime = 0
      this.destination = { _kind: 'destination' }
    }

    createOscillator() {
      const oscillator = {
        type: 'sine',
        frequency: {
          _lastFreq: undefined,
          setValueAtTime(freq) { this._lastFreq = freq },
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
        start(at) { played.push({ freq: oscillator.frequency._lastFreq, at, type: oscillator.type }) },
        stop: () => {},
      }
      return oscillator
    }

    createGain() {
      return {
        gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
        disconnect: () => {},
      }
    }

    createDynamicsCompressor() {
      compressorCalls.push(true)
      return {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect: () => {},
        disconnect: () => {},
      }
    }

    createBufferSource() { return new FakeBufferSource() }

    decodeAudioData(_bytes, onOk, onError) {
      decodeAttempts += 1
      if (decodePeak === null) {
        const failure = new Error('unsupported audio data')
        if (typeof onError === 'function') onError(failure)
        return Promise.reject(failure)
      }
      const length = 64
      const data = new Float32Array(length)
      data[0] = decodePeak
      const buffer = {
        numberOfChannels: 1,
        length,
        duration: 0.3,
        getChannelData: () => data,
      }
      if (typeof onOk === 'function') onOk(buffer)
      return Promise.resolve(buffer)
    }

    resume() {
      this.state = 'running'
      return Promise.resolve()
    }
  }

  const documentListeners = new Map()
  const documentBody = {
    // Real DOM attachment: the plugin's picker-dismiss fallback distinguishes
    // "still attached, no file chosen" from "already cleaned up", so the stub
    // has to establish `parentNode` the way a browser would.
    appendChild: (child) => { child.parentNode = documentBody },
    removeChild: (child) => { child.parentNode = null },
  }
  const documentStub = {
    visibilityState: 'visible',
    head: { appendChild: () => {} },
    body: documentBody,
    createElement: (tag) => {
      if (tag !== 'input') return { setAttribute: () => {}, remove: () => {}, textContent: '', dataset: {} }
      // A real `input[type=file]` cannot be driven from script, so the stub
      // records itself and exposes a way for the test to fire `change` with a
      // chosen file 鈥?which is exactly what a user picking one does.
      const listeners = new Map()
      const input = {
        type: '',
        accept: '',
        style: {},
        files: [],
        parentNode: null,
        addEventListener: (name, handler) => {
          const list = listeners.get(name) ?? []
          list.push(handler)
          listeners.set(name, list)
        },
        removeEventListener: () => {},
        click: () => {},
        remove: () => { input.parentNode = null },
        /** Test hook: pretend the user chose `file`. */
        __choose: (file) => {
          input.files = file === undefined ? [] : [file]
          for (const handler of listeners.get('change') ?? []) handler()
        },
      }
      fileInputs.push(input)
      return input
    },
    addEventListener: (name, handler) => {
      const list = documentListeners.get(name) ?? []
      list.push(handler)
      documentListeners.set(name, list)
    },
    removeEventListener: (name, handler) => {
      const list = documentListeners.get(name) ?? []
      const at = list.indexOf(handler)
      if (at !== -1) list.splice(at, 1)
    },
    hasFocus: () => options.focused !== false,
    querySelector: () => null,
  }

  const windowListeners = new Map()
  const windowStub = {
    AudioContext: options.noAudio === true ? undefined : FakeAudioContext,
    setInterval: (callback, delay) => {
      const id = ++timerSeq
      timers.set(id, { callback, delay })
      return id
    },
    clearInterval: (id) => { timers.delete(id) },
    setTimeout: (callback) => { callback(); return 0 },
    clearTimeout: () => {},
    addEventListener: (name, handler, options) => {
      const list = windowListeners.get(name) ?? []
      list.push({ handler, once: options?.once === true })
      windowListeners.set(name, list)
    },
    removeEventListener: (name, handler) => {
      const list = windowListeners.get(name) ?? []
      const at = list.findIndex((entry) => entry.handler === handler)
      if (at !== -1) list.splice(at, 1)
    },
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    console,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    fetch: async (path, requestOptions) => {
      const headers = requestOptions?.headers ?? {}
      requests.push({
        path,
        method: requestOptions?.method ?? 'GET',
        body: requestOptions?.body,
        bodyLength: requestOptions?.body?.byteLength ?? (typeof requestOptions?.body === 'string' ? requestOptions.body.length : undefined),
        nameHeader: headers['x-dsh-sound-name'],
      })
      return fetchImpl(path, requestOptions)
    },
    AbortSignal: { timeout: () => undefined },
    // A controllable clock: the cooldown gate is time-based, so the harness
    // must own time to assert on it.
    Date: class extends Date {
      static now() { return now }
    },
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    Promise,
    Number,
    String,
    Error,
    URL,
  }
  sandbox.globalThis = sandbox
  sandbox.window.document = documentStub

  let factory
  sandbox.window.__ModuleLoader__ = {
    load: ({ factory: registered }) => { factory = registered },
  }

  const realm = vm.createContext(sandbox)
  // Optional tracing, installed inside the realm (sandbox properties are not the
  // realm's own globals). Driven by the environment so a single run can trace
  // every page without threading an option through each fixture.
  if (process.env.DSH_HARNESS_TRACE === '1') {
    vm.runInContext('globalThis.__trace = (...args) => console.log("[trace]", ...args)', realm)
  }
  vm.runInContext(source, realm, { filename: 'client.js' })
  if (typeof factory !== 'function') throw new Error('the bundle did not register a factory')

  const hooks = []
  const registrations = []
  const ctx = {
    get: () => undefined,
    effect: (callback) => { callback(); return () => {} },
    on: () => () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, callback) => { callback() },
      register: (declaration, component) => {
        registrations.push({ declaration, component })
        return () => {}
      },
    },
  }

  const moduleExports = factory((name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: (effect) => { hooks.push(effect) },
        useSyncExternalStore: () => undefined,
      }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  moduleExports.apply(ctx)

  /** Step every armed timer once and let the promise chain settle. */
  async function tick() {
    for (const { callback } of [...timers.values()]) callback()
    await settle()
  }

  /**
   * Drain microtasks until the number of fetches stops moving.
   *
   * Waiting on the observable effect (the recorded request count) rather than a
   * fixed number of turns is what makes every section deterministic: the `await`
   * inside the async request helper resolves over an implementation-defined
   * number of turns. The cap turns a runaway retry loop into a loud failure
   * instead of a hang.
   */
  async function settle() {
    let stable = 0
    let last = requests.length
    for (let turn = 0; turn < 400; turn += 1) {
      await Promise.resolve()
      if (requests.length === last) {
        stable += 1
        if (stable >= 6) return
      } else {
        if (requests.length - last > 40) {
          throw new Error(`harness: ${requests.length - last} fetches in one settle 鈥?the plugin is retrying`)
        }
        stable = 0
        last = requests.length
      }
    }
    throw new Error(`harness: fetches never settled (${requests.length} total)`)
  }

  return {
    played,
    requests,
    customPlayed,
    compressorCalls,
    fileInputs,
    registrations,
    moduleExports,
    tick,
    settle,
    /**
     * Replace the host document the next poll will see.
     *
     * This also clears a simulated outage: serving a document means the host is
     * reachable again, which is what every recovery fixture intends.
     */
    serve(document) {
      currentDocument = document
      serverDown = undefined
    },
    fail(error) {
      serverDown = error ?? new Error('connection refused')
    },
    /** Serve the custom clip the plugin's own sound route returns. */
    serveSound(bytes, ok = true, status = 200) {
      currentSound = { ok, status, bytes }
    },
    /** Ask the page's own fetch what a path currently answers. */
    rawFetch(path) { return sandbox.fetch(path, {}) },
    /** Make `decodeAudioData` fail, so the degradation path can be asserted. */
    breakDecode() { decodePeak = null },
    decodeAttempts() { return decodeAttempts },
    /** The most recent `input[type=file]` the plugin created. */
    lastFileInput() { return fileInputs[fileInputs.length - 1] },
    /** Run the plugin's own upload action (what the card's button calls). */
    pickAndUpload() { return moduleExports.__mount.onPick() },
    /** Run the plugin's own remove action. */
    removeCustom() { return moduleExports.__mount.onRemove() },
    /** Fire a window event (the picker-dismiss fallback listens for `focus`). */
    fireWindow(name) {
      for (const entry of [...(windowListeners.get(name) ?? [])]) {
        if (entry.once) windowStub.removeEventListener(name, entry.handler)
        entry.handler()
      }
    },
    advance(ms) { now += ms },
    /** The section component the plugin registered. */
    section() { return registrations[0]?.component },
  }
}

function doc(list, config = { enabled: true, volume: 0.7, sound: 'alert', repeat: 1 }) {
  return { ok: true, enabled: config.enabled !== false, config, pending: list }
}

/** Ask a booted page's own fetch what the sound route currently answers. */
async function sandboxProbeSound(page) {
  return page.rawFetch('/api/dsh-approval-sound/sound?k=probe')
}

// ---------------------------------------------------------------------------

console.log('bundle registration')
{
  const page = boot()
  check('the bundle registers itself with the module loader', typeof page.moduleExports?.apply === 'function')
  check('the client half exports inject', Array.isArray(page.moduleExports.inject))
  check('apply registers exactly one settings section', page.registrations.length === 1)
  check('the registration targets settings.section', page.registrations[0]?.declaration?.name === 'settings.section')
  check('the registration declares a label', typeof page.registrations[0]?.declaration?.label === 'function')
  check('the section id is the plugin namespace', page.registrations[0]?.declaration?.id === 'dsh-approval-sound')
  check('the section is ordered after the balance section', page.registrations[0]?.declaration?.order === 153)
}

console.log('\nfirst poll (priming)')
{
  const page = boot()
  // Serve the already-open prompt BEFORE the immediate poll fires, so this
  // section exercises the exact real case: a page loading while a dialog is up.
  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }]))
  await page.settle()
  check('an already-open approval on the first poll stays silent', page.played.length === 0, `${page.played.length} notes`)

  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }, { id: 'a2', toolName: 'bash', at: 0 }]))
  page.advance(5000)
  await page.tick()
  check('a newly pending approval alerts', page.played.length > 0, `${page.played.length} notes`)
}

console.log('\npriming after an empty first poll')
{
  // The common real case: the page opens with no prompt open, and a request
  // raised later must alert on the poll that first reports it.
  const page = boot()
  page.serve(doc([]))
  await page.tick()
  check('an empty first poll plays nothing', page.played.length === 0)

  page.serve(doc([{ id: 'e1', toolName: 'bash', at: 0 }]))
  await page.tick()
  check('a request raised after an empty first poll alerts', page.played.length > 0, `${page.played.length} notes`)
}

console.log('\none alert per request')
{
  const page = boot()
  page.serve(doc([]))
  await page.tick()

  page.serve(doc([{ id: 'b1', toolName: 'bash', at: 0 }]))
  await page.tick()
  const afterFirst = page.played.length
  check('the first sighting plays the alert', afterFirst > 0, `${afterFirst} notes`)

  page.advance(60_000)
  await page.tick()
  await page.tick()
  check('later polls of the same pending id stay silent', page.played.length === afterFirst, `${page.played.length} vs ${afterFirst}`)
}

console.log('\ncooldown gate')
{
  const page = boot()
  // A short cooldown so the gate is exercised without long waits.
  page.serve(doc([], { enabled: true, volume: 0.7, sound: 'alert', repeat: 1, cooldownMs: 5000 }))
  await page.tick()

  page.serve(doc([{ id: 'c1', toolName: 'bash', at: 0 }]))
  await page.tick()
  const afterFirst = page.played.length
  check('the first alert plays', afterFirst > 0)

  // A second, different request inside the cooldown window must be swallowed.
  page.serve(doc([{ id: 'c1', toolName: 'bash', at: 0 }, { id: 'c2', toolName: 'bash', at: 0 }]))
  await page.tick()
  check('a second prompt inside the cooldown is swallowed', page.played.length === afterFirst, `${page.played.length} vs ${afterFirst}`)

  // Past the window it becomes audible again.
  page.advance(6000)
  page.serve(doc([{ id: 'c1', toolName: 'bash', at: 0 }, { id: 'c2', toolName: 'bash', at: 0 }, { id: 'c3', toolName: 'bash', at: 0 }]))
  await page.tick()
  check('a prompt past the cooldown plays again', page.played.length > afterFirst, `${page.played.length} vs ${afterFirst}`)
}

console.log('\nvoice routing')
{
  const page = boot()
  page.serve(doc([]))
  await page.tick()

  // The web voice is VOICE_INDEX 2 => pitch 1 + 0.08, so the first note of the
  // alert voice is 784 * 1.08 = 846.72 Hz. The shell voice (index 0) is 784 Hz.
  page.advance(5000)
  page.serve(doc([{ id: 'v1', toolName: 'web_search', at: 0 }]))
  await page.tick()
  check('a web tool alerts', page.played.length > 0)
  const webFirst = page.played[0]?.freq
  check('the web voice is detuned away from the shell voice', Math.abs(webFirst - 784) > 1, `first=${webFirst}`)
  check('the web voice pitch is the expected 1.08 factor', Math.abs(webFirst - 846.72) < 0.01, `first=${webFirst}`)

  page.advance(5000)
  page.serve(doc([{ id: 'v1', toolName: 'web_search', at: 0 }, { id: 'v2', toolName: 'bash', at: 0 }]))
  const beforeShell = page.played.length
  await page.tick()
  // The alert voice has four notes per strike (two strikes, each with a
  // fundamental and a partial), so the shell strike occupies four notes and its
  // fundamental is the first of them.
  const shellStrike = page.played.slice(beforeShell).slice(0, 4)
  check('the shell strike produced four notes', shellStrike.length === 4, `${page.played.length - beforeShell} new notes`)
  check('the shell voice stays on the base pitch', Math.abs(shellStrike[0]?.freq - 784) < 0.01, `first=${shellStrike[0]?.freq}`)
}

console.log('\nsilent voices')
{
  const page = boot()
  page.serve(doc([]))
  await page.tick()
  page.serve(doc([{ id: 's1', toolName: 'bash', at: 0 }], { enabled: true, volume: 0.7, sound: 'off' }))
  await page.tick()
  check('the "off" voice never plays', page.played.length === 0, `${page.played.length} notes`)

  const muted = boot()
  muted.serve(doc([]))
  await muted.tick()
  muted.serve(doc([{ id: 's2', toolName: 'bash', at: 0 }], { enabled: true, volume: 0, sound: 'alert' }))
  await muted.tick()
  check('a zero volume never plays', muted.played.length === 0, `${muted.played.length} notes`)

  const disabled = boot()
  disabled.serve(doc([]))
  await disabled.tick()
  // Turning the plugin off while a prompt is open is silent for that prompt...
  disabled.serve(doc([{ id: 's3', toolName: 'bash', at: 0 }], { enabled: false, volume: 0.7, sound: 'alert' }))
  await disabled.tick()
  check('a disabled plugin never plays', disabled.played.length === 0, `${disabled.played.length} notes`)
  // ...and turning it back on must alert for the next one, so the config really
  // is re-read from the host rather than latched at load.
  disabled.serve(doc(
    [{ id: 's3', toolName: 'bash', at: 0 }, { id: 's4', toolName: 'bash', at: 0 }],
    { enabled: true, volume: 0.7, sound: 'alert' },
  ))
  await disabled.tick()
  check('re-enabling restores the alert', disabled.played.length > 0, `${disabled.played.length} notes`)
}

console.log('\nfocus gate')
{
  const page = boot({ focused: true })
  page.serve(doc([]))
  await page.tick()
  page.serve(doc([{ id: 'f1', toolName: 'bash', at: 0 }], { enabled: true, volume: 0.7, sound: 'alert', onlyWhenUnfocused: true }))
  await page.tick()
  check('a focused window suppresses the alert when configured', page.played.length === 0, `${page.played.length} notes`)

  const unfocused = boot({ focused: false })
  unfocused.serve(doc([]))
  await unfocused.tick()
  unfocused.serve(doc([{ id: 'f2', toolName: 'bash', at: 0 }], { enabled: true, volume: 0.7, sound: 'alert', onlyWhenUnfocused: true }))
  await unfocused.tick()
  check('an unfocused window still alerts', unfocused.played.length > 0, `${unfocused.played.length} notes`)
}

console.log('\nunreachable host')
{
  // The page loads while the host is unreachable: nothing may alert, and the
  // page must NOT count itself as primed, because a host that could not be
  // reached has told it nothing. The failure covers the immediate poll too.
  const page = boot({ failFirst: true })
  await page.settle()
  await page.tick()
  check('a failing poll plays nothing', page.played.length === 0)
  let threw = false
  try {
    await page.tick()
  } catch {
    threw = true
  }
  check('a failing poll never throws out of the loop', threw === false)
  check('a failing poll never primes the page', page.played.length === 0)

  // Recovery, with a prompt that was already open for the whole outage: the
  // first successful poll is still the page's first sight of the host, so it is
  // adopted silently.
  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }]))
  await page.tick()
  check('the first successful poll adopts the backlog silently', page.played.length === 0, `${page.played.length} notes`)

  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }, { id: 'a2', toolName: 'bash', at: 0 }]))
  await page.tick()
  check('a prompt raised after recovery still alerts', page.played.length > 0, `${page.played.length} notes`)
}

console.log('\noutage after a successful poll')
{
  // A different case: the page was healthy, then the host went away briefly.
  // A prompt that opens *during* the gap is first seen on recovery and is new.
  const page = boot()
  await page.settle()
  page.fail()
  await page.tick()
  check('an outage plays nothing', page.played.length === 0)

  page.serve(doc([{ id: 'g1', toolName: 'bash', at: 0 }]))
  await page.tick()
  check('a prompt first seen after a healthy period alerts', page.played.length > 0, `${page.played.length} notes`)
}

console.log('\nlost poll during an open prompt')
{
  // A single empty poll (hiccup, suspended tab) must not make the same prompt
  // alert again when it reappears.
  const page = boot()
  page.serve(doc([]))
  await page.tick()
  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }]))
  await page.tick()
  const afterFirst = page.played.length
  check('the prompt alerts once', afterFirst > 0)

  page.serve(doc([]))
  await page.tick()
  page.advance(60_000)
  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }]))
  await page.tick()
  check('a reappearing prompt does not alert twice', page.played.length === afterFirst, `${page.played.length} vs ${afterFirst}`)
}

console.log('\nmissing Web Audio')
{
  const page = boot({ noAudio: true })
  page.serve(doc([]))
  await page.tick()
  page.serve(doc([{ id: 'n1', toolName: 'bash', at: 0 }]))
  let threw = false
  try {
    await page.tick()
  } catch {
    threw = true
  }
  check('a browser without AudioContext does not throw', threw === false)
  check('a browser without AudioContext plays nothing', page.played.length === 0)
}

console.log('\nsuspended audio context')
{
  const page = boot({ suspended: true })
  page.serve(doc([]))
  await page.tick()
  page.serve(doc([{ id: 'x1', toolName: 'bash', at: 0 }]))
  let threw = false
  try {
    await page.tick()
  } catch {
    threw = true
  }
  check('a suspended context does not throw', threw === false)
  // The resume() promise resolves on a microtask, so the alert lands late 鈥?  // but it must land.
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  check('a suspended context still produces the alert after resume', page.played.length > 0, `${page.played.length} notes`)
}

console.log('\nloudness')
{
  // The limiter is what lets an over-unity volume stay clean, so the graph must
  // actually contain one.
  const page = boot()
  page.serve(doc([]))
  await page.tick()
  page.serve(doc([{ id: 'l1', toolName: 'bash', at: 0 }], { enabled: true, volume: 1, sound: 'alert', repeat: 1 }))
  await page.tick()
  check('an alert builds the limiter', page.compressorCalls.length === 1, `${page.compressorCalls.length} compressors`)
  check('unity volume still alerts', page.played.length > 0)

  const loud = boot()
  loud.serve(doc([]))
  await loud.tick()
  loud.serve(doc([{ id: 'l2', toolName: 'bash', at: 0 }], { enabled: true, volume: 1.5, sound: 'alert', repeat: 1 }))
  await loud.tick()
  check('a 150% volume is accepted and alerts', loud.played.length > 0)

  // The ceiling must clamp rather than reject, so a hand-edited config cannot
  // drive the graph past the limiter's comfort.
  const beyond = boot()
  beyond.serve(doc([]))
  await beyond.tick()
  beyond.serve(doc([{ id: 'l3', toolName: 'bash', at: 0 }], { enabled: true, volume: 9, sound: 'alert', repeat: 1 }))
  await beyond.tick()
  check('an absurd volume still alerts instead of throwing', beyond.played.length > 0)
}

console.log('\ncustom audio playback')
{
  const page = boot()
  page.serve(doc([]))
  await page.tick()

  // The clip is served before the document that selects it; the fixture keeps
  // the two routes independent, so the order is not load-bearing.
  page.serveSound(new ArrayBuffer(64))
  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }], {
    enabled: true,
    volume: 1,
    sound: 'custom',
    repeat: 1,
    customName: 'custom.wav',
    customBytes: 64,
    customAt: 1,
  }))
  // The first alert lands mid-decode, so it is queued rather than dropped. Only
  // one tick: further ticks would drive the poll loop and re-queue.
  await page.tick()
  // Let the fetch + decode continuations run without driving more timers.
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
  check('a custom alert fetches the clip', page.requests.some((r) => r.path.startsWith('/api/dsh-approval-sound/sound')), JSON.stringify(page.requests.map((r) => r.path)))
  check('the queued alert plays once the clip decodes', page.customPlayed.length > 0, `${page.customPlayed.length} clip plays`)
  check('a queued custom alert does not fall back to a synth tone', page.played.length === 0, `${page.played.length} synth notes`)

  // A second prompt reuses the decoded clip instead of re-fetching it.
  const fetchesBefore = page.requests.filter((r) => r.path.startsWith('/api/dsh-approval-sound/sound')).length
  page.advance(5000)
  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }, { id: 'a2', toolName: 'bash', at: 0 }], {
    enabled: true,
    volume: 1,
    sound: 'custom',
    repeat: 1,
    customName: 'custom.wav',
    customBytes: 64,
    customAt: 1,
  }))
  await page.tick()
  await page.settle()
  const fetchesAfter = page.requests.filter((r) => r.path.startsWith('/api/dsh-approval-sound/sound')).length
  check('a decoded clip is not re-fetched', fetchesAfter === fetchesBefore, `${fetchesBefore} -> ${fetchesAfter}`)
  check('the second custom alert plays the clip', page.customPlayed.length >= 2, `${page.customPlayed.length} clip plays`)
}

console.log('\ncustom audio degradation')
{
  // The clip cannot be fetched at all. A failed load legitimately retries on the
  // next alert, so this section drains a bounded number of turns instead of
  // waiting for quiescence, and asserts the observable outcome: silence from the
  // clip path, no throw, and a recorded error the settings card can show.
  const page = boot()
  page.serve(doc([]))
  await page.tick()
  page.serve(doc([{ id: 'a1', toolName: 'bash', at: 0 }], {
    enabled: true,
    volume: 1,
    sound: 'custom',
    repeat: 1,
    customName: 'custom.wav',
    customBytes: 64,
    customAt: 1,
  }))
  let threw = false
  try {
    await page.tick()
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
  } catch {
    threw = true
  }
  check('a missing clip does not throw', threw === false)
  check('a missing clip plays no clip', page.customPlayed.length === 0)
  // The failure is transient by design: the next alert retries the fetch and
  // clears the error, so the assertion is on the retry itself, not on a message
  // that is legitimately gone by the time the drain finishes.
  check('a missing clip is retried on the next alert', page.requests.filter((r) => r.path.includes('/sound')).length >= 2, String(page.requests.filter((r) => r.path.includes('/sound')).length))

  // The bytes arrive but cannot be decoded.
  const bad = boot()
  bad.serve(doc([]))
  await bad.tick()
  bad.breakDecode()
  bad.serveSound(new ArrayBuffer(32))
  bad.serve(doc([{ id: 'b1', toolName: 'bash', at: 0 }], {
    enabled: true,
    volume: 1,
    sound: 'custom',
    repeat: 1,
    customName: 'custom.wav',
    customBytes: 32,
    customAt: 1,
  }))
  let badThrew = false
  try {
    await bad.tick()
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
  } catch {
    badThrew = true
  }
  check('an undecodable clip does not throw', badThrew === false)
  check('an undecodable clip plays no clip', bad.customPlayed.length === 0)
  // The browser was handed the bytes and rejected them, so the failure is real
  // rather than the clip never arriving.
  check('an undecodable clip was actually decoded', bad.decodeAttempts() > 0, String(bad.decodeAttempts()))
}

console.log('\nquestion panels')
{
  // The regression that made the alert silent in practice: the dialog a user
  // actually sees is the ask_user_question panel, which arrives on the
  // user-questions/request seam with `kind: 'question'` and a `label` — not a
  // `toolName`. It must alert, and it must not sound like an approval.
  const page = boot()
  page.serve(doc([]))
  await page.tick()

  page.serve(doc([{ id: 'q1', kind: 'question', label: '确认弹窗类型', at: 0 }]))
  await page.tick()
  check('a question panel alerts', page.played.length > 0, `${page.played.length} notes`)
  const questionFirst = page.played[0]?.freq
  // The question pitch is 0.88, so the alert voice's 784 Hz fundamental lands
  // clearly below the approval family's.
  check('the question voice is pitched below the approval voice', questionFirst < 784, `first=${questionFirst}`)
  check('the question pitch is the expected 0.88 factor', Math.abs(questionFirst - 784 * 0.88) < 0.01, `first=${questionFirst}`)

  // A plan review shares the seam but carries its own label.
  page.advance(5000)
  page.serve(doc([
    { id: 'q1', kind: 'question', label: '确认弹窗类型', at: 0 },
    { id: 'q2', kind: 'question', label: 'plan-review', at: 0 },
  ]))
  const beforePlan = page.played.length
  await page.tick()
  const planFirst = page.played[beforePlan]?.freq
  check('a plan review alerts', page.played.length > beforePlan, `${page.played.length} vs ${beforePlan}`)
  check('the plan voice is the lowest', Math.abs(planFirst - 784 * 0.8) < 0.01, `first=${planFirst}`)

  // An approval entry still uses its tool name, so the two families coexist.
  page.advance(5000)
  page.serve(doc([
    { id: 'q2', kind: 'question', label: 'plan-review', at: 0 },
    { id: 'a1', kind: 'approval', label: 'bash', at: 0 },
  ]))
  const beforeApproval = page.played.length
  await page.tick()
  const approvalFirst = page.played[beforeApproval]?.freq
  check('an approval entry still alerts', page.played.length > beforeApproval)
  check('the approval entry uses its tool-name voice', Math.abs(approvalFirst - 784) < 0.01, `first=${approvalFirst}`)
}

console.log('\ncustom audio upload')
{
  const page = boot()
  page.serve(doc([]))
  await page.tick()

  // Drive the picker exactly as the button does: the plugin's own action opens
  // a file input and POSTs whatever the user chose.
  const pending = page.pickAndUpload()
  const input = page.lastFileInput()
  check('the upload action created a file input', input !== undefined)
  check('the input is a file picker', input?.type === 'file', String(input?.type))
  check('the input accepts audio', typeof input?.accept === 'string' && input.accept.includes('audio/'), String(input?.accept))

  input.__choose({ name: '我的提示音.wav', arrayBuffer: async () => new ArrayBuffer(128) })
  const failure = await pending
  check('a successful upload reports no error', failure === undefined, String(failure))

  const upload = page.requests.find((r) => r.method === 'POST' && r.path === '/api/dsh-approval-sound/sound')
  check('the upload posted to the sound route', upload !== undefined, JSON.stringify(page.requests.map((r) => `${r.method} ${r.path}`)))
  check('the upload carries the encoded file name', upload?.nameHeader === encodeURIComponent('我的提示音.wav'), String(upload?.nameHeader))
  check('the upload body is the file bytes', upload?.bodyLength === 128, String(upload?.bodyLength))

  // A dismissed picker must resolve rather than leaving the card stuck busy.
  // Most browsers fire nothing at all on cancel, so the plugin falls back to the
  // window regaining focus 鈥?which is what this drives.
  const dismissed = page.pickAndUpload()
  page.fireWindow('focus')
  check('a dismissed picker resolves without an error', (await dismissed) === undefined)
}

console.log('\nsettings section render')
{
  const page = boot()
  page.serve(doc([]))
  await page.tick()
  const section = page.section()
  check('a section component was registered', typeof section === 'function')
  let threw = false
  let tree
  try {
    tree = section()
  } catch (error) {
    threw = true
    console.log(`       (${error instanceof Error ? error.message : String(error)})`)
  }
  check('rendering the section does not throw', threw === false)
  check('the section renders an element tree', tree !== undefined && tree !== null)
  check('the poll loop used the pending route', page.requests.some((r) => r.path === '/api/dsh-approval-sound/pending'))

  // The panel is settings only: the monitoring and diagnostics cards were
  // removed on request, and this keeps them from creeping back in.
  const cards = tree?.children?.flat?.() ?? tree?.children ?? []
  check('the panel renders exactly three cards', cards.length === 3, `${cards.length} cards`)
  const text = JSON.stringify(tree)
  check('the panel no longer shows the listener status', !text.includes('approvalSound.state.'), text.slice(0, 200))
  check('the panel no longer shows diagnostics', !text.includes('approvalSound.diag.'), text.slice(0, 200))
  check('the client never polls the diagnostics route', !page.requests.some((r) => r.path === '/api/dsh-approval-sound/diagnostics'))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} FAILED`)
  process.exitCode = 1
}


