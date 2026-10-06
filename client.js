/**
 * dsh-approval-sound browser half — watches this plugin's own loopback document
 * for newly raised approval requests and plays the alert.
 *
 * The page is the only place the alert can actually make a sound, so it owns
 * playback; the host half owns *detection*, because the permission prompt is
 * raised by the host's `approval/request` waterfall regardless of which
 * answerer ends up showing it. This half therefore:
 *
 *   1. polls `GET /api/dsh-approval-sound/pending` (a request that is still
 *      open appears in `pending`; the poll is the entire data channel, and its
 *      failure is visible in 设置 → 权限提示音 instead of failing silently);
 *   2. diffs the pending ids against the ones it has already announced, so one
 *      prompt alerts exactly once — repeats and dropped polls cannot double it,
 *      and an already-open prompt at page load is adopted silently;
 *   3. synthesizes the alert with Web Audio (no asset, no network, no binary),
 *      picking a voice from the tool name so a shell escalation sounds
 *      different from an ordinary file edit.
 *
 * The bundle uses the dsh web module-loader contract
 * (`window.__ModuleLoader__.load({ id, factory })`) so React resolves from the
 * page's module table instead of being bundled.
 *
 * @module dsh-approval-sound/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-approval-sound',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    /**
     * Required client services. `slots` and `locale` are the seats this section
     * cannot work without; the settings scope is read opportunistically through
     * `ctx.get`, so a harness without that surface still loads the section (its
     * controls then use the plugin's own config route).
     */
    exports.inject = ['slots', 'locale']

    /** Settings namespace / locale namespace of this plugin. */
    const NS = 'dsh-approval-sound'

    /** Section position: directly below 余额预警 (dsh-balance-pet, order 152). */
    const SECTION_ORDER = 153

    /** Poll cadence while the page is visible. */
    const POLL_MS = 700

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /** Sound profile ids: the synthesized voices, an uploaded file, and silence. */
    const SOUND_NAMES = ['alert', 'chime', 'bell', 'drop', 'custom', 'off']

    /** Ceiling of the volume control; above 1 the limiter keeps it clean. */
    const MAX_VOLUME = 1.5

    function clamp(value, low, high) {
      return Math.min(high, Math.max(low, value))
    }

    function finite(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /**
     * Normalize one configuration document. The host normalizes too; this is
     * the same contract applied to a locally-merged draft, so a control can
     * never put an out-of-range value on the wire.
     */
    function resolveConfig(config) {
      const source = config ?? {}
      return {
        enabled: source.enabled !== false,
        volume: clamp(finite(source.volume, 1), 0, MAX_VOLUME),
        sound: SOUND_NAMES.includes(source.sound) ? source.sound : 'alert',
        repeat: Math.round(clamp(finite(source.repeat, 1), 0, 5)),
        repeatIntervalMs: Math.round(clamp(finite(source.repeatIntervalMs, 900), 120, 5000)),
        cooldownMs: Math.round(clamp(finite(source.cooldownMs, 600), 0, 10_000)),
        onlyWhenUnfocused: source.onlyWhenUnfocused === true,
        customName: typeof source.customName === 'string' ? source.customName : '',
        customBytes: Math.max(0, Math.round(finite(source.customBytes, 0))),
        customAt: Math.max(0, Math.round(finite(source.customAt, 0))),
      }
    }

    let config = resolveConfig(undefined)

    // ---------------------------------------------------------------------
    // Dictionaries
    // ---------------------------------------------------------------------

    const zh = {
      'approvalSound.title': '权限提示音',
      'approvalSound.audio.ready': '音频已就绪',
      'approvalSound.audio.locked': '音频被浏览器拦截：点击下方「试听」或页面任意位置即可解锁',
      'approvalSound.audio.unsupported': '当前环境不支持 Web Audio，无法播放提示音',
      'approvalSound.audio.loading': '正在加载自定义音频…',
      'approvalSound.config.title': '提示音设置',
      'approvalSound.config.enabled': '审批弹窗出现时播放提示音',
      'approvalSound.config.volume': '音量',
      'approvalSound.config.sound': '音色',
      'approvalSound.config.repeat': '重复次数',
      'approvalSound.config.repeatHint': '1 表示只响一次',
      'approvalSound.config.interval': '重复间隔（毫秒）',
      'approvalSound.config.cooldown': '最短间隔（毫秒）',
      'approvalSound.config.cooldownHint': '两次铃声之间的强制静默，避免连续弹窗叠成噪音',
      'approvalSound.config.unfocused': '仅在窗口不在前台时提醒',
      'approvalSound.config.readonly': '宿主未注册设置命名空间：改动将保存到插件自己的配置文件。',
      'approvalSound.test': '试听',
      'approvalSound.sound.alert': '急促双响',
      'approvalSound.sound.chime': '清脆铃声',
      'approvalSound.sound.bell': '钟声',
      'approvalSound.sound.drop': '水滴提示',
      'approvalSound.sound.custom': '自定义音频',
      'approvalSound.sound.off': '静音',
      'approvalSound.custom.title': '自定义音频',
      'approvalSound.custom.none': '尚未上传音频文件',
      'approvalSound.custom.installed': '已安装：{name}（{size}）',
      'approvalSound.custom.active': '当前生效中：弹窗时会播放这个文件',
      'approvalSound.custom.inactive': '已安装但未选中：把上方「音色」设为「自定义音频」才会播放',
      'approvalSound.custom.upload': '上传音频文件',
      'approvalSound.custom.replace': '更换音频文件',
      'approvalSound.custom.remove': '移除',
      'approvalSound.custom.formats': '支持 wav / mp3 / ogg / m4a / aac / flac / webm，最大 8 MiB。文件只保存在本机。',
      'approvalSound.custom.failed': '音频文件处理失败：{error}',
      'approvalSound.voice.shell': '命令行升级',
      'approvalSound.voice.file': '文件写入',
      'approvalSound.voice.web': '网络请求',
      'approvalSound.voice.agent': '子代理 / 团队',
      'approvalSound.voice.generic': '通用工具',
      'approvalSound.voice.question': '提问面板',
      'approvalSound.voice.plan': '计划审核',
      'approvalSound.voice.test': '试听',
    }

    const en = {
      'approvalSound.title': 'Approval sound',
      'approvalSound.audio.ready': 'Audio ready',
      'approvalSound.audio.locked': 'Audio is blocked by the browser: click "Test" below or anywhere on the page to unlock it',
      'approvalSound.audio.unsupported': 'Web Audio is unavailable here, so no sound can play',
      'approvalSound.audio.loading': 'Loading the custom audio…',
      'approvalSound.config.title': 'Alert settings',
      'approvalSound.config.enabled': 'Play a sound when an approval prompt appears',
      'approvalSound.config.volume': 'Volume',
      'approvalSound.config.sound': 'Voice',
      'approvalSound.config.repeat': 'Repeats',
      'approvalSound.config.repeatHint': '1 means a single strike',
      'approvalSound.config.interval': 'Repeat interval (ms)',
      'approvalSound.config.cooldown': 'Minimum gap (ms)',
      'approvalSound.config.cooldownHint': 'Enforced silence between alerts, so a burst of prompts cannot become noise',
      'approvalSound.config.unfocused': 'Only alert while the window is in the background',
      'approvalSound.config.readonly': 'The host registered no settings namespace: changes are saved to this plugin\'s own config file.',
      'approvalSound.test': 'Test',
      'approvalSound.sound.alert': 'Double beep',
      'approvalSound.sound.chime': 'Chime',
      'approvalSound.sound.bell': 'Bell',
      'approvalSound.sound.drop': 'Drop',
      'approvalSound.sound.custom': 'Custom audio',
      'approvalSound.sound.off': 'Silent',
      'approvalSound.custom.title': 'Custom audio',
      'approvalSound.custom.none': 'No audio file uploaded yet',
      'approvalSound.custom.installed': 'Installed: {name} ({size})',
      'approvalSound.custom.active': 'In use: this file plays when a prompt appears',
      'approvalSound.custom.inactive': 'Installed but not selected: set "Voice" above to "Custom audio" to hear it',
      'approvalSound.custom.upload': 'Upload audio file',
      'approvalSound.custom.replace': 'Replace audio file',
      'approvalSound.custom.remove': 'Remove',
      'approvalSound.custom.formats': 'Accepts wav / mp3 / ogg / m4a / aac / flac / webm, up to 8 MiB. The file stays on this machine.',
      'approvalSound.custom.failed': 'Could not use that audio file: {error}',
      'approvalSound.voice.shell': 'Shell escalation',
      'approvalSound.voice.file': 'File write',
      'approvalSound.voice.web': 'Network request',
      'approvalSound.voice.agent': 'Subagent / team',
      'approvalSound.voice.generic': 'Generic tool',
      'approvalSound.voice.question': 'Question panel',
      'approvalSound.voice.plan': 'Plan review',
      'approvalSound.voice.test': 'Test',
    }

    /**
     * Translate through the locale service when present, falling back to the
     * built-in dictionaries so the section never renders raw keys.
     */
    function makeT(ctx) {
      return (key, vars) => {
        let text
        try {
          text = ctx.locale.bind(NS)(key)
        } catch {
          text = undefined
        }
        if (typeof text !== 'string' || text === '' || text === key) text = zh[key] ?? key
        if (vars === undefined) return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : match))
      }
    }

    // ---------------------------------------------------------------------
    // Host API
    // ---------------------------------------------------------------------

    async function fetchJson(path, method, body) {
      const response = await fetch(path, {
        method: method ?? 'GET',
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
      return response.json()
    }

    const API = {
      pending: () => fetchJson('/api/dsh-approval-sound/pending'),
      setConfig: (patch) => fetchJson('/api/dsh-approval-sound/config', 'POST', patch),
      sound: '/api/dsh-approval-sound/sound',
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    // ---------------------------------------------------------------------
    // Web Audio: the alert voices
    // ---------------------------------------------------------------------

    /**
     * Prompt → voice routing.
     *
     * Two axes matter. The seam decides the family: a question panel (the
     * harness asking you something) and an approval panel (a tool asking for
     * escalated rights) are different kinds of interruption, so they must not
     * sound the same. Within the approval family the *label* splits further,
     * because an escalated shell command and a plain file edit deserve
     * different urgency.
     */
    const VOICE_RULES = [
      { voice: 'shell', names: ['bash', 'pwsh', 'powershell', 'cmd', 'shell', 'terminal_open', 'terminal_signal', 'run_code', 'job_output', 'job_kill'] },
      { voice: 'file', names: ['write', 'edit', 'read', 'read_image', 'glob', 'grep', 'present', 'deliverables'] },
      { voice: 'web', names: ['web_search', 'web_fetch'] },
      { voice: 'agent', names: ['subagent', 'subagent_fork', 'send_message', 'workflow', 'interrupt_agent', 'list_agents'] },
    ]

    /**
     * Pitch multiplier per voice.
     *
     * Explicit rather than derived: the question family has to sit clearly BELOW
     * the approval family, and a modulo over a short list of indices would fold
     * it back onto an approval pitch.
     */
    const VOICE_PITCH = {
      shell: 1,
      file: 1.04,
      web: 1.08,
      agent: 1.12,
      generic: 1.16,
      question: 0.88,
      plan: 0.8,
      test: 1,
    }

    /**
     * Pick the voice for one pending prompt.
     *
     * @param entry - the pending entry from the host (`kind`, `label`), or a
     *   bare tool name for backward compatibility.
     * @returns the voice id used for pitch selection.
     */
    function voiceOf(entry) {
      const kind = typeof entry === 'object' && entry !== null ? entry.kind : undefined
      const raw = typeof entry === 'object' && entry !== null
        ? (entry.label ?? entry.toolName)
        : entry

      if (kind === 'question') {
        // A plan review is the one question with a decision attached, so it gets
        // its own voice rather than blending into ordinary questions.
        return /plan/i.test(String(raw ?? '')) ? 'plan' : 'question'
      }

      const name = String(raw ?? '').toLowerCase()
      for (const rule of VOICE_RULES) {
        for (const candidate of rule.names) {
          if (name === candidate || name.startsWith(`${candidate}_`) || name.startsWith(`${candidate}.`)) return rule.voice
        }
      }
      return 'generic'
    }

    function voiceLabelKey(voice) {
      return `approvalSound.voice.${voice}`
    }

    const audio = {
      ctx: undefined,
      supported: undefined,
      /** True once a real user gesture released the context. */
      unlocked: false,
      /** Set while a gesture-driven resume is in flight. */
      resuming: false,
      /** Error from the last construction attempt. */
      error: null,
      listeners: new Set(),
      /** The shared output chain, built once with the context. */
      master: undefined,
      /** Decoded custom clip: `{ key, buffer }`; the key tracks the upload. */
      custom: undefined,
      /** Set while a custom clip is being fetched and decoded. */
      loading: undefined,
      /** Which custom upload the decoded clip belongs to. */
      loadedKey: '',
      /** Playbacks waiting for the clip: they must not be silently dropped. */
      waiting: [],
    }

    function audioSupported() {
      if (audio.supported === undefined) {
        audio.supported = typeof window !== 'undefined'
          && (typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function')
      }
      return audio.supported
    }

    /**
     * The shared output chain: voices → limiter → master gain → speakers.
     *
     * The limiter is what makes "louder" possible without clipping. Summed
     * oscillator partials and an over-unity master gain would otherwise square
     * off at the DAC and turn a short alert into a buzz, so the chain pins the
     * peaks just under full scale while the makeup gain restores the average
     * level the tones lost to the compression.
     */
    function ensureChain(ctx) {
      if (audio.master !== undefined) return
      let input = ctx.destination
      try {
        const limiter = ctx.createDynamicsCompressor()
        limiter.threshold.value = -6
        limiter.knee.value = 3
        limiter.ratio.value = 20
        limiter.attack.value = 0.002
        limiter.release.value = 0.12
        const master = ctx.createGain()
        // Headroom the limiter took away, handed back.
        master.gain.value = 1.6
        limiter.connect(master)
        master.connect(ctx.destination)
        input = limiter
      } catch {
        // A context without the compressor node still plays, just unfettered.
        const master = ctx.createGain()
        master.gain.value = 1.6
        master.connect(ctx.destination)
        input = master
      }
      audio.master = input
    }

    /** Build the context on demand — never at load (a stray context is noise). */
    function ensureAudio() {
      if (!audioSupported()) return undefined
      if (audio.ctx !== undefined) return audio.ctx
      try {
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        audio.ctx = new Ctor()
        audio.error = null
        ensureChain(audio.ctx)
      } catch (error) {
        audio.error = messageOf(error)
        audio.ctx = undefined
      }
      return audio.ctx
    }

    function audioSnapshot() {
      return {
        supported: audioSupported(),
        unlocked: audio.unlocked === true,
        error: audio.error,
        customReady: audio.custom !== undefined,
        customLoading: audio.loading !== undefined,
      }
    }

    /** Identity of the installed upload, so a replacement invalidates the clip. */
    function customKey() {
      return `${config.customName}:${config.customBytes}:${config.customAt}`
    }

    function notifyAudio() {
      for (const listener of [...audio.listeners]) {
        try {
          listener()
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
    }

    /**
     * Ask the context to run. Chrome/Safari create it `suspended` until a user
     * gesture; `resume()` outside one is a no-op, so it is only called from a
     * gesture handler or from a playback attempt that follows one.
     */
    function unlockAudio() {
      const ctx = ensureAudio()
      if (ctx === undefined) return
      if (ctx.state === 'running') {
        if (!audio.unlocked) {
          audio.unlocked = true
          notifyAudio()
        }
        return
      }
      try {
        const started = ctx.resume()
        if (started !== undefined && typeof started.then === 'function') {
          started.then(() => {
            if (ctx.state === 'running') {
              audio.unlocked = true
              notifyAudio()
            }
          }, () => {})
        }
      } catch {
        // A resume failure is reported by the `unlocked` flag staying false.
      }
    }

    function armGestureUnlock() {
      if (typeof window === 'undefined' || window.document === undefined) return () => {}
      const handler = () => {
        unlockAudio()
        // A pointer/key gesture is the only thing that can release the context,
        // so the listeners stay armed until it actually starts running.
        if (audio.ctx?.state === 'running') detach()
      }
      const detach = () => {
        window.document.removeEventListener('pointerdown', handler, true)
        window.document.removeEventListener('keydown', handler, true)
        window.document.removeEventListener('touchstart', handler, true)
        window.document.removeEventListener('click', handler, true)
      }
      window.document.addEventListener('pointerdown', handler, true)
      window.document.addEventListener('keydown', handler, true)
      window.document.addEventListener('touchstart', handler, true)
      window.document.addEventListener('click', handler, true)
      return detach
    }

    /** One enveloped oscillator note, scheduled relative to `when`. */
    function note(ctx, master, { freq, at, dur, gain, type = 'sine', slideTo, harmonic = 0 }) {
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.type = type
      osc.frequency.setValueAtTime(freq, at)
      if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur)
      // A short attack then an exponential tail: percussive enough to cut
      // through, without the click a hard gain step would produce.
      env.gain.setValueAtTime(0.0001, at)
      env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.012)
      env.gain.exponentialRampToValueAtTime(0.0001, at + dur)
      osc.connect(env)
      env.connect(master)
      osc.start(at)
      osc.stop(at + dur + 0.02)

      if (harmonic > 0) {
        // One partial makes a bell-ish timbre instead of a bare sine.
        const partial = ctx.createOscillator()
        const partialEnv = ctx.createGain()
        partial.type = 'sine'
        partial.frequency.setValueAtTime(freq * harmonic, at)
        partialEnv.gain.setValueAtTime(0.0001, at)
        partialEnv.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * 0.28), at + 0.008)
        partialEnv.gain.exponentialRampToValueAtTime(0.0001, at + dur * 0.7)
        partial.connect(partialEnv)
        partialEnv.connect(master)
        partial.start(at)
        partial.stop(at + dur + 0.02)
      }
    }

    const VOICES = {
      alert: (ctx, master, at, v, pitch) => {
        note(ctx, master, { freq: 784 * pitch, at, dur: 0.16, gain: 0.5 * v, type: 'triangle' })
        note(ctx, master, { freq: 1046 * pitch, at: at + 0.17, dur: 0.2, gain: 0.42 * v, type: 'triangle' })
        if (v > 0.05) {
          note(ctx, master, { freq: 1568 * pitch, at, dur: 0.1, gain: 0.12 * v, type: 'sine' })
          note(ctx, master, { freq: 2093 * pitch, at: at + 0.17, dur: 0.12, gain: 0.1 * v, type: 'sine' })
        }
      },
      chime: (ctx, master, at, v, pitch) => {
        note(ctx, master, { freq: 880 * pitch, at, dur: 0.9, gain: 0.3 * v, harmonic: 2.76 })
      },
      bell: (ctx, master, at, v, pitch) => {
        note(ctx, master, { freq: 660 * pitch, at, dur: 1.2, gain: 0.26 * v, type: 'triangle', harmonic: 2.01 })
        note(ctx, master, { freq: 990 * pitch, at: at + 0.06, dur: 0.8, gain: 0.12 * v })
      },
      drop: (ctx, master, at, v, pitch) => {
        note(ctx, master, { freq: 1200 * pitch, at, dur: 0.22, gain: 0.4 * v, slideTo: 420 * pitch })
      },
    }

    // ---------------------------------------------------------------------
    // The custom (uploaded) alert
    // ---------------------------------------------------------------------

    /**
     * Fetch and decode the uploaded clip.
     *
     * Two details make an arbitrary user file usable as an alarm:
     *
     *   - the raw bytes are normalized to their own peak before play, so a clip
     *     exported quietly is not a quiet alert (the limiter then absorbs any
     *     overshoot from a hot master gain);
     *   - the decoded buffer is keyed to the upload's identity, so replacing the
     *     file invalidates the clip without any explicit cache flush.
     */
    function loadCustom() {
      const key = customKey()
      if (config.customName === '') return Promise.resolve(undefined)
      if (audio.custom !== undefined && audio.loadedKey === key) return Promise.resolve(audio.custom)
      if (audio.loading !== undefined && audio.loadedKey === key) return audio.loading

      const ctx = ensureAudio()
      if (ctx === undefined) return Promise.resolve(undefined)

      // A new attempt clears the previous attempt's error, so a transient
      // outage does not keep the settings card complaining after a success.
      audio.error = null
      audio.loadedKey = key
      const task = (async () => {
        const soundUrl = `/api/dsh-approval-sound/sound?k=${encodeURIComponent(key)}`
        const response = await fetch(soundUrl, {
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`sound fetch failed: ${response.status}`)
        const bytes = await response.arrayBuffer()
        // A promise-returning decode is the modern form; older engines take a
        // callback, and a rejected decode must surface to the settings card.
        const buffer = await new Promise((resolve, reject) => {
          const maybe = ctx.decodeAudioData(bytes, resolve, reject)
          if (maybe !== undefined && typeof maybe.then === 'function') maybe.then(resolve, reject)
        })
        audio.custom = buffer
        audio.loadedKey = key
        return buffer
      })()

      audio.loading = task
      task.then(
        () => {
          audio.loading = undefined
          flushWaiting()
          notifyAudio()
        },
        (error) => {
          audio.loading = undefined
          audio.custom = undefined
          // Clear the decoded-key marker too, so a later poll retries the fetch
          // once the host is reachable again instead of giving up permanently.
          audio.loadedKey = ''
          audio.error = `custom sound: ${messageOf(error)}`
          // A queue that waits forever is worse than a fallback: release it so
          // the alert degrades to the synthesized voice instead of silence.
          flushWaiting()
          notifyAudio()
        },
      )
      return task
    }

    /** Release playbacks that were queued while the clip decoded. */
    function flushWaiting() {
      const pending = audio.waiting.splice(0, audio.waiting.length)
      for (const item of pending) {
        try {
          item()
        } catch {
          // One broken waiter must not strand the rest.
        }
      }
    }

    /** Drop the decoded clip (used when the upload is replaced or removed). */
    function forgetCustom() {
      audio.custom = undefined
      audio.loading = undefined
      audio.loadedKey = ''
      audio.waiting.length = 0
    }

    /** One peak-normalized playback of the uploaded clip. */
    function playCustomBuffer(buffer, volume) {
      const ctx = audio.ctx
      if (ctx === undefined || buffer === undefined) return

      let peak = 0
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel)
        for (let index = 0; index < data.length; index += 1) {
          const value = data[index] < 0 ? -data[index] : data[index]
          if (value > peak) peak = value
        }
      }
      if (peak <= 0) return

      const source = ctx.createBufferSource()
      source.buffer = buffer
      const gain = ctx.createGain()
      // Normalize the clip to full scale (bounded, so a near-silent recording
      // cannot be amplified into noise) and let the volume scale it down from
      // there. The limiter downstream catches the overshoot an over-unity
      // volume produces, so the user's "louder" is honoured without clipping.
      gain.gain.value = Math.min(8, 0.98 / peak) * clamp(volume, 0, MAX_VOLUME)
      source.connect(gain)
      gain.connect(audio.master ?? ctx.destination)
      source.start(ctx.currentTime + 0.02)
      source.onended = () => {
        try {
          gain.disconnect()
        } catch {
          // Already collected.
        }
      }
    }

    // ---------------------------------------------------------------------
    // Playback
    // ---------------------------------------------------------------------

    /** Last playback start, for the cooldown gate. */
    let lastPlayedAt = 0

    /**
     * Play one alert.
     *
     * @param options - `voice`, `toolName` (routes the voice), `sound` (an
     *   explicit profile, used by the test button), `force` (bypasses the
     *   cooldown and the silence setting), `volume` and `repeat`.
     * @returns the number of strikes scheduled (0 when nothing was audible).
     */
    function playAlert(options = {}) {
      const forced = options.force === true
      // The gate is deliberately checked before the cooldown: a disabled or
      // muted plugin must be silent, not merely silent "unless the cooldown
      // happened to have elapsed".
      if (!forced && (config.enabled === false || config.volume <= 0)) return 0

      const profile = forced
        ? (options.sound ?? config.sound)
        : config.sound
      if (profile === 'off') return 0
      if (profile !== 'custom' && typeof VOICES[profile] !== 'function') return 0
      if (!audioSupported()) {
        audio.error = 'Web Audio is unavailable in this browser'
        notifyAudio()
        return 0
      }

      const ctx = ensureAudio()
      if (ctx === undefined) return 0

      // A suspended context silently swallows scheduled notes, so the first
      // gesture is the real "armed" moment: resume, then play.
      if (ctx.state !== 'running') {
        unlockAudio()
        if (ctx.state !== 'running') {
          const started = ctx.resume()
          if (started !== undefined && typeof started.then === 'function') {
            started.then(() => { void playNow({ ...options, sound: profile }) }, () => {})
          }
          return 0
        }
      }
      return playNow({ ...options, sound: profile })
    }

    /** Schedule the strikes; the context is known to be running here. */
    function playNow(options) {
      const ctx = audio.ctx
      if (ctx === undefined || ctx.state !== 'running') {
        return 0
      }

      const now = Date.now()
      // A requeued playback is the *continuation* of an alert already accepted,
      // not a new one: applying the cooldown to it would silently drop the very
      // alert the user is waiting for (the case that matters is the first alert
      // after an upload, which arrives while the clip is still decoding).
      if (options.requeued !== true && options.force !== true && config.cooldownMs > 0 && now - lastPlayedAt < config.cooldownMs) return 0

      const profile = options.sound ?? config.sound
      if (profile === 'off') return 0

      const volume = clamp(options.volume ?? config.volume, 0, MAX_VOLUME)
      const strikes = options.force === true
        ? Math.max(1, Math.round(options.repeat ?? config.repeat) + 1)
        : Math.max(1, Math.round(config.repeat) + 1)
      const gap = (options.repeatIntervalMs ?? config.repeatIntervalMs) / 1000
      const master = audio.master ?? ctx.destination

      if (profile === 'custom') {
        if (config.customName === '') return 0
        // The clip is fetched lazily and on demand, so the first alert (or a
        // test click right after an upload) can land mid-decode. Queueing it
        // means the user hears the alert they asked for rather than silence.
        if (audio.custom === undefined) {
          if (audio.loading === undefined) void loadCustom()
          // A clip that failed to load must not queue forever: without this the
          // page would keep waiting and the prompt would go unanswered audibly.
          if (audio.loading === undefined && audio.error === null) return 0
          // Bound the queue: a persistent fetch failure must not grow it once
          // per prompt for the life of the page.
          if (audio.waiting.length < 8) {
            audio.waiting.push(() => { void playNow({ ...options, requeued: true }) })
          }
          return 0
        }
        lastPlayedAt = now
        try {
          for (let index = 0; index < strikes; index += 1) {
            // One strike per repetition: repeating is the user's choice to nag,
            // and spacing is already encoded in the clip itself.
            const delay = index * gap
            if (delay === 0) playCustomBuffer(audio.custom, volume)
            else window.setTimeout(() => playCustomBuffer(audio.custom, volume), delay * 1000)
          }
        } catch (error) {
          audio.error = messageOf(error)
          notifyAudio()
          return 0
        }
        if (!audio.unlocked) {
          audio.unlocked = true
          notifyAudio()
        }
        return strikes
      }

      const voice = options.voice ?? (options.entry !== undefined ? voiceOf(options.entry) : 'generic')
      // Deterministic per-voice detune: the same prompt family always sounds the
      // same, while a different one is audibly different.
      const pitch = options.pitch ?? VOICE_PITCH[voice] ?? 1

      const gain = ctx.createGain()
      gain.gain.value = volume
      gain.connect(master)

      const base = ctx.currentTime + 0.03
      try {
        for (let index = 0; index < strikes; index += 1) {
          VOICES[profile](ctx, gain, base + index * gap, 1, pitch)
        }
      } catch (error) {
        audio.error = messageOf(error)
        notifyAudio()
        return 0
      }

      lastPlayedAt = now
      if (!audio.unlocked) {
        audio.unlocked = true
        notifyAudio()
      }
      // Release the per-playback node once the tail has decayed.
      const lifetime = ((strikes - 1) * gap + 2) * 1000
      window.setTimeout(() => {
        try {
          gain.disconnect()
        } catch {
          // Already collected.
        }
      }, lifetime)
      return strikes
    }

    // ---------------------------------------------------------------------
    // The approval watcher (page side)
    // ---------------------------------------------------------------------

    /**
     * Ids this page has already evaluated for alerting.
     *
     * Completion with the host is what the guard tracks, not history: an id in
     * this set is either one the page has already alerted for, or one that was
     * already open at the moment the page took its first sight of the pending
     * set. `seeded` marks that first sight, and it is why an id may sit in the
     * set unalerted only until the next poll. Ids the host stops reporting are
     * dropped, so the set stays bounded by the number of *currently* open
     * prompts rather than by requests per page lifetime.
     */
    const announced = new Set()
    let primed = false

    /**
     * Highest request sequence the page has reported on.
     *
     * The host numbers requests from a per-process counter, so this is the
     * authoritative "have I seen this one before" axis. It is what makes a lost
     * poll harmless: if the pending list reads empty for one tick — a hiccup, a
     * suspended tab, a momentary host restart — the id disappears from
     * `announced`, and without this counter the very same still-open prompt
     * would come back looking new and alert a second time.
     */
    let maxSeq = 0

    /** The request counter suffix, or undefined for an unexpected id shape. */
    function seqOf(id) {
      const match = /^a(\d+)$/.exec(id)
      if (match === null) return undefined
      const value = Number(match[1])
      return Number.isFinite(value) ? value : undefined
    }

    /**
     * Subscribers to configuration changes.
     *
     * The settings card is the only consumer: it renders from the live `config`
     * and needs to re-render when the host (or another window) changes it. The
     * page's own alert path reads `config` directly and never waits on a
     * listener.
     */
    const configListeners = new Set()

    function notifyConfig() {
      for (const listener of [...configListeners]) {
        try {
          listener()
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
    }

    /**
     * Adopt one host document: configuration and pending set.
     *
     * The configuration is published only when it actually CHANGED — the poll
     * runs every 700ms, and re-rendering an open settings card on every tick
     * would be pure waste.
     */
    function absorb(payload) {
      if (payload === null || typeof payload !== 'object') return
      if (payload.config !== undefined) {
        const next = resolveConfig({ ...config, ...payload.config })
        const changed = JSON.stringify(next) !== JSON.stringify(config)
        config = next
        if (changed) notifyConfig()
      }

      const list = Array.isArray(payload.pending) ? payload.pending : []
      const ids = new Set()
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
        ids.add(entry.id)
      }

      // The priming moment is the first SUCCESSFUL poll, regardless of what it
      // reports: a host that could not be reached has told the page nothing, so
      // the first real answer — even an empty one — is what defines "already
      // open when I first looked", and everything in it is adopted silently.
      const seeding = primed === false

      for (const entry of list) {
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
        const seq = seqOf(entry.id)
        // Read the high-water mark *before* advancing it: an id equal to the
        // current maximum is one this page has already accounted for.
        const isNew = seq !== undefined && seq > maxSeq
        if (isNew) maxSeq = seq
        if (seeding || announced.has(entry.id)) {
          announced.add(entry.id)
          continue
        }
        announced.add(entry.id)
        // A sequence at or below the high-water mark was already accounted for,
        // even if a lost poll removed its id from `announced`. Only a genuinely
        // newer request — and only after a completed priming poll — is worth a
        // sound.
        if (seq !== undefined && !isNew) continue
        // `window.document` rather than the bare global: the focus/visibility
        // reads must resolve against the page this bundle was loaded into.
        if (config.onlyWhenUnfocused && typeof window.document?.hasFocus === 'function' && window.document.hasFocus()) continue
        playAlert({ entry })
      }
      primed = true

      // Forget ids the host no longer reports: a request id is never reused, so
      // this only discards closed prompts and keeps the set bounded.
      for (const id of [...announced]) {
        if (!ids.has(id)) announced.delete(id)
      }
    }

    /**
     * One poll. Never throws: a failed poll is a non-event.
     *
     * The next tick retries, and the page keeps whatever it learned last. An
     * outage simply means no alerts arrive while it lasts — there is no separate
     * failure state to publish, because nothing consumes one.
     */
    async function poll() {
      try {
        absorb(await API.pending())
      } catch {
        // Retried on the next tick.
      }
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const CSS = `
.dsh-approval-sound { display: flex; flex-direction: column; gap: 12px; }
.dsh-approval-sound__card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 14px 16px;
}
.dsh-approval-sound__title { font-size: 13px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; }
.dsh-approval-sound__row { font-size: 13px; color: var(--dsw-alias-label-primary); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-approval-sound__row + .dsh-approval-sound__row { margin-top: 6px; }
.dsh-approval-sound__meta { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.dsh-approval-sound__warn {
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-approval-sound__grid { display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: center; }
.dsh-approval-sound__item { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dsh-approval-sound__item input[type="number"] {
  width: 88px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dsh-approval-sound__item input[type="range"] { width: 130px; }
.dsh-approval-sound__item select {
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dsh-approval-sound__button {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  padding: 5px 12px;
  cursor: pointer;
}
.dsh-approval-sound__button:disabled { opacity: 0.55; cursor: default; }
`

    // ---------------------------------------------------------------------
    // The settings section
    // ---------------------------------------------------------------------

    function AudioRow(props) {
      const { audio: state, t, onTest } = props
      if (state.supported !== true) {
        return h('div', { className: 'dsh-approval-sound__warn' }, t('approvalSound.audio.unsupported'))
      }
      if (state.unlocked !== true) {
        return h('div', { className: 'dsh-approval-sound__warn' }, t('approvalSound.audio.locked'))
      }
      return h('div', { className: 'dsh-approval-sound__meta' },
        h('span', null, t('approvalSound.audio.ready')),
        state.customLoading === true
          ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('approvalSound.audio.loading'))
          : null,
        h('button', {
          type: 'button',
          className: 'dsh-approval-sound__button',
          onClick: onTest,
        }, t('approvalSound.test')),
      )
    }

    /**
     * The uploaded-alert row: what is installed, how to replace or remove it,
     * and why the last attempt failed.
     *
     * The file never leaves the machine: the browser reads it and POSTs the raw
     * bytes straight to this plugin's own loopback route.
     */
    function CustomRow(props) {
      const { effective, t, busy, onPick, onRemove } = props
      const installed = effective.customName !== ''

      return h('div', { className: 'dsh-approval-sound__card', key: 'custom' },
        h('div', { className: 'dsh-approval-sound__title' }, t('approvalSound.custom.title')),
        h('div', { className: 'dsh-approval-sound__row' },
          installed
            ? h('span', null, t('approvalSound.custom.installed', {
              name: effective.customName,
              size: formatBytes(effective.customBytes),
            }))
            : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('approvalSound.custom.none')),
        ),
        installed
          ? h('div', { className: 'dsh-approval-sound__meta' },
            h('span', null, effective.sound === 'custom'
              ? t('approvalSound.custom.active')
              : t('approvalSound.custom.inactive')),
          )
          : null,
        h('div', { className: 'dsh-approval-sound__row', style: { marginTop: '10px' } },
          h('button', {
            type: 'button',
            className: 'dsh-approval-sound__button',
            disabled: busy,
            onClick: onPick,
          }, installed ? t('approvalSound.custom.replace') : t('approvalSound.custom.upload')),
          installed
            ? h('button', {
              type: 'button',
              className: 'dsh-approval-sound__button',
              disabled: busy,
              onClick: onRemove,
            }, t('approvalSound.custom.remove'))
            : null,
        ),
        h('div', { className: 'dsh-approval-sound__meta' },
          h('span', null, t('approvalSound.custom.formats')),
        ),
      )
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
      return `${(value / 1024 / 1024).toFixed(2)} MiB`
    }

    /**
     * Everything the mounted section needs from the plugin run. Held in a
     * module-scope box (rather than a per-render closure) so the component
     * identity stays stable: a fresh component function on every render would
     * remount the section and drop its local state on each settings refresh.
     */
    let mount = undefined

    function ApprovalSoundSection() {
      const { t, settings, writable, onTest, onPick, onRemove } = mount
      const [tick, setTick] = React.useState(0)
      const [local, setLocal] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [fileError, setFileError] = React.useState(undefined)

      /**
       * Run one file action with the card's busy flag and error line wired up.
       * The actions themselves live on the plugin run (they own the fetches),
       * so all state they need to report is funnelled back through here.
       */
      const runFileAction = (action) => {
        setBusy(true)
        setFileError(undefined)
        Promise.resolve(action()).then(
          (failure) => {
            setBusy(false)
            if (failure !== undefined && failure !== null) setFileError(failure)
          },
          (error) => {
            setBusy(false)
            setFileError(messageOf(error))
          },
        )
      }

      // Re-render on a configuration change and on any audio-engine transition.
      React.useEffect(() => {
        const bump = () => {
          setTick((count) => count + 1)
          // Surface a failed custom-clip load/fetch on the same error line the
          // picker writes to, so a failed upload is never silent.
          const snapshot = audioSnapshot()
          if (typeof snapshot.error === 'string' && snapshot.error.startsWith('custom sound: ') && snapshot.customReady !== true) {
            setFileError(snapshot.error.slice('custom sound: '.length))
          }
        }
        configListeners.add(bump)
        audio.listeners.add(bump)
        return () => {
          configListeners.delete(bump)
          audio.listeners.delete(bump)
        }
      }, [])

      // The host is authoritative; a local draft only covers the window between
      // a control moving and its write settling.
      const effective = resolveConfig({ ...config, ...(local ?? {}) })
      void tick

      const write = (key, value) => {
        setLocal((current) => ({ ...(current ?? {}), [key]: value }))
        const patch = { [key]: value }
        const call = writable ? settings.set(key, value) : API.setConfig(patch)
        Promise.resolve(call).then(() => {
          setLocal((current) => {
            if (current === undefined) return current
            const next = { ...current }
            delete next[key]
            return Object.keys(next).length === 0 ? undefined : next
          })
          // Pull the persisted value back so clamps are visible immediately.
          void poll()
        }, () => {
          setLocal((current) => {
            if (current === undefined) return current
            const next = { ...current }
            delete next[key]
            return Object.keys(next).length === 0 ? undefined : next
          })
        })
      }

      const commitNumber = (key, raw, min, max) => {
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) return
        write(key, clamp(parsed, min, max))
      }

      const cards = []

      cards.push(AudioRow({ audio: audioSnapshot(), t, onTest }))
      cards.push(CustomRow({
        effective,
        t,
        busy,
        onPick: () => runFileAction(onPick),
        onRemove: () => runFileAction(onRemove),
      }))
      if (fileError !== undefined) {
        cards.push(h('div', { className: 'dsh-approval-sound__warn', key: 'custom-error' },
          t('approvalSound.custom.failed', { error: String(fileError) })))
      }

      cards.push(h('div', { className: 'dsh-approval-sound__card', key: 'config' },
        h('div', { className: 'dsh-approval-sound__title' }, t('approvalSound.config.title')),
        h('div', { className: 'dsh-approval-sound__grid' },
          h('label', { className: 'dsh-approval-sound__item', key: 'enabled' },
            h('input', {
              type: 'checkbox',
              checked: effective.enabled,
              onChange: (event) => { write('enabled', event.target.checked) },
            }),
            t('approvalSound.config.enabled'),
          ),
          h('label', { className: 'dsh-approval-sound__item', key: 'sound' },
            t('approvalSound.config.sound'),
            h('select', {
              value: effective.sound,
              onChange: (event) => { write('sound', event.target.value) },
            }, SOUND_NAMES.map((name) => h('option', { key: name, value: name }, t(`approvalSound.sound.${name}`)))),
          ),
          h('label', { className: 'dsh-approval-sound__item', key: 'volume' },
            t('approvalSound.config.volume'),
            h('input', {
              type: 'range', min: 0, max: MAX_VOLUME, step: 0.05,
              value: effective.volume,
              onChange: (event) => { write('volume', Number(event.target.value)) },
            }),
            h('span', null, `${Math.round(effective.volume * 100)}%`),
          ),
          h('label', { className: 'dsh-approval-sound__item', key: 'repeat' },
            t('approvalSound.config.repeat'),
            h('input', {
              type: 'number', min: 1, max: 6, step: 1,
              title: t('approvalSound.config.repeatHint'),
              value: effective.repeat + 1,
              onChange: (event) => { commitNumber('repeat', Number(event.target.value) - 1, 0, 5) },
            }),
          ),
          h('label', { className: 'dsh-approval-sound__item', key: 'interval' },
            t('approvalSound.config.interval'),
            h('input', {
              type: 'number', min: 120, max: 5000, step: 50,
              value: effective.repeatIntervalMs,
              onChange: (event) => { commitNumber('repeatIntervalMs', event.target.value, 120, 5000) },
            }),
          ),
          h('label', { className: 'dsh-approval-sound__item', key: 'cooldown' },
            t('approvalSound.config.cooldown'),
            h('input', {
              type: 'number', min: 0, max: 10000, step: 100,
              title: t('approvalSound.config.cooldownHint'),
              value: effective.cooldownMs,
              onChange: (event) => { commitNumber('cooldownMs', event.target.value, 0, 10000) },
            }),
          ),
          h('label', { className: 'dsh-approval-sound__item', key: 'unfocused' },
            h('input', {
              type: 'checkbox',
              checked: effective.onlyWhenUnfocused,
              onChange: (event) => { write('onlyWhenUnfocused', event.target.checked) },
            }),
            t('approvalSound.config.unfocused'),
          ),
          h('button', {
            type: 'button',
            className: 'dsh-approval-sound__button',
            key: 'test',
            onClick: onTest,
          }, t('approvalSound.test')),
        ),
        !writable
          ? h('div', { className: 'dsh-approval-sound__warn', style: { marginTop: '10px' } }, t('approvalSound.config.readonly'))
          : null,
      ))

      return h('div', { className: 'dsh-approval-sound' }, cards)
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    exports.apply = function apply(ctx) {
      const t = makeT(ctx)

      ctx.effect(() => {
        try {
          const dispose = ctx.locale.register(NS, { zh, en })
          return typeof dispose === 'function' ? dispose : () => {}
        } catch {
          return () => {}
        }
      }, 'dsh-approval-sound: dictionaries')

      ctx.effect(() => {
        try {
          const el = window.document.createElement('style')
          el.setAttribute('data-plugin', NS)
          el.textContent = CSS
          window.document.head.appendChild(el)
          return () => { try { el.remove() } catch { /* already gone */ } }
        } catch {
          return () => {}
        }
      }, 'dsh-approval-sound: styles')

      ctx.effect(() => armGestureUnlock(), 'dsh-approval-sound: audio unlock')

      // The host half registers this namespace through `settings`. When the
      // harness exposes no settings service the controls fall back to this
      // plugin's own fenced config route, so the section stays functional.
      let settings = undefined
      let writable = false
      try {
        const binder = ctx.get('webUiSettings') ?? ctx.get('settingsScope')
        const bound = binder === undefined ? undefined : binder.bind({ namespace: NS })
        // A binder can resolve to something that does not implement the scope
        // contract (the settings seam is opportunistic), and a control must not
        // throw from its event handler, so the shape is checked once here.
        if (bound !== undefined
          && typeof bound.set === 'function'
          && typeof bound.getSnapshot === 'function'
          && typeof bound.subscribe === 'function') {
          settings = bound
          writable = true
        }
      } catch {
        settings = undefined
      }

      /** The settings card's test ping: audible regardless of the gate state. */
      const onTest = () => {
        // A click is a user gesture, so this both unlocks and proves the voice.
        unlockAudio()
        const profile = config.sound === 'off' ? 'alert' : config.sound
        // A custom clip is fetched on demand, so warm it before the first real
        // alert rather than making the user's first prompt wait for a download.
        if (profile === 'custom' && audio.custom === undefined) void loadCustom()
        playAlert({ voice: 'test', force: true, sound: profile, volume: Math.max(0.5, config.volume) })
      }

      /**
       * Upload one file as the alert.
       *
       * A programmatic `input[type=file]` click is the only way a page can read
       * a local file without a drag target, and the file is read as raw bytes so
       * no multipart parser is needed on either side.
       *
       * @returns an error message, or undefined on success.
       */
      const pickAndUpload = () => new Promise((resolve) => {
        let input
        try {
          input = window.document.createElement('input')
        } catch (error) {
          resolve(messageOf(error))
          return
        }
        input.type = 'file'
        input.accept = 'audio/*,.wav,.mp3,.ogg,.m4a,.aac,.flac,.webm'
        input.style.display = 'none'

        const finish = (result) => {
          try {
            input.remove()
          } catch {
            // Never attached.
          }
          resolve(result)
        }

        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (file === undefined) {
            finish(undefined)
            return
          }
          void (async () => {
            try {
              const bytes = await file.arrayBuffer()
              const response = await fetch(API.sound, {
                method: 'POST',
                headers: {
                  'content-type': 'application/octet-stream',
                  // `encodeURIComponent` keeps a non-ASCII file name intact
                  // through the header, which is ASCII-only on the wire.
                  'x-dsh-sound-name': encodeURIComponent(file.name),
                },
                body: bytes,
                signal: AbortSignal.timeout(60_000),
              })
              const body = await response.json().catch(() => undefined)
              if (!response.ok) {
                finish(body?.error ?? `upload failed: ${response.status}`)
                return
              }
              // The stored file is new, so any decoded clip is stale.
              forgetCustom()
              // `absorb` publishes the config change to the card itself.
              absorb(body)
              void loadCustom()
              finish(undefined)
            } catch (error) {
              finish(messageOf(error))
            }
          })()
        })

        // A dismissed picker fires nothing at all in most browsers, so the
        // pending promise is resolved by the window regaining focus.
        window.addEventListener('focus', () => {
          window.setTimeout(() => {
            if (input.parentNode === null) return
            finish(undefined)
          }, 500)
        }, { once: true })

        try {
          window.document.body.appendChild(input)
        } catch {
          // A body-less document still lets the click open the picker.
        }
        input.click()
      })

      /** Remove the stored alert and fall back to a built-in voice. */
      const removeCustom = async () => {
        try {
          const response = await fetch(API.sound, { method: 'DELETE', signal: AbortSignal.timeout(15_000) })
          const body = await response.json().catch(() => undefined)
          if (!response.ok) return body?.error ?? `delete failed: ${response.status}`
          forgetCustom()
          // `absorb` publishes the config change to the card itself.
          if (body !== undefined) absorb(body)
          return undefined
        } catch (error) {
          return messageOf(error)
        }
      }

      mount = { t, settings, writable, onTest, onPick: pickAndUpload, onRemove: removeCustom }
      // The same box the mounted section reads. Exposed so a test (or a future
      // second seat) can drive the actions without going through React events.
      mount.__audio = audioSnapshot
      mount.__config = () => ({ ...config })
      exports.__mount = mount

      if (settings === undefined) {
        settings = {
          getSnapshot: () => ({ value: {}, writable: false }),
          subscribe: () => () => {},
          set: async () => {},
        }
        mount = { t, settings, writable: false, onTest }
      }

      if (typeof ctx.slots?.inject !== 'function') return

      ctx.slots.inject('settings.section', () => {
        try {
          const unregister = ctx.slots.register({
            name: 'settings.section',
            id: NS,
            order: SECTION_ORDER,
            label: () => t('approvalSound.title'),
            locale: NS,
          }, ApprovalSoundSection)
          return () => { unregister() }
        } catch {
          return () => {}
        }
      })

      // The poll loop is page-scoped and lives with the plugin run: it starts on
      // load (so a prompt raised while the user is elsewhere still alerts) and
      // is torn down with the plugin.
      ctx.effect(() => {
        let stopped = false
        let timer

        const tick = () => {
          if (stopped) return
          if (window.document.visibilityState === 'hidden') return
          void poll()
        }

        // Prime immediately: the first response seeds the already-open set
        // instead of alerting for a prompt that predates this page.
        void poll()
        timer = window.setInterval(tick, POLL_MS)

        // Returning to a tab must not replay a backlog: the pending set is
        // re-read, and anything that became pending *and* was answered while
        // the tab was hidden is deliberately not announced (it is already over).
        const onVisible = () => {
          if (window.document.visibilityState === 'visible') void poll()
        }
        window.document.addEventListener('visibilitychange', onVisible)

        return () => {
          stopped = true
          if (timer !== undefined) window.clearInterval(timer)
          window.document.removeEventListener('visibilitychange', onVisible)
        }
      }, 'dsh-approval-sound: approval poll')
    }

    return module.exports
  },
})
