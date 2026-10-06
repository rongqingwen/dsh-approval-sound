/**
 * dsh-approval-sound host half — observes the host's human-decision waterfalls
 * and publishes the set of currently pending prompts to the browser half.
 *
 * Why the HOST owns the observation instead of the page: a prompt is raised on
 * the host as a waterfall, and the browser panel is only one possible answerer —
 * an ACP/IDE answerer, a second window, or a subagent's own turn can raise the
 * same prompt, and a prompt raised while the tab is in the background must still
 * be able to alert. Tapping the waterfall means the notification happens once per
 * request, for every answerer, with the *label* attached — which is what lets the
 * page play a different sound for a shell escalation than for a plain edit.
 *
 * TWO seams are watched, because a user does not distinguish them: what they see
 * is a dialog asking for a decision, and which service raised it is an
 * implementation detail of the harness.
 *
 *   - `approval/request`      — a tool wants escalated rights (allow/reject);
 *   - `user-questions/request` — the harness is asking the user something, which
 *                               is also how a plan review is presented.
 *
 * Watching only the first is the mistake that made the alert silent for anyone
 * whose dialogs are questions: with a session approval policy of `never`, the
 * approval service appends its audit event and returns `'rejected'` BEFORE the
 * waterfall is dispatched, so no approval prompt exists to observe.
 *
 * This half never decides anything: it calls `next()` and hands the outcome
 * straight back to the service, so the prompt (and its fail-closed behaviour)
 * is bit-for-bit what it was without this plugin.
 *
 * @module dsh-approval-sound
 */

import { readFile, mkdir, open, rename, unlink, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plugin id / loader entry id. */
export const name = 'dsh-approval-sound'

/** Host services used. `webServer` carries the loopback JSON routes. */
export const inject = ['webServer']

/** State directory name under `$DSH_HOME`. */
const STATE_DIR_NAME = 'dsh-approval-sound'

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/api/dsh-approval-sound/'

/** How many settled requests stay in the rolling log (diagnostics only). */
const LOG_LIMIT = 40

/**
 * Pending entries are callbacks, not durable state: if the server half of the
 * waterfall never settles (a hung answerer, a lost remote client) the entry is
 * dropped after this long so the page's pending count cannot stick forever.
 */
const STALE_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Canonical configuration normalizer. Every entry point funnels through it —
 * the loader's schema validation, the plugin's own config route, and the
 * persisted file — so the bounds hold no matter where a value came from.
 *
 * @param config - any candidate config object (possibly partial or absent).
 * @returns the fully-populated, clamped configuration.
 */
export function resolveConfig(config) {
  const source = config ?? {}
  return {
    enabled: source.enabled !== false,
    // 0 is a legal, deliberately silent volume: it lets a user keep the alert
    // wired up (and observe it in the settings section) while unmuting later.
    // The ceiling is deliberately above 1: a permission prompt has to compete
    // with whatever else the machine is playing, and the browser half runs the
    // output through a limiter so an over-unity setting stays clean instead of
    // clipping.
    volume: clamp(finite(source.volume, 1), 0, 1.5),
    sound: SOUND_NAMES.includes(source.sound) ? source.sound : 'alert',
    // Repeat is the number of *extra* pings after the first one, so `0` is a
    // single ping and `1` is a double ping.
    repeat: Math.round(clamp(finite(source.repeat, 1), 0, 5)),
    repeatIntervalMs: Math.round(clamp(finite(source.repeatIntervalMs, 900), 120, 5000)),
    cooldownMs: Math.round(clamp(finite(source.cooldownMs, 600), 0, 10_000)),
    onlyWhenUnfocused: source.onlyWhenUnfocused === true,
    // Read-only mirror of the uploaded file so the settings card can describe
    // it without a second request. The bytes never travel in this document.
    customName: typeof source.customName === 'string' ? source.customName : '',
    customBytes: Math.max(0, Math.round(finite(source.customBytes, 0))),
    customAt: Math.max(0, Math.round(finite(source.customAt, 0))),
  }
}

/**
 * Sound profile ids the browser half can produce: the synthesized voices plus
 * `custom` (an uploaded file) and `off`.
 */
export const SOUND_NAMES = Object.freeze(['alert', 'chime', 'bell', 'drop', 'custom', 'off'])

/**
 * Accepted upload formats, keyed by extension.
 *
 * Both the extension and the leading bytes must agree before a file is stored,
 * so a mislabelled upload is rejected at the boundary instead of becoming a
 * "the alert is silent" report later.
 */
const AUDIO_FORMATS = Object.freeze({
  // RIFF
  wav: { mime: 'audio/wav', magic: [[0x52, 0x49, 0x46, 0x46]] },
  // ID3 tag, or an MPEG frame sync
  mp3: {
    mime: 'audio/mpeg',
    magic: [
      [0x49, 0x44, 0x33],
      [0xff, 0xfb],
      [0xff, 0xf3],
      [0xff, 0xf2],
      [0xff, 0xfa],
    ],
  },
  // OggS
  ogg: { mime: 'audio/ogg', magic: [[0x4f, 0x67, 0x67, 0x53]] },
  // An MP4 box header; the `ftyp` brand is checked separately below
  m4a: { mime: 'audio/mp4', magic: [[0x00, 0x00, 0x00, null]] },
  // ADTS frame sync
  aac: { mime: 'audio/aac', magic: [[0xff, 0xf1], [0xff, 0xf9]] },
  // fLaC
  flac: { mime: 'audio/flac', magic: [[0x66, 0x4c, 0x61, 0x43]] },
  // EBML
  webm: { mime: 'audio/webm', magic: [[0x1a, 0x45, 0xdf, 0xa3]] },
})

/** Largest accepted upload. Bigger than any sane alert clip, small enough to hold. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024

/** Fixed stem: the extension varies, the stem never does. */
const CUSTOM_STEM = 'custom'

/** The stored file for one extension. */
function customFileName(extension) {
  return `${CUSTOM_STEM}.${extension}`
}

/** Lowercased extension of a file name, without the dot. */
function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? ''))
  return match === null ? '' : match[1].toLowerCase()
}

