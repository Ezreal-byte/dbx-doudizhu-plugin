import type { Profile } from '../types'
import { invoke } from '../client'
import { rank } from './cards'
import voiceManifest from './voice-manifest.json'

export interface VoiceCue {
  kind: 'bid' | 'double' | 'pass' | 'play' | 'win' | 'lose' | 'gift' | 'phrase'
  character: number
  score?: number
  doubled?: boolean
  cards?: number[]
  playKind?: string
  gift?: string
  text?: string
  eventId: string
}
interface Clip { file: string; text: string; duration: number }
interface MusicFile { name: string; mime: string; dataBase64: string }
interface QueuedVoice { clip?: Clip; text: string; character: number; at: number; epoch: number }
const clips = voiceManifest.cues as Record<string, Record<string, Clip[]>>
const MAX_MUSIC_BYTES = 4 * 1024 * 1024
const clamp = (value: number | undefined, fallback: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value! : fallback))

function decodeBase64(value: string): ArrayBuffer {
  const text = atob(value)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes.buffer
}
function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)))
  return btoa(chunks.join(''))
}

/** Local soundtrack and a bundled, pre-rendered neural character voice pack. */
class GardenAudio {
  private ctx: AudioContext | null = null
  private musicGain: GainNode | null = null
  private voiceGain: GainNode | null = null
  private effectsGain: GainNode | null = null
  private musicSource: AudioBufferSourceNode | null = null
  private currentVoice: AudioBufferSourceNode | null = null
  private profile: Partial<Profile> = { music: .25, sound: .65, voice: .6 }
  private scene: 'lobby' | 'table' = 'lobby'
  private buffers = new Map<string, Promise<AudioBuffer>>()
  private queue: QueuedVoice[] = []
  private seen = new Set<string>()
  private variations = new Map<string, number>()
  private playingVoice = false
  private voiceEpoch = 0
  private trackEpoch = 0
  private imported: MusicFile | null = null
  private importedBuffer: AudioBuffer | null = null
  private restoreMusicTask: Promise<void> | null = null
  private musicPreferenceVersion = 0
  private disposed = false
  private visibility = () => {
    if (!this.ctx) return
    if (document.hidden) {
      this.resetVoices()
      void this.ctx.suspend().catch(() => undefined)
    } else void this.ctx.resume().catch(() => undefined)
  }

  get importedMusicName() { return this.imported?.name ?? '' }

  async musicPreferenceReady() { await this.restoreMusicTask }

  async unlock() {
    if (this.disposed) return
    if (!this.ctx) {
      this.ctx = new AudioContext()
      const master = this.ctx.createDynamicsCompressor()
      master.threshold.value = -6
      master.knee.value = 12
      master.ratio.value = 3
      master.attack.value = .008
      master.release.value = .22
      master.connect(this.ctx.destination)
      this.musicGain = this.ctx.createGain()
      this.voiceGain = this.ctx.createGain()
      this.effectsGain = this.ctx.createGain()
      this.musicGain.connect(master)
      this.voiceGain.connect(master)
      this.effectsGain.connect(master)
      this.applyMix()
      document.addEventListener('visibilitychange', this.visibility)
    }
    await this.ctx.resume()
    if (!this.restoreMusicTask) {
      this.restoreMusicTask = this.restoreSavedMusic()
      void this.restoreMusicTask.then(() => this.startMusic()).catch(() => this.startMusic())
    }
  }

  configure(profile: Profile) {
    this.profile = profile
    if (profile.voice === 0) this.resetVoices()
    this.applyMix()
  }

  setScene(scene: 'lobby' | 'table') {
    if (scene !== this.scene && scene === 'lobby') this.resetVoices()
    this.scene = scene
    this.applyMix()
  }

  private applyMix() {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    const duck = this.playingVoice ? .23 : 1
    this.musicGain?.gain.setTargetAtTime(clamp(this.profile.music, .25) * (this.scene === 'lobby' ? .65 : .8) * duck, now, .09)
    this.voiceGain?.gain.setTargetAtTime(clamp(this.profile.voice, .6), now, .025)
    this.effectsGain?.gain.setTargetAtTime(clamp(this.profile.sound, .65) * .5, now, .025)
  }