/** The stored file's extension, or '' when none was uploaded (or it vanished). */
function storedExtension(config) {
  const extension = extensionOf(config.customName)
  return Object.prototype.hasOwnProperty.call(AUDIO_FORMATS, extension) ? extension : ''
}

/**
 * Whether `bytes` starts with one of `format`'s signatures.
 *
 * A `null` entry in a signature means "any byte here", which is how the MP4
 * family is matched: a big-endian box length then the ASCII `ftyp`.
 */
function matchesMagic(bytes, format) {
  for (const signature of format.magic) {
    if (bytes.length < signature.length) continue
    let ok = true
    for (let index = 0; index < signature.length; index += 1) {
      const expected = signature[index]
      if (expected === null) continue
      if (bytes[index] !== expected) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/**
 * Validate an upload.
 *
 * @param name - the client-supplied file name (used for the extension only).
 * @param bytes - the raw request body.
 * @returns `{ extension, mime }`, or undefined with a reason when unacceptable.
 */
function inspectAudio(name, bytes) {
  if (bytes.length === 0) return { error: 'empty body' }
  if (bytes.length > MAX_AUDIO_BYTES) return { error: `file is larger than ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MiB` }
  const extension = extensionOf(name)
  const format = AUDIO_FORMATS[extension]
  if (format === undefined) return { error: `unsupported format "${extension || '(none)'}"; use ${Object.keys(AUDIO_FORMATS).join(', ')}` }
  if (!matchesMagic(bytes, format)) return { error: `the file does not look like a real ${extension.toUpperCase()} file` }
  // MP4 containers declare their brand right after the box length; checking it
  // keeps a stray `.m4a`-named video from being accepted as audio.
  if (extension === 'm4a') {
    const brand = bytes.length >= 12 ? Buffer.from(bytes.subarray(4, 12)).toString('latin1') : ''
    if (!brand.startsWith('ftyp')) return { error: 'the file is not an MP4/M4A container' }
  }
  return { extension, mime: format.mime }
}

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/** Default document, used when no config file exists yet. */
const CONFIG_DEFAULTS = Object.freeze(resolveConfig(undefined))

/**
 * Config contract for the loader — deliberately dependency-free.
 *
 * A linked, unbuilt plugin gets none of its own dependencies installed, so
 * importing a schema package can fail outright and cordis then parks the entry
 * as `inactive` — which reaches the user only as "the plugin does nothing".
 * So this is a duck-typed schema: callable, Standard-Schema-conformant, and
 * carrying the defaults, validating through the same `resolveConfig` every
 * other entry point uses.
 */
function approvalSoundSchema(value) {
  return resolveConfig(value)
}

/** Standard Schema v1 result shape: a value, or a list of issues. */
function validateConfig(value) {
  try {
    return { value: resolveConfig(value) }
  } catch (error) {
    return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
  }
}

approvalSoundSchema['~standard'] = Object.freeze({
  version: 1,
  vendor: 'schemastery',
  validate: validateConfig,
})
approvalSoundSchema.validate = validateConfig
approvalSoundSchema.dict = CONFIG_DEFAULTS
approvalSoundSchema.toString = () => 'dsh-approval-sound config schema'

export const Config = Object.freeze(approvalSoundSchema)

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** The plugin's own state directory under `$DSH_HOME`. */
function stateDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, STATE_DIR_NAME)
}

/** Atomic JSON write: unique temp file, fsync, rename. */
async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Request-level loopback fence, inlined so this package has no runtime
 * dependency on a sibling plugin. The socket address is authoritative;
 * X-Forwarded-For is never trusted. Browser same-origin markers are checked as
 * well, so a paired LAN client cannot poll the plugin's state.
 */
function isLoopbackRequest(request) {
  try {
    const address = request.socket?.remoteAddress?.toLowerCase()
    if (typeof address !== 'string') return false
    const loopbackV4 = (value) => {
      const parts = value.split('.')
      return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    }
    const addressOk = address === '::1'
      || (address.startsWith('::ffff:') ? loopbackV4(address.slice(7)) : loopbackV4(address))
    if (!addressOk) return false

    const host = request.headers?.host
    if (typeof host !== 'string') return false
    const hostUrl = new URL('http://' + host)
    if (!(hostUrl.hostname === 'localhost' || hostUrl.hostname === '[::1]' || loopbackV4(hostUrl.hostname))) return false

    if (request.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = request.headers.origin
    if (origin === undefined) return true
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Bounded request-body reader; an empty, oversized, or invalid body is null. */
async function readJsonBody(request, maxBytes = 32 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      request.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Bounded raw-body reader for the uploaded alert.
 *
 * @returns the bytes, or null when the body exceeded `MAX_AUDIO_BYTES` (the
 *   socket is destroyed rather than drained, so a hostile upload cannot pin
 *   memory by trickling forever).
 */
async function readBinaryBody(request, maxBytes = MAX_AUDIO_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      request.destroy()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

const MOUNTED = Symbol.for('dsh-approval-sound.mounted')

/**
 * Cordis plugin body.
 *
 * Wrapped fail-safe on purpose: a synchronous throw on this path aborts the
 * whole host boot, and a missing alert must never cost the user their editor.
 */
export function apply(ctx, config) {
  try {
    applyUnsafe(ctx, config)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[dsh-approval-sound] startup failed; the approval alert is inactive:', error)
  }
}

function applyUnsafe(ctx, config) {
  // One watcher per process even if the loader entry is duplicated: a second
  // registration would double every alert.
  const mounted = globalThis[MOUNTED] ??= new Set()
  if (mounted.has(name)) return
  mounted.add(name)
  ctx.effect(() => () => mounted.delete(name))

  let resolved = resolveConfig(config)

  /** Live pending requests, keyed by the host-side request identity. */
  const pending = new Map()
  /** Monotonic sequence per accepted request; the page's dedupe axis. */
  let seq = 0
  /** Rolling log of accepted + settled requests (diagnostics only). */
  const log = []
  /** How many times the waterfall listeners have run at all. */
  let observed = 0
  /** Per-seam tallies, so the card can show WHICH prompt kind is firing. */
  const observedBySeam = { approval: 0, question: 0 }
  /**
   * Counter on a high-traffic event, to prove the event bus actually reaches
   * this plugin. Without it, "my listener never fires" cannot be told apart
   * from "nothing is being dispatched".
   */
  let busEventsSeen = 0
  /** Hook counts read back from the bus after registration (self-check). */
  let attachedHooks = {}  /** Last waterfall failure, surfaced in the diagnostics document. */
  let listenerError = null

  const configPath = join(stateDir(), 'config.json')

  /**
   * Where the uploaded alert lives on disk.
   *
   * A file is addressed by a FIXED stem plus its own extension, so replacing a
   * WAV with an MP3 leaves the old `custom.wav` beside the new `custom.mp3`.
   * `pruneCustomFiles` (run on every load and after every save) is what keeps
   * exactly one of them, which is also why the file — not the config — is the
   * source of truth for "is a custom sound installed".
   */
  function customPathFor(extension) {
    return join(stateDir(), customFileName(extension))
  }

  // ---- status ------------------------------------------------------------

  function publicConfig(value) {
    return {
      enabled: value.enabled,
      volume: value.volume,
      sound: value.sound,
      repeat: value.repeat,
      repeatIntervalMs: value.repeatIntervalMs,
      cooldownMs: value.cooldownMs,
      onlyWhenUnfocused: value.onlyWhenUnfocused,
      customName: value.customName,
      customBytes: value.customBytes,
      customAt: value.customAt,
    }
  }

  function record(entry) {
    log.push(entry)
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
  }

  function prune() {
    const now = Date.now()
    for (const [id, item] of pending) {
      if (now - item.at > STALE_MS) {
        pending.delete(id)
        record({ id, kind: item.kind, label: item.label, at: item.at, closedAt: now, outcome: 'stale' })
      }
    }
  }

  /** The document the browser half polls. */
  function snapshot() {
    prune()
    return {
      ok: true,
      enabled: resolved.enabled,
      config: publicConfig(resolved),
      // The page needs identity, the seam, and a short label to pick and play a
      // sound. A question's full text is deliberately NOT shipped: the label is
      // enough for voice routing, and the text is the user's own prompt.
      pending: [...pending.values()].map((item) => ({
        id: item.id,
        kind: item.kind,
        label: item.label,
        at: item.at,
      })),
      seq,
      updatedAt: Date.now(),
    }
  }

  /** The live listener chain for one event name, or an empty list. */
  function seamHooks(name) {
    try {
      const events = ctx.get('events') ?? ctx.events
      return events?._hooks?.[name] ?? []
    } catch {
      return []
    }
  }

  /**
   * Introspect the shared event bus for the seams this plugin watches.
   *
   * A listener that registered successfully and one that silently failed look
   * identical from the outside: `observed` stays 0 either way, and the plugin
   * appears to work while never reacting to anything. The event service keeps
   * its listener table on the instance (`_hooks`), so reporting how many hooks
   * each seam actually has separates "no prompt happened" from "my listener is
   * not attached" without attaching a debugger.
   */
  function eventBusReport() {
    try {
      const events = ctx.get('events') ?? ctx.events
      if (events === undefined) return { reachable: false }
      const hooks = events._hooks ?? {}
      const counts = {}
      for (const seam of SEAMS) counts[seam.name] = (hooks[seam.name] ?? []).length
      const names = Object.keys(hooks)
      return {
        reachable: true,
        counts,
        // `count` is how many listeners the chain has; `position` is where this
        // observer sits in it. Position is the one that matters: a claiming
        // answerer ends the chain, so an observer behind it never runs.
        attached: { ...attachedHooks },
        // Any decision-related event name the bus knows, so a name mismatch
        // (the seam being called something else in this build) is visible.
        related: names.filter((name) => /question|approval|permission|plan/i.test(name)).sort(),
        totalEvents: names.length,
        // Proof the bus reaches this plugin at all: a high-traffic event counts
        // up while a turn runs.
        eventsSeen: busEventsSeen,
      }
    } catch (error) {
      return { reachable: false, error: message(error) }
    }
  }

  /** The diagnostics document (settings section only, on demand). */
  function diagnostics() {
    prune()
    return {
      ...snapshot(),
      observed,
      // Which seam produced those observations: the fastest way to tell "the
      // plugin is watching the wrong prompt" from "no prompt happened".
      observedBySeam: { ...observedBySeam },
      seams: SEAMS.map((seam) => seam.name),
      eventBus: eventBusReport(),
      pendingCount: pending.size,
      listenerError,
      log: log.slice(-LOG_LIMIT),
    }
  }

  // ---- persistence -------------------------------------------------------

  /**
   * Make the stored directory and `resolved` agree about the custom sound.
   *
   * The disk is authoritative: if `custom.<ext>` is present it wins (size and
   * timestamp read from the file itself), and if it is absent the config is
   * cleared even when a stale `customName` survived in `config.json`. Every
   * other `custom.*` leftover is deleted, so replacing a file can never leave
   * two candidates behind.
   *
   * @returns true when `resolved` had to be changed.
   */
  async function reconcileCustom() {
    let entries = []
    try {
      entries = await readdir(stateDir(), { withFileTypes: true })
    } catch {
      // No state directory yet: nothing is installed, and there is nothing to
      // prune. The config is still normalized below.
      entries = []
    }

    const candidates = []
    for (const entry of entries) {
      if (entry.isFile() !== true) continue
      const match = /^custom\.([a-z0-9]+)$/i.exec(entry.name)
      if (match === null) continue
      const extension = match[1].toLowerCase()
      if (!Object.prototype.hasOwnProperty.call(AUDIO_FORMATS, extension)) continue
      candidates.push({ name: entry.name, extension, path: join(stateDir(), entry.name) })
    }

    // Prefer the file the config points at, so a lingering extra is the one
    // that gets removed rather than the one in use.
    const wanted = storedExtension(resolved)
    const keep = candidates.find((candidate) => candidate.extension === wanted) ?? candidates[0]

    let changed = false
    for (const candidate of candidates) {
      if (candidate === keep) continue
      await unlink(candidate.path).catch(() => {})
    }

    if (keep === undefined) {
      if (resolved.customName !== '' || resolved.customBytes !== 0) {
        resolved = resolveConfig({ ...resolved, customName: '', customBytes: 0, customAt: 0 })
        changed = true
      }
      return changed
    }

    const info = await stat(keep.path).catch(() => undefined)
    const bytes = info?.size ?? 0
    const at = Math.round(info?.mtimeMs ?? Date.now())
    if (resolved.customName !== keep.name || resolved.customBytes !== bytes || resolved.customAt !== at) {
      resolved = resolveConfig({ ...resolved, customName: keep.name, customBytes: bytes, customAt: at })
      changed = true
    }
    return changed
  }

  async function loadPersisted() {
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed = JSON.parse(raw)
      // Saved values override the loader config; `resolveConfig` clamps them.
      resolved = resolveConfig({ ...config, ...parsed })
    } catch {
      // No saved overrides, or an unreadable one: the loader config stands.
    }
    if (await reconcileCustom()) await persist()
  }

  async function persist() {
    try {
      await writeJsonAtomic(configPath, publicConfig(resolved))
    } catch {
      // A failed save must never break the watcher.
    }
  }

  /**
   * Store one validated upload, replacing whatever was there.
   *
   * The bytes land in a temp file that is fsynced and renamed, so a crash
   * mid-upload cannot leave a truncated `custom.*` that would later be served
   * as a corrupt alert. Old variants are pruned afterwards, which is also what
   * makes the extension switch safe.
   *
   * @returns the stored file name.
   */
  async function storeCustom(bytes, extension) {
    const directory = stateDir()
    await mkdir(directory, { recursive: true })
    const target = customPathFor(extension)
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      const handle = await open(temp, 'w')
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, target)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    return customFileName(extension)
  }

  /** Remove every stored custom file. */
  async function removeCustom() {
    let entries = []
    try {
      entries = await readdir(stateDir(), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isFile() !== true) continue
      if (!/^custom\.[a-z0-9]+$/i.test(entry.name)) continue
      await unlink(join(stateDir(), entry.name)).catch(() => {})
    }
  }

  /** Read the stored custom file, or undefined when there is none. */
  async function readCustom() {
    const extension = storedExtension(resolved)
    if (extension === '') return undefined
    const bytes = await readFile(customPathFor(extension)).catch(() => undefined)
    if (bytes === undefined) return undefined
    return { bytes, extension, mime: AUDIO_FORMATS[extension].mime }
  }

  // ---- waterfall observation ---------------------------------------------

  /**
   * Every host seam that means "the harness is blocked waiting for a human".
   *
   * Both are waterfalls with the same shape (an abortable request plus `next`),
   * so one observer serves them. They are watched together because a user does
   * not distinguish them: what they see is *a dialog asking for a decision*, and
   * which service raised it is an implementation detail of the harness. Watching
   * only the approval seam is what made the alert silent for users whose
   * dialogs are questions.
   */
  const SEAMS = Object.freeze([
    {
      name: 'approval/request',
      kind: 'approval',
      /**
       * Label an approval request for the alert's voice routing. The tool name
       * is the only stable identity the request carries.
       */
      describe: (req) => {
        const toolName = typeof req?.toolName === 'string' && req.toolName !== '' ? req.toolName : 'unknown'
        return {
          label: toolName,
          callId: typeof req?.callId === 'string' ? req.callId : undefined,
        }
      },
    },
    {
      name: 'user-questions/request',
      kind: 'question',
      /**
       * Label a question request. `header` is the author's short label for the
       * panel, `intent.kind` identifies a plan review, and the first question's
       * text is the last resort — never the raw JSON, which would be useless as
       * a voice selector.
       */
      describe: (req) => {
        const questions = Array.isArray(req?.questions) ? req.questions : []
        const first = questions.find((entry) => entry !== null && typeof entry === 'object')
        const intent = first?.intent?.kind ?? req?.intent?.kind
        let label = 'question'
        if (intent === 'plan-review') label = 'plan-review'
        else if (typeof first?.header === 'string' && first.header !== '') label = first.header
        else if (typeof first?.question === 'string' && first.question !== '') label = first.question
        return {
          label: String(label).slice(0, 60),
          callId: typeof req?.wait?.callId === 'string' ? req.wait.callId : undefined,
          // A question panel can carry several items: worth showing, and a
          // useful signal that this is a multi-part prompt.
          count: questions.length,
        }
      },
    },
  ])

  /**
   * Observe one prompt request without ever influencing it.
   *
   * The listener runs BEFORE the composed answerer in registration order, which
   * matters twice: an abort signal that is already aborted can be reported
   * immediately, and a page in a background tab learns about the prompt at the
   * moment it is raised rather than when it is answered.
   *
   * @param seam - the seam being observed (see {@link SEAMS}).
   * @param req - the pending request from the service.
   * @param next - the remaining waterfall.
   * @returns exactly what the rest of the waterfall returned.
   */
  function observeSeam(seam, req, next) {
    observed += 1
    observedBySeam[seam.kind] = (observedBySeam[seam.kind] ?? 0) + 1

    let described = { label: 'unknown' }
    let item
    try {
      described = seam.describe(req) ?? described
      const at = Date.now()
      const id = `a${++seq}`
      item = {
        id,
        seq,
        kind: seam.kind,
        label: described.label,
        callId: described.callId,
        count: described.count,
        at,
      }
      pending.set(id, item)
      record({ id, kind: seam.kind, label: item.label, callId: item.callId, at })

      if (req?.signal?.aborted === true) {
        // Already withdrawn before we looked: it was never really promptable.
        close(item, 'aborted')
        item = undefined
      } else if (req?.signal !== undefined && typeof req.signal.addEventListener === 'function') {
        // The clean close edge: the asker's signal settles when the request is
        // answered or withdrawn, which is exactly when the prompt leaves the UI.
        const signal = req.signal
        const onAbort = () => close(item, 'closed')
        signal.addEventListener('abort', onAbort, { once: true })
        item.detach = () => signal.removeEventListener('abort', onAbort)
      }
    } catch (error) {
      // Observation must never be able to break the prompt.
      listenerError = message(error)
      if (item !== undefined) close(item, 'observer-failed')
      return next()
    }

    let downstream
    try {
      downstream = next()
    } catch (error) {
      // A synchronous throw from a sibling answerer still closes our entry.
      if (item !== undefined) close(item, 'threw')
      throw error
    }

    // Close on whichever edge arrives first: the asker's abort signal (the clean
    // "the prompt left the UI" edge) or the answerer settling. Wiring only the
    // signal is not enough — a wait whose signal never aborts would leave the
    // entry pending for the full STALE_MS, showing the user a phantom pending
    // prompt. `close` is idempotent, so both edges are safe to wire at once.
    if (item !== undefined) {
      const tracked = item
      Promise.resolve(downstream).then(
        () => close(tracked, 'settled'),
        () => close(tracked, 'settled'),
      )
    }
    return downstream
  }

  /** Close one pending entry exactly once. */
  function close(item, outcome) {
    if (!pending.has(item.id)) return
    pending.delete(item.id)
    if (typeof item.detach === 'function') {
      try {
        item.detach()
      } catch {
        // A removed listener is not an error worth surfacing.
      }
    }
    record({
      id: item.id,
      kind: item.kind,
      label: item.label,
      callId: item.callId,
      at: item.at,
      closedAt: Date.now(),
      outcome,
    })
  }

  // ---- routes ------------------------------------------------------------

  /**
   * Poll document. The page asks for this on a fixed cadence; it is the whole
   * data channel, so a missing/failed connection is visible in the settings
   * section instead of silently swallowing alerts.
   */
  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}pending`,
    handler: (request, response) => {
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      writeJson(response, 200, snapshot())
    },
  })

  // Diagnostics + config write side. POST-only on the write path so a stray
  // navigation from the address bar can never reconfigure the plugin.
  //
  // Every route is registered as an EXACT path on purpose. The composed DSH web
  // app mounts its own `/api` prefix guard (browser-session authentication) and
  // answers *every* unmatched `/api/...` path with 401 before a plugin's own
  // `/api/<name>/` prefix route is ever consulted, so a prefix route here would
  // silently lose to it. Exact routes are matched ahead of every prefix.
  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}diagnostics`,
    handler: (request, response) => {
      if (!isLoopbackRequest(request)) {
        writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      writeJson(response, 200, diagnostics())
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}config`,
    handler: async (request, response) => {
      try {
        if (!isLoopbackRequest(request)) {
          writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        if (request.method !== 'POST') {
          writeJson(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(request)
        if (body === null) {
          writeJson(response, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const next = { ...publicConfig(resolved) }
        // The custom-audio mirror fields are deliberately NOT writable here: the
        // uploaded file on disk is their only source of truth, so a client
        // cannot claim an alert exists that does not.
        for (const key of ['enabled', 'volume', 'sound', 'repeat', 'repeatIntervalMs', 'cooldownMs', 'onlyWhenUnfocused']) {
          if (body[key] !== undefined) next[key] = body[key]
        }
        resolved = resolveConfig(next)
        await persist()
        writeJson(response, 200, snapshot())
      } catch (error) {
        // Own the whole response lifecycle: a throwing handler would otherwise
        // surface to the page as a dropped connection.
        try {
          writeJson(response, 500, { ok: false, error: message(error) })
        } catch {
          response.destroy()
        }
      }
    },
  })

  // The uploaded alert file: POST stores one, GET serves it back, DELETE
  // removes it. Raw `application/octet-stream` rather than multipart on
  // purpose — one file is the whole payload, so a multipart parser would be
  // pure surface area with no benefit.
  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}sound`,
    handler: async (request, response) => {
      try {
        if (!isLoopbackRequest(request)) {
          writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }

        if (request.method === 'GET' || request.method === 'HEAD') {
          const stored = await readCustom()
          if (stored === undefined) {
            writeJson(response, 404, { ok: false, error: 'no custom sound is installed' })
            return
          }
          response.writeHead(200, {
            'content-type': stored.mime,
            'content-length': stored.bytes.length,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            // The content is a user's own upload: never let a browser sniff it
            // into something executable.
            'x-content-type-options': 'nosniff',
          })
          response.end(request.method === 'HEAD' ? undefined : stored.bytes)
          return
        }

        if (request.method === 'DELETE') {
          await removeCustom()
          resolved = resolveConfig({ ...resolved, customName: '', customBytes: 0, customAt: 0 })
          // Selecting a sound that no longer exists would leave the alert
          // silently mute, so fall back to a voice that always exists.
          if (resolved.sound === 'custom') resolved = resolveConfig({ ...resolved, sound: 'alert' })
          await persist()
          writeJson(response, 200, snapshot())
          return
        }

        if (request.method !== 'POST') {
          writeJson(response, 405, { ok: false, error: 'method not allowed' })
          return
        }

        const bytes = await readBinaryBody(request)
        if (bytes === null) {
          writeJson(response, 413, { ok: false, error: `file is larger than ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MiB` })
          return
        }

        // The original name arrives in a header: a query string would end up in
        // the server log, and the body is the file itself.
        const rawName = request.headers['x-dsh-sound-name']
        const name = typeof rawName === 'string' ? decodeURIComponent(rawName) : ''
        const inspected = inspectAudio(name, bytes)
        if (inspected.error !== undefined) {
          writeJson(response, 400, { ok: false, error: inspected.error })
          return
        }

        const storedName = await storeCustom(bytes, inspected.extension)
        // Replace the config mirror with the file's own facts, then prune any
        // other variant left over from a previous format.
        resolved = resolveConfig({
          ...resolved,
          customName: storedName,
          customBytes: bytes.length,
          customAt: Date.now(),
          // Installing a file is an unambiguous statement of intent: the user
          // who just picked an alert wants to hear it.
          sound: 'custom',
        })
        await reconcileCustom()
        await persist()
        writeJson(response, 200, snapshot())
      } catch (error) {
        try {
          writeJson(response, 500, { ok: false, error: message(error) })
        } catch {
          response.destroy()
        }
      }
    },
  })

  // ---- lifecycle ---------------------------------------------------------

  ctx.effect(() => {
    void loadPersisted()

    /** Disposers for every seam this plugin managed to join. */
    const disposers = []
    const joined = []
    for (const seam of SEAMS) {
      /**
       * Register defensively: a sibling may not have provided the service this
       * seam belongs to (an approval seam is absent from a headless-ish
       * composition, questions from one without the tool), and a missing seam
       * must cost only that seam — never the host boot, and never the other
       * seam's alert.
       */
      try {
        /**
         * `prepend: true` is what makes this work at all, and it is subtle.
         *
         * An answerer CLAIMS a request by returning a result instead of calling
         * `next()`, which ends the waterfall chain right there. The composed
         * answerer (the browser bridge) is registered during boot, so it sits at
         * the FRONT of the chain; an observer appended after it would never run
         * — the request is already claimed by the time the chain would reach it.
         * That is why an appended observer reports zero observations while
         * looking perfectly registered.
         *
         * Prepending puts this passive observer ahead of the claimer, where it
         * records the prompt, calls `next()`, and lets the real answerer behave
         * exactly as before.
         *
         * `global: true` skips the bus's per-listener context filter: this
         * plugin observes EVERY prompt in the process and has no business being
         * scope-filtered, and a filtered-out listener fails silently too.
         */
        const before = new Set(seamHooks(seam.name).map((hook) => hook.callback))
        const dispose = ctx.on(seam.name, (req, next) => observeSeam(seam, req, next), {
          prepend: true,
          global: true,
        })
        if (typeof dispose === 'function') disposers.push(dispose)

        // Read the chain back and locate the hook that this registration added,
        // so its POSITION (not just its existence) is on record.
        const after = seamHooks(seam.name)
        const mine = after.findIndex((hook) => !before.has(hook.callback))
        attachedHooks[seam.name] = { count: after.length, position: mine }
        joined.push(seam.name)
      } catch (error) {
        listenerError = message(error)
        // eslint-disable-next-line no-console
        console.error(`[dsh-approval-sound] could not observe ${seam.name}:`, error)
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[dsh-approval-sound] watching ${joined.join(', ') || '(no seam available)'} (enabled=${resolved.enabled}, sound=${resolved.sound})`)
    // eslint-disable-next-line no-console
    console.log(`[dsh-approval-sound] seam hooks (position 0 = observer runs first): ${JSON.stringify(attachedHooks)}`)

    // Liveness probe: if this stays at 0 while turns run, the event bus is not
    // reaching this plugin at all, which is a different problem from a missing
    // prompt.
    try {
      ctx.on('session/event', () => { busEventsSeen += 1 }, { global: true })
    } catch {
      // A missing probe event must not affect the seams.
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // One failing disposer must not strand the others.
        }
      }
      // Drop every pending entry: the disposer is the only path that ends the
      // watcher, and a stale pending set would leave the page counting forever.
      for (const item of [...pending.values()]) close(item, 'disposed')
    }
  }, 'dsh-approval-sound: prompt watcher')
}