  private async assetBuffer(path: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(path)
    if (cached) return cached
    const task = (async () => {
      const context = this.ctx
      if (!context) throw new Error('音频尚未开启')
      let bytes: ArrayBuffer
      if (window.dbxPlugin) {
        await window.dbxPlugin.ready
        const asset = await window.dbxPlugin.readAsset(path)
        bytes = decodeBase64(asset.dataBase64)
      } else {
        // Standalone development preview only; DBX reads assets under connect-src 'none'.
        const response = await fetch(`./${path}`)
        if (!response.ok) throw new Error(`音频资源未找到：${path}`)
        bytes = await response.arrayBuffer()
      }
      return context.decodeAudioData(bytes)
    })()
    this.buffers.set(path, task)
    if (this.buffers.size > 64) {
      const oldest = [...this.buffers.keys()].find(key => key !== 'assets/audio/garden-table.ogg')
      if (oldest) this.buffers.delete(oldest)
    }
    try { return await task } catch (error) { this.buffers.delete(path); throw error }
  }

  private async restoreSavedMusic() {
    if (!window.dbxPlugin) return
    const version = this.musicPreferenceVersion
    try {
      const saved = await invoke<MusicFile | null>('music.get')
      if (!saved || this.imported || this.disposed || version !== this.musicPreferenceVersion) return
      const bytes = decodeBase64(saved.dataBase64)
      if (bytes.byteLength > MAX_MUSIC_BYTES) return
      const decoded = await this.ctx!.decodeAudioData(bytes)
      if (this.disposed || this.imported || version !== this.musicPreferenceVersion) return
      this.imported = saved
      this.importedBuffer = decoded
    } catch { /* Missing local files or older hosts use the bundled original. */ }
  }

  private async startMusic() {
    const epoch = ++this.trackEpoch
    try {
      const buffer = this.importedBuffer ?? await this.assetBuffer('assets/audio/garden-table.ogg')
      if (this.disposed || epoch !== this.trackEpoch || !this.ctx || !this.musicGain) return
      this.musicSource?.stop()
      this.musicSource?.disconnect()
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.connect(this.musicGain)
      source.start()
      this.musicSource = source
      this.applyMix()
    } catch { /* Gameplay stays available if a decoder is unavailable. */ }
  }

  async importMusic(file: File): Promise<{ name: string }> {
    if (!file.size || file.size > MAX_MUSIC_BYTES) throw new Error('请选择不超过 4 MB 的音乐文件。')
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!['mp3', 'ogg', 'wav', 'm4a'].includes(extension ?? '')) throw new Error('支持 MP3、OGG、WAV 和 M4A 格式。')
    await this.unlock()
    const bytes = await file.arrayBuffer()
    let decoded: AudioBuffer
    try { decoded = await this.ctx!.decodeAudioData(bytes.slice(0)) } catch { throw new Error('这段音频无法播放，请换一个 MP3、OGG、WAV 或 M4A 文件。') }
    if (!Number.isFinite(decoded.duration) || decoded.duration < 1 || decoded.duration > 600) throw new Error('请选择 1 秒至 10 分钟之间的音乐。')
    const mime = extension === 'mp3' ? 'audio/mpeg' : extension === 'ogg' ? 'audio/ogg' : extension === 'm4a' ? 'audio/mp4' : 'audio/wav'
    let imported = { name: file.name.slice(0, 80), mime, dataBase64: encodeBase64(bytes) }
    this.musicPreferenceVersion++
    if (window.dbxPlugin) imported = await invoke<MusicFile>('music.set', imported)
    this.imported = imported
    this.importedBuffer = decoded
    await this.startMusic()
    return { name: imported.name }
  }

  async clearImportedMusic() {
    this.musicPreferenceVersion++
    if (window.dbxPlugin) await invoke('music.set', { clear: true })
    this.imported = null
    this.importedBuffer = null
    await this.startMusic()
  }

  private voiceKey(cue: VoiceCue): string {
    if (cue.kind === 'bid') return `bid-${Math.min(3, Math.max(0, cue.score ?? 0))}`
    if (cue.kind === 'double') return `double-${cue.doubled ? 1 : 0}`
    if (cue.kind === 'gift') return cue.gift ?? 'like'
    if (cue.kind === 'phrase') {
      const phrase = cue.text ?? ''
      if (/合作|配合/.test(phrase)) return 'phrase-team'
      if (/漂亮|好牌|厉害/.test(phrase)) return 'phrase-good'
      if (/快|等|急|想/.test(phrase)) return 'phrase-hurry'
      if (/再来|再战|不要走|天亮/.test(phrase)) return 'phrase-again'
      return 'phrase-hello'
    }
    if (cue.kind !== 'play') return cue.kind
    if (cue.playKind === 'single' && cue.cards?.length) return `single-${rank(cue.cards[0]!)}`
    if (cue.playKind === 'pair' && cue.cards?.length) return `pair-${rank(cue.cards[0]!)}`
    const kinds: Record<string, string> = {
      tripleSingle: 'triple-single', triplePair: 'triple-pair', pairStraight: 'pair-straight',
      airplaneSingle: 'airplane-single', airplanePair: 'airplane-pair', fourTwoSingle: 'four-two-single', fourTwoPair: 'four-two-pair',
    }
    return kinds[cue.playKind ?? ''] ?? cue.playKind ?? 'play'
  }

  voice(cue: VoiceCue) {
    if (!this.ctx || this.ctx.state !== 'running' || !this.profile.voice || this.disposed || document.hidden) return
    if (cue.eventId && this.seen.has(cue.eventId)) return
    if (cue.eventId) {
      this.seen.add(cue.eventId)
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!)
    }
    const character = Math.min(4, Math.max(0, Math.trunc(cue.character)))
    this.enqueue(this.voiceKey(cue), character, cue.text)
  }

  private enqueue(key: string, character: number, fallback?: string) {
    const options = clips[String(character)]?.[key] ?? clips[String(character)]?.play ?? []
    const variationKey = `${character}:${key}`
    const count = this.variations.get(variationKey) ?? 0
    this.variations.set(variationKey, count + 1)
    const clip = options.length ? options[count % options.length] : undefined
    const item = { clip, text: clip?.text ?? fallback ?? '', character, at: Date.now(), epoch: this.voiceEpoch }
    if (key === 'win' || key === 'lose') this.queue = []
    if (this.queue.length >= 5) this.queue.shift()
    this.queue.push(item)
    void this.drainVoices()
  }

  async previewVoice(character: number) {
    await this.unlock()
    if (!this.profile.voice) return
    this.resetVoices()
    this.enqueue('preview', Math.min(4, Math.max(0, Math.trunc(character))))
  }

  speak(text: string) {
    if (!this.ctx || !this.profile.voice) return
    this.queue.push({ text, character: this.profile.character ?? 0, at: Date.now(), epoch: this.voiceEpoch })
    void this.drainVoices()
  }

  private async drainVoices() {
    if (this.playingVoice || this.disposed) return
    const item = this.queue.shift()
    if (!item) return
    if (item.epoch !== this.voiceEpoch || Date.now() - item.at > 7000 || !this.profile.voice) { void this.drainVoices(); return }
    this.playingVoice = true
    this.applyMix()
    try {
      if (item.clip) {
        const buffer = await this.assetBuffer(item.clip.file)
        if (item.epoch !== this.voiceEpoch || this.disposed || !this.ctx || this.ctx.state !== 'running' || !this.voiceGain) return
        await new Promise<void>(resolve => {
          const source = this.ctx!.createBufferSource()
          source.buffer = buffer
          source.connect(this.voiceGain!)
          source.onended = () => { source.disconnect(); if (this.currentVoice === source) this.currentVoice = null; resolve() }
          this.currentVoice = source
          source.start()
        })
      } else await this.localSpeech(item)
    } catch {
      if (item.epoch === this.voiceEpoch) await this.localSpeech(item)
    } finally {
      this.playingVoice = false
      this.applyMix()
      void this.drainVoices()
    }
  }

  private localSpeech(item: QueuedVoice): Promise<void> {
    if (!item.text || !('speechSynthesis' in window) || item.epoch !== this.voiceEpoch) return Promise.resolve()
    const voices = speechSynthesis.getVoices().filter(voice => voice.localService && voice.lang.startsWith('zh'))
    if (!voices.length) return Promise.resolve()
    return new Promise(resolve => {
      const utterance = new SpeechSynthesisUtterance(item.text)
      utterance.voice = voices[item.character % voices.length]!
      utterance.lang = 'zh-CN'
      utterance.volume = clamp(this.profile.voice, .6)
      utterance.rate = [1.08, 1.12, .98, 1.03, 1.13][item.character]!
      utterance.pitch = [1.02, 1.13, .85, 1.04, 1.08][item.character]!
      const timeout = setTimeout(resolve, 10000)
      utterance.onend = utterance.onerror = () => { clearTimeout(timeout); resolve() }
      speechSynthesis.speak(utterance)
    })
  }

  resetVoices() {
    this.voiceEpoch++
    this.queue = []
    this.currentVoice?.stop()
    this.currentVoice = null
    if ('speechSynthesis' in window) speechSynthesis.cancel()
  }

  private tone(frequency: number, duration: number, volume: number, type: OscillatorType = 'sine', delay = 0) {
    if (!this.ctx || this.ctx.state !== 'running' || !this.effectsGain || !this.profile.sound) return
    const start = this.ctx.currentTime + delay
    const oscillator = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    oscillator.type = type
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(volume, start + .008)
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration)
    oscillator.connect(gain)
    gain.connect(this.effectsGain)
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
    oscillator.start(start)
    oscillator.stop(start + duration + .01)
  }

  private noise(duration: number, volume: number, cutoff: number, delay = 0) {
    if (!this.ctx || !this.effectsGain || !this.profile.sound) return
    const length = Math.floor(this.ctx.sampleRate * duration)
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) channel[i] = (Math.random() * 2 - 1) * Math.exp(-i / length * 6)
    const source = this.ctx.createBufferSource()
    const filter = this.ctx.createBiquadFilter()
    const gain = this.ctx.createGain()
    source.buffer = buffer
    filter.type = 'lowpass'
    filter.frequency.value = cutoff
    gain.gain.value = volume
    source.connect(filter)
    filter.connect(gain)
    gain.connect(this.effectsGain)
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect() }
    source.start(this.ctx.currentTime + delay)
  }

  effect(kind: string) {
    if (!this.ctx || this.ctx.state !== 'running' || !this.profile.sound) return
    if (['win', 'flower', 'like', 'spring'].includes(kind)) {
      [587, 740, 880, 1175].forEach((note, i) => this.tone(note, .5, .13, 'sine', i * .085))
      this.tone(293, .7, .1, 'triangle')
    } else if (['bomb', 'rocket'].includes(kind)) {
      this.noise(.65, .5, 1200)
      this.tone(56, .75, .28, 'sine')
      ;[440, 660, 880].forEach((note, i) => this.tone(note, .22, .05, 'triangle', .2 + i * .07))
    } else if (kind === 'lose') {
      [392, 370, 293].forEach((note, i) => this.tone(note, .45, .09, 'triangle', i * .16))
    } else if (kind === 'tea') {
      this.noise(.6, .1, 1600)
      ;[1046, 988, 880].forEach((note, i) => this.tone(note, .2, .05, 'sine', .12 + i * .12))
    } else if (kind === 'tomato' || kind === 'egg') {
      this.noise(.22, .28, 700)
      this.tone(170, .16, .14, 'sine')
    } else if (kind === 'pass') {
      this.tone(270, .09, .04, 'triangle')
    } else {
      this.noise(.07, .06, 4200)
      this.tone(kind === 'double' ? 880 : 620, .11, .045, 'triangle')
    }
  }

  destroy() {
    this.disposed = true
    this.trackEpoch++
    this.resetVoices()
    document.removeEventListener('visibilitychange', this.visibility)
    this.musicSource?.stop()
    this.musicSource?.disconnect()
    this.musicSource = null
    void this.ctx?.close()
    this.ctx = null
    this.buffers.clear()
    this.importedBuffer = null
  }
}

export const audio = new GardenAudio()
