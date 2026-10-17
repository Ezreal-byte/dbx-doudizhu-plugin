<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { Profile, RoomInfo, Snapshot, SocialEvent } from './types'
import { actionId, bridge, copyText, errorText, invoke, isConnectedHost, previewProfile, readAssetUrl, subscribe } from './client'
import { createTableScene } from './game/TableScene'
import { characterPortrait } from './game/assets'
import { audio } from './game/audio'
import { tableCues, type TableCue } from './game/audio-events'

type Modal = 'create' | 'join' | 'direct' | 'invite' | 'settings' | 'leave' | 'rules' | null
type GameActionKind = 'bid' | 'double' | 'play' | 'pass' | 'trustee'
interface GameActionParams { score?: number; double?: boolean; cards?: number[]; enabled?: boolean }
const profile = ref<Profile>({ ...previewProfile })
const snapshot = ref<Snapshot | null>(null)
const rooms = ref<RoomInfo[]>([])
const addresses = ref<string[]>([])
const query = ref('')
const modal = ref<Modal>(null)
const joinRoom = ref<RoomInfo | null>(null)
const busy = ref('')
const scanning = ref(false)
const initialized = ref(false)
const preview = ref(!isConnectedHost())
const error = ref('')
const notice = ref('')
const now = ref(Date.now())
const connection = ref('connected')
const connectionMessage = ref('')
const sceneHost = ref<HTMLElement | null>(null)
const stageHost = ref<HTMLElement | null>(null)
const boardScale = ref(1)
const fallback = ref(false)
const selected = ref<number[]>([])
const socialTarget = ref<string | null>(null)
const socialText = ref<{ from: string; text: string } | null>(null)
const background = ref('')
const portraits = ref<string[]>([])
const speechBubbles = ref<{ seat: number; text: string; id: string; until: number }[]>([])
const importedMusicName = ref('')
const shellStyle = computed(() => ({ ...(background.value ? { '--landscape': `url("${background.value}")` } : {}), ...Object.fromEntries(portraits.value.map((url, index) => [`--portrait-${index}`, `url("${url}")`])) }))
const form = reactive({ name: '', password: '', initialBeans: 10000, locked: false, address: '', roomId: '' })
const settings = reactive({ ...previewProfile })
const characters = ['阿禾', '小满', '福伯', '青竹', '长安']
const characterMoods = ['元气少年', '甜笑锦鲤', '乐天老友', '清雅茶娘', '潇洒侠客']
const characterIcons = ['☀', '✿', '福', '竹', '安']
const gifts = [{ kind: 'tea', icon: '🍵', name: '倒茶' }, { kind: 'flower', icon: '🌷', name: '送花' }, { kind: 'like', icon: '👍', name: '点赞' }, { kind: 'tomato', icon: '🍅', name: '番茄' }, { kind: 'egg', icon: '🥚', name: '鸡蛋' }]
const phrases = ['快点吧，花儿都谢了！', '这牌打得真漂亮！', '和你合作真是太愉快了！', '不要走，决战到天亮！']
let table: Awaited<ReturnType<typeof createTableScene>> | null = null
let sceneGeneration = 0
let unlisten: () => void = () => undefined
let unclose: (() => void) | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let scanTimer: ReturnType<typeof setInterval> | undefined
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let socialTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | undefined
let polling = false
let hintCursor = 0
let lastHintKey = ''
let dead = false
let roomSession = 0
let operationSequence = 0
let resumeSilently = false
const seenSocial = new Set<string>()

const game = computed(() => snapshot.value?.game ?? null)
const self = computed(() => snapshot.value?.players.find(p => p.id === snapshot.value?.selfId))
const opponents = computed(() => (snapshot.value?.players.filter(p => p.id !== snapshot.value?.selfId) ?? []).sort((a, b) => ((b.seat - (self.value?.seat ?? 0) + 3) % 3) - ((a.seat - (self.value?.seat ?? 0) + 3) % 3)))
const leftPlayer = computed(() => opponents.value.find(p => (p.seat - (self.value?.seat ?? 0) + 3) % 3 === 2))
const rightPlayer = computed(() => opponents.value.find(p => (p.seat - (self.value?.seat ?? 0) + 3) % 3 === 1))
const myTurn = computed(() => game.value?.turn === self.value?.seat)
const phase = computed(() => game.value?.phase ?? 'waiting')
const seconds = computed(() => Math.max(0, Math.ceil(((game.value?.deadline ?? 0) - now.value) / 1000)))
const noActions = computed(() => Boolean(busy.value) || connection.value !== 'connected')
const selectedSorted = computed(() => [...selected.value].sort((a, b) => cardRank(b) - cardRank(a) || b - a))
const hand = computed(() => [...(game.value?.hand ?? [])].sort((a, b) => cardRank(b) - cardRank(a) || b - a))
const canPass = computed(() => Boolean(game.value?.lastPlay && game.value.lastPlay.seat !== self.value?.seat))
const hasDoubled = computed(() => self.value ? (game.value?.doubles[self.value.seat] ?? -1) >= 0 : false)
const yourDecision = computed(() => myTurn.value || (phase.value === 'doubling' && !hasDoubled.value))
const highestBid = computed(() => Math.max(0, ...(game.value?.bids ?? [])))
const myDelta = computed(() => self.value ? game.value?.settlement?.deltas[self.value.seat] ?? 0 : 0)
const won = computed(() => game.value && self.value ? (game.value.winner === game.value.landlord) === (self.value.seat === game.value.landlord) : false)
const activePlayer = computed(() => snapshot.value?.players.find(p => p.seat === game.value?.turn))
const targetPlayer = computed(() => snapshot.value?.players.find(p => p.id === socialTarget.value))
const roomPhaseNames: Record<string, string> = { waiting: '等待入座', bidding: '正在叫分', doubling: '正在加倍', playing: '对局中', finished: '等待下一局' }
const phaseName = computed(() => roomPhaseNames[phase.value] ?? '等待入座')
const hasBankruptPlayer = computed(() => snapshot.value?.players.some(p => p.beans === 0) ?? false)
const roomAddresses = computed(() => [...new Set(snapshot.value?.room.addresses?.length ? snapshot.value.room.addresses : [snapshot.value?.room.address ?? ''])].filter(address => address && !address.startsWith('127.')).sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.'))))
const seatPlayers = computed(() => [0, 1, 2].map(seat => snapshot.value?.players.find(p => p.seat === seat)))
const connectedCount = computed(() => snapshot.value?.players.filter(p => p.connected).length ?? 0)
const filteredRooms = computed(() => rooms.value.filter(r => `${r.name} ${r.id}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const visibleBubbles = computed(() => speechBubbles.value.filter(bubble => bubble.until > now.value))

function beans(value: number | undefined) { return (value ?? 0).toLocaleString('zh-CN') }
function cardRank(id: number) { return id >= 52 ? id - 36 : Math.floor(id / 4) + 3 }
function cardText(id: number) { const r = cardRank(id); return r === 16 ? '小王' : r === 17 ? '大王' : ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' } as Record<number, string>)[r] ?? `${r}` }
function cardSuit(id: number) { return id >= 52 ? '★' : ['♠', '♥', '♣', '♦'][id % 4] }
function redCard(id: number) { return id === 53 || (id < 52 && (id % 4 === 1 || id % 4 === 3)) }
function charIcon(character: number) { return characterIcons[character] ?? characterIcons[0] }
function bubblePosition(seat: number) { const relative = (seat - (self.value?.seat ?? 0) + 3) % 3; return relative === 0 ? 'self' : relative === 1 ? 'right' : 'left' }
function showBubble(seat: number, text: string, id: string) {
  speechBubbles.value = [...speechBubbles.value.filter(bubble => bubble.seat !== seat), { seat, text, id, until: Date.now() + 2900 }]
}
function playCue(cue: TableCue) {
  showBubble(cue.seat, cue.text, cue.eventId)
  audio.voice(cue)
  audio.effect(cue.kind === 'play' ? cue.playKind ?? 'play' : cue.kind)
}
function toast(message: string) {
  notice.value = message
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = '' }, 4200)
}
function openModal(value: Modal) { error.value = ''; modal.value = value; socialTarget.value = null }
function closeModal() { if (!busy.value) { modal.value = null; error.value = '' } }
function submitFromField(event: KeyboardEvent, submit: () => Promise<void>) {
  const input = event.target as HTMLInputElement | null
  if (input?.tagName !== 'INPUT' || ['file', 'range', 'checkbox', 'button', 'submit'].includes(input.type)) return
  event.preventDefault()
  void submit()
}
async function run(key: string, action: () => Promise<void>) {
  if (busy.value || dead) return
  const operation = ++operationSequence
  busy.value = key
  error.value = ''
  try { await action() } catch (e) { if (!dead && operation === operationSequence) error.value = errorText(e) } finally { if (!dead && operation === operationSequence) busy.value = '' }
}
function applySnapshot(next: Snapshot | null) {
  if (dead) return
  if (next && snapshot.value && next.room.id === snapshot.value.room.id && next.revision < snapshot.value.revision) return
  if (snapshot.value?.room.id !== next?.room.id) {
    roomSession += 1
    if (snapshot.value) { operationSequence += 1; busy.value = '' }
  }
  const oldRound = snapshot.value?.game?.roundId
  const oldPhase = snapshot.value?.game?.phase
  if (!next || snapshot.value?.room.id !== next.room.id || oldRound !== next.game?.roundId) audio.resetVoices()
  if (next && next.connection !== 'connected') resumeSilently = true
  const cues = tableCues(snapshot.value, next, resumeSilently)
  if (next?.connection === 'connected') resumeSilently = false
  snapshot.value = next
  cues.forEach(playCue)
  connection.value = next?.connection || 'connected'
  if (connection.value === 'connected') connectionMessage.value = ''
  if (!next || oldRound !== next.game?.roundId || oldPhase !== next.game?.phase) selected.value = []
  else selected.value = selected.value.filter(id => next.game?.hand.includes(id))
  if (!next || oldRound !== next.game?.roundId) speechBubbles.value = []
  if (!next) { socialTarget.value = null; socialText.value = null; lastHintKey = ''; hintCursor = 0 }
}
async function scan(manual = false) {
  if (scanning.value || preview.value || snapshot.value || dead) return
  scanning.value = true
  try {
    const data = await invoke<{ rooms: RoomInfo[]; addresses: string[] }>('lobby.scan', { query: query.value.trim() })
    if (dead) return
    rooms.value = data.rooms ?? []
    addresses.value = data.addresses ?? []
    if (manual) toast(`已刷新，发现 ${rooms.value.length} 个房间`)
  } catch (e) { if (manual || !initialized.value) error.value = errorText(e) } finally { scanning.value = false }
}
function openCreate() { form.name = `${profile.value.nickname}的小院`; form.password = ''; form.locked = false; form.initialBeans = 10000; openModal('create') }
async function createRoom() {
  if (!form.name.trim()) { error.value = '给房间起个名字吧。'; return }
  if (form.locked && !form.password.trim()) { error.value = '私密房间需要设置密码。'; return }
  if (form.locked && (new TextEncoder().encode(form.password).length < 4 || new TextEncoder().encode(form.password).length > 32)) { error.value = '密码需要 4 至 32 个字节，建议使用 4 至 32 位字母或数字。'; return }
  if (!Number.isInteger(Number(form.initialBeans)) || form.initialBeans < 1000 || form.initialBeans > 1000000) { error.value = '起始欢乐豆请输入 1,000 至 1,000,000 的整数。'; return }
  await run('create', async () => {
    const session = roomSession
    const created = await invoke<Snapshot>('room.create', { name: form.name.trim(), password: form.locked ? form.password : '', initialBeans: Number(form.initialBeans) })
    if (dead || (roomSession !== session && snapshot.value?.room.id !== created.room.id)) return
    applySnapshot(created)
    modal.value = null
  })
}
function chooseRoom(room: RoomInfo) { joinRoom.value = room; form.password = ''; openModal('join') }
async function join(direct = false) {
  const address = direct ? form.address.trim() : joinRoom.value?.address
  if (!address) { error.value = '请输入房主分享的 IP 地址和端口。'; return }
  await run('join', async () => {
    const session = roomSession
    const joined = await invoke<Snapshot>('room.join', { address, roomId: direct ? form.roomId.trim() || undefined : joinRoom.value?.id, password: form.password })
    if (dead || (roomSession !== session && snapshot.value?.room.id !== joined.room.id)) return
    applySnapshot(joined)
    modal.value = null
  })
}
function openDirect() { form.address = ''; form.roomId = ''; form.password = ''; openModal('direct') }
async function updateRoom(method: string, params: unknown) {
  const currentRoomId = snapshot.value?.room.id
  const session = roomSession
  if (!currentRoomId) return
  const next = await invoke<Snapshot>(method, params)
  if (!dead && roomSession === session && snapshot.value?.room.id === currentRoomId) applySnapshot(next)
}
async function ready() { await run('ready', async () => { await updateRoom('room.ready', { ready: !self.value?.ready }) }) }
async function leave() {
  await run('leave', async () => {
    const roomId = snapshot.value?.room.id
    const session = roomSession
    await invoke('room.leave')
    if (dead || (snapshot.value && (roomSession !== session || snapshot.value.room.id !== roomId))) return
    applySnapshot(null); modal.value = null; void scan()
  })
}
async function action(type: GameActionKind, params: GameActionParams = {}) {
  await run(type, async () => {
    const session = roomSession
    await updateRoom('game.action', { actionId: actionId(), expectedRevision: snapshot.value?.revision, expectedRoundId: snapshot.value?.game?.roundId, type, ...params })
    if (roomSession === session && (type === 'play' || type === 'pass')) selected.value = []
  })
}
async function hint() {
  await run('hint', async () => {
    const roomId = snapshot.value?.room.id
    const session = roomSession
    const fresh = await invoke<Snapshot | null>('room.snapshot')
    if (dead || roomSession !== session || roomId !== snapshot.value?.room.id || !fresh || fresh.room.id !== roomId) return
    applySnapshot(fresh)
    const position = () => JSON.stringify([game.value?.roundId, game.value?.phase, game.value?.turn, game.value?.hand, game.value?.lastPlay])
    const positionBeforeHint = position()
    const result = await invoke<{ candidates: number[][] }>('game.hint')
    if (dead || roomSession !== session || roomId !== snapshot.value?.room.id || positionBeforeHint !== position()) return
    if (!result.candidates?.length) { selected.value = []; toast(canPass.value ? '暂时没有能压过的牌，可以选择不出。' : '暂无出牌建议。'); return }
    const key = JSON.stringify(result.candidates)
    if (key !== lastHintKey) { hintCursor = 0; lastHintKey = key }
    selected.value = [...result.candidates[hintCursor % result.candidates.length]]
    hintCursor += 1
  })
}
function toggleCard(id: number) { selected.value = selected.value.includes(id) ? selected.value.filter(c => c !== id) : [...selected.value, id] }
function cancelOnBlank(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest('button,input,select,.social-menu')) return
  selected.value = []; socialTarget.value = null
}
async function voteReset(agree: boolean) { await run('reset', async () => { await updateRoom('room.reset', { agree }); if (!agree) toast('已取消本次重置提议，欢乐豆保持不变。') }) }
async function openSettings() {
  Object.assign(settings, profile.value)
  importedMusicName.value = audio.importedMusicName
  openModal('settings')
  await audio.unlock().catch(() => undefined)
  await audio.musicPreferenceReady()
  if (modal.value === 'settings') importedMusicName.value = audio.importedMusicName
}
function chooseCharacter(index: number) { settings.character = index; audio.previewVoice(index) }
async function importMusic(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await run('music', async () => { importedMusicName.value = (await audio.importMusic(file)).name; toast('背景音乐已换好，可以调节音量试听。') })
  input.value = ''
}
async function restoreMusic() { await run('music-restore', async () => { await audio.clearImportedMusic(); importedMusicName.value = ''; toast('已恢复田园牌局原声。') }) }
async function saveSettings() {
  if (!settings.nickname.trim()) { error.value = '请输入你的牌桌昵称。'; return }
  await run('settings', async () => {
    const update = { nickname: settings.nickname.trim(), character: settings.character, music: Number(settings.music), sound: Number(settings.sound), voice: Number(settings.voice), lowMotion: settings.lowMotion }
    if (preview.value) profile.value = { ...profile.value, ...update }
    else profile.value = await invoke<Profile>('profile.save', update)
    modal.value = null
    toast(preview.value ? '预览偏好已更新。' : '偏好已保存。')
  })
}
async function sendSocial(kind: string, phrase?: string) {
  const targetId = socialTarget.value ?? opponents.value[0]?.id
  if (!targetId) { toast('等牌友入座后，就可以互动啦。'); return }
  await run('social', async () => { await invoke('social.send', { actionId: actionId(), targetId, kind, phrase }); socialTarget.value = null })
}
function receiveSocial(event: SocialEvent) {
  if (!snapshot.value || event.roomId !== snapshot.value.room.id || seenSocial.has(event.id)) return
  seenSocial.add(event.id)
  if (seenSocial.size > 100) seenSocial.delete(seenSocial.values().next().value!)
  table?.social(event)
  audio.effect(event.kind)
  const speaker = snapshot.value.players.find(p => p.id === event.fromId)
  audio.voice({ kind: event.kind === 'phrase' ? 'phrase' : 'gift', character: speaker?.character ?? 0, gift: event.kind, text: event.phrase, eventId: event.id })
  if (speaker) showBubble(speaker.seat, event.kind === 'phrase' ? event.phrase ?? '' : `${gifts.find(g => g.kind === event.kind)?.name ?? '心意'}送给你`, event.id)
  const from = snapshot.value.players.find(p => p.id === event.fromId)?.nickname ?? '牌友'
  const target = snapshot.value.players.find(p => p.id === event.targetId)?.nickname ?? '牌友'
  socialText.value = { from, text: event.kind === 'phrase' ? event.phrase ?? '' : `给 ${target} ${gifts.find(g => g.kind === event.kind)?.name ?? '送来了心意'}` }
  if (socialTimer) clearTimeout(socialTimer)
  socialTimer = setTimeout(() => { socialText.value = null }, 4000)
}
async function copyRoom() {
  if (!snapshot.value) return
  openModal('invite')
}
async function copyAddress(address: string) {
  try { await copyText(address); toast('地址已复制，请好友在「直连好友」中粘贴。') } catch { toast('请选中地址文字，手动复制给好友。') }
}
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen() }
  catch { toast('当前宿主未开放全屏，可将 DBX 窗口最大化，牌桌会自动适配。') }
}
async function poll() {
  if (polling || !snapshot.value || preview.value || dead) return
  polling = true
  const roomId = snapshot.value.room.id
  const session = roomSession
  try {
    const data = await invoke<Snapshot | null>('room.snapshot')
    if (!dead && roomSession === session && snapshot.value?.room.id === roomId) {
      applySnapshot(data)
      if (!data) { modal.value = null; error.value = ''; toast('房间已结束，已返回大厅。'); void scan() }
    }
  }
  catch { if (!dead && roomSession === session && snapshot.value?.room.id === roomId) { resumeSilently = true; audio.resetVoices(); speechBubbles.value = []; connection.value = 'reconnecting'; connectionMessage.value = '正在恢复牌桌连接…' } }
  finally { polling = false }
}
function resizeBoard() {
  if (stageHost.value) boardScale.value = Math.min(stageHost.value.clientWidth / 1600, stageHost.value.clientHeight / 900)
}
async function mountScene() {
  const generation = ++sceneGeneration
  table?.destroy(); table = null
  resizeObserver?.disconnect()
  fallback.value = false
  await nextTick()
  if (!snapshot.value || !sceneHost.value || dead) return
  resizeBoard()
  resizeObserver = new ResizeObserver(resizeBoard)
  if (stageHost.value) resizeObserver.observe(stageHost.value)
  try {
    const created = await createTableScene(sceneHost.value, { onSelect: cards => { selected.value = cards }, onPlayer: id => { if (id !== snapshot.value?.selfId) { socialTarget.value = id; error.value = '' } }, onCancel: () => { selected.value = []; socialTarget.value = null } })
    if (generation !== sceneGeneration || dead || !snapshot.value) { created.destroy(); return }
    table = created
    table.update(snapshot.value, selected.value, profile.value.lowMotion)
  } catch { if (generation === sceneGeneration && snapshot.value) { fallback.value = true; toast('已切换兼容牌桌，出牌和联机功能仍可正常使用。') } }
}
watch(() => snapshot.value?.room.id, () => { void mountScene() })
watch([snapshot, selected, () => profile.value.lowMotion], () => { if (snapshot.value && table) table.update(snapshot.value, selected.value, profile.value.lowMotion) }, { deep: true })
watch(profile, (value: Profile) => { if (!dead) audio.configure(value) }, { deep: true, immediate: true })
watch(() => Boolean(snapshot.value), value => { audio.setScene(value ? 'table' : 'lobby') }, { immediate: true })
watch(modal, async value => { if (value) { await nextTick(); document.querySelector<HTMLElement>('.modal-card input, .modal-card button:not(.modal-close)')?.focus() }; if (value !== 'settings') audio.configure(profile.value) })
watch(() => [settings.music, settings.sound, settings.voice], () => {
  if (modal.value === 'settings') audio.configure({ ...profile.value, music: Number(settings.music), sound: Number(settings.sound), voice: Number(settings.voice) })
})
function unlockAudio() { void audio.unlock().catch(() => undefined) }
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') { if (modal.value) closeModal(); else if (socialTarget.value) socialTarget.value = null; else selected.value = [] }
  if (event.key === 'Tab' && modal.value) {
    const focusable = [...document.querySelectorAll<HTMLElement>('.modal-card button:not(:disabled), .modal-card input:not(:disabled)')]
    const first = focusable[0]; const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  const target = event.target as HTMLElement | null
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || modal.value || socialTarget.value ||
      target?.closest('input,textarea,select,button,[contenteditable="true"]') || noActions.value ||
      phase.value !== 'playing' || !myTurn.value || self.value?.trustee) return
  if (event.code === 'Space' && selected.value.length) { event.preventDefault(); void action('play', { cards: selectedSorted.value }) }
  else if (event.key.toLowerCase() === 'h') { event.preventDefault(); void hint() }
  else if (event.key.toLowerCase() === 'p' && canPass.value) { event.preventDefault(); void action('pass') }
}
function disposeUI() {
  if (dead) return
  dead = true; sceneGeneration += 1; table?.destroy(); table = null; resizeObserver?.disconnect(); unlisten()
  clearInterval(clockTimer); clearInterval(pollTimer); clearInterval(scanTimer); clearTimeout(noticeTimer); clearTimeout(socialTimer)
  window.removeEventListener('pointerdown', unlockAudio); window.removeEventListener('keydown', keyboard); audio.destroy()
}

onMounted(async () => {
  void readAssetUrl('assets/countryside.png').then(url => { background.value = url }).catch(() => undefined)
  void Promise.all([0, 1, 2, 3, 4].map(characterPortrait)).then(urls => { portraits.value = urls }).catch(() => undefined)
  window.addEventListener('pointerdown', unlockAudio, { once: true }); window.addEventListener('keydown', keyboard)
  clockTimer = setInterval(() => { now.value = Date.now() }, 250)
  if (preview.value) { initialized.value = true; return }
  unlisten = subscribe((method, params) => {
    if (dead) return
    if (method === 'room.state') applySnapshot(params as Snapshot)
    if (method === 'room.closed') { applySnapshot(null); modal.value = null; error.value = ''; toast((params as { reason?: string })?.reason || '房间已关闭'); void scan() }
    if (method === 'social.event') receiveSocial(params as SocialEvent)
    if (method === 'connection.state') { const state = params as { status: string; message?: string }; if (state.status !== 'connected') { resumeSilently = true; audio.resetVoices(); speechBubbles.value = [] }; connection.value = state.status; connectionMessage.value = state.message ?? '' }
  })
  unclose = bridge()?.workbench?.onClose(disposeUI)
  try {
    const loadedProfile = await invoke<Profile>('profile.get')
    if (dead) return
    profile.value = loadedProfile
    const resumedRoom = await invoke<Snapshot | null>('room.snapshot')
    if (dead) return
    applySnapshot(resumedRoom)
    if (!snapshot.value) await scan()
  } catch (e) { if (!dead) error.value = errorText(e) }
  if (dead) return
  initialized.value = true
  pollTimer = setInterval(() => { void poll() }, 2500)
  scanTimer = setInterval(() => { if (!modal.value) void scan() }, 10000)
})
onBeforeUnmount(() => {
  disposeUI(); unclose?.()
})
</script>

<template>
  <div class="app-shell" :class="{ 'in-room': snapshot, 'low-motion': profile.lowMotion, 'portraits-ready': portraits.length === 5 }" :style="shellStyle">
    <div class="scene-background" aria-hidden="true"></div>
    <div v-if="preview" class="preview-ribbon"><span class="status-dot amber"></span>界面预览 · 尚未连接 DBX，联机功能不可用</div>

    <template v-if="!snapshot">
      <header class="lobby-header">
        <a class="brand" href="#" @click.prevent=""><span class="brand-mark">♠</span><span>田园<span class="brand-light">棋牌</span><small>一起把日子，过成好牌</small></span></a>
        <nav class="header-tools" aria-label="常用操作">
          <button class="profile-pill" @click="openSettings"><span class="avatar small" :class="`character-${profile.character}`">{{ charIcon(profile.character) }}</span><span>{{ profile.nickname }}<small>今天也要好手气</small></span><span class="chevron">⌄</span></button>
          <button class="icon-button" aria-label="游戏规则" title="游戏规则" @click="openModal('rules')">?</button>
          <button class="icon-button" aria-label="设置" title="设置" @click="openSettings">⚙</button>
        </nav>
      </header>

      <main class="lobby-main">
        <section class="hero">
          <div class="eyebrow"><span></span> LAN · FRIENDS · GOOD TIMES</div>
          <h1>田园<span>斗地主</span><i>♣</i></h1>
          <p class="hero-subtitle">好牌，好朋友，好时光</p>
          <div class="hero-rule"></div>
          <p class="hero-copy">搬一把椅子，沏一壶好茶。<br>叫上同一局域网的朋友，来一场轻松的牌局。</p>
          <div class="hero-actions">
            <button class="button gold hero-cta" :disabled="preview || !initialized || !!busy" @click="openCreate"><span class="cta-plus">＋</span><span>创建房间<small>小院开桌，等你来玩</small></span><span class="cta-arrow">→</span></button>
            <button class="text-button direct-link" :disabled="preview" @click="openDirect"><span>⌁</span> 直连好友 <span>↗</span></button>
          </div>
          <div class="hero-features"><span><b>♟</b>三人经典玩法</span><span><b>✿</b>好友趣味互动</span><span><b>⌂</b>局域网轻松开局</span></div>
          <div class="decorative-cards" aria-hidden="true"><div class="decor-card card-a"><b>A</b><span>♠</span><i>♠</i></div><div class="decor-card card-k"><b>K</b><span>♥</span><i>♥</i></div><span class="card-spark spark-one">✦</span><span class="card-spark spark-two">✧</span></div>
        </section>

        <section class="rooms-panel glass-panel" aria-labelledby="rooms-title">
          <div class="panel-heading"><div><span class="tiny-label">在附近，找个好牌搭子</span><h2 id="rooms-title">好友牌桌 <span>{{ filteredRooms.length }}</span></h2></div><button class="refresh-button" :class="{ spinning: scanning }" :disabled="scanning || preview" @click="scan(true)" aria-label="刷新房间"><span>↻</span></button></div>
          <form class="search-box" @submit.prevent @keydown.enter.prevent="scan(true)"><span aria-hidden="true">⌕</span><input v-model="query" aria-label="搜索房间" placeholder="搜索房间名称或房号" maxlength="40"><button type="button" @click="scan(true)" :disabled="scanning || preview">搜索</button></form>
          <div class="network-strip"><span class="status-dot" :class="{ amber: preview }"></span><span>{{ preview ? '等待 DBX 插件环境' : scanning ? '正在发现局域网房间…' : '局域网房间 · 自动发现' }}</span><span class="network-count">{{ filteredRooms.length }} 张牌桌</span></div>
          <div v-if="!initialized" class="rooms-empty"><span class="loading-wheel"></span><h3>正在打开小院</h3><p>获取你的牌桌偏好与局域网状态…</p></div>
          <div v-else-if="!filteredRooms.length" class="rooms-empty">
            <div class="empty-illustration"><span class="empty-leaf">✿</span><span class="empty-chair">♧</span><span class="empty-spark">✧</span></div>
            <h3>{{ query ? '还没找到这张牌桌' : preview ? '小院已经布置好了' : '好牌桌，等你来开' }}</h3>
            <p>{{ preview ? '在 DBX 中打开插件后，即可发现附近房间。' : query ? '换个房间名试试，也可以通过 IP 直连好友。' : '暂未发现局域网房间。创建一间小院，\n邀请好友一起入座吧。' }}</p>
            <button v-if="!preview" class="button cream compact" @click="query ? openDirect() : openCreate()">{{ query ? '直连好友' : '＋ 创建第一张牌桌' }}</button>
          </div>
          <div v-else class="room-list">
            <article v-for="room in filteredRooms" :key="`${room.address}-${room.id}`" class="room-card">
              <div class="room-symbol" :class="{ locked: room.locked }">{{ room.locked ? '♜' : '♣' }}</div><div class="room-details"><h3>{{ room.name }} <span v-if="room.locked" class="private-tag">私密</span></h3><p>No. {{ room.id }} <span>·</span> {{ beans(room.initialBeans) }} 欢乐豆</p><div class="room-occupancy"><span v-for="seat in 3" :key="seat" :class="{ occupied: seat <= room.count }">●</span><small>{{ room.count }}/3 人 <i>·</i> {{ roomPhaseNames[room.phase] ?? room.phase }}</small></div></div><button class="join-button" :disabled="room.count >= 3 || !!busy" @click="chooseRoom(room)">{{ room.count >= 3 ? '已满' : '入座' }} <span v-if="room.count < 3">→</span></button>
            </article>
          </div>
          <div class="panel-footnote"><span>⌁</span> 和好友连接同一个网络，就能找到彼此<button :disabled="preview" @click="openDirect">找不到房间？</button></div>
        </section>
      </main>
      <footer class="lobby-footer"><span><span class="status-dot" :class="{ amber: preview }"></span>{{ preview ? '界面预览' : '局域网联机' }}<i>·</i>轻松娱乐，好运常在</span><span v-if="addresses.length" class="local-address" :title="addresses.join(' / ')">{{ addresses[0] }}</span><button @click="openModal('rules')">玩法说明 <span>↗</span></button></footer>
    </template>

    <main v-else ref="stageHost" class="game-stage" aria-label="斗地主牌桌">
      <div class="table-world" :class="{ 'fallback-world': fallback }" @dblclick="cancelOnBlank" :style="{ transform: `translate(-50%, -50%) scale(${boardScale})` }">
        <div v-if="fallback" class="table-surface" aria-hidden="true"><div class="table-rim"></div><span class="table-watermark">田园 · 斗地主</span></div>
        <div ref="sceneHost" class="pixi-stage" :class="{ 'render-fallback': fallback }"></div>
        <header class="table-header"><button class="button cream table-back" @click="openModal('leave')">‹ <span>返回大厅</span></button><div class="room-title"><strong>{{ snapshot.room.name }}</strong><span>No. {{ snapshot.room.id }} <i>·</i> {{ connectedCount }}/3 在线</span></div><button class="room-copy" @click="copyRoom">⌁ 邀请好友</button><button class="icon-button fullscreen-button" aria-label="切换全屏" title="切换全屏" @click="toggleFullscreen">⛶</button><div class="table-badges"><span class="gold-bean">●</span>{{ beans(self?.beans) }}<span class="bean-label">欢乐豆</span></div><button class="icon-button" aria-label="牌桌设置" @click="openSettings">⚙</button></header>
        <div v-if="connection !== 'connected'" class="connection-banner"><span class="loading-wheel"></span>{{ connectionMessage || (connection === 'disconnected' ? '连接已断开，正在尝试重新连接…' : '正在恢复牌桌连接…') }}<button @click="poll">立即重试</button></div>

        <div class="opponent-nameplate left" :class="{ 'active-player': game && game.phase !== 'finished' && game.turn === leftPlayer?.seat }"><template v-if="leftPlayer"><button @click="socialTarget = leftPlayer.id"><span v-if="game?.landlord === leftPlayer.seat" class="landlord-label">地主</span>{{ leftPlayer.nickname }} <small>{{ leftPlayer.isHost ? '房主' : '牌友' }}</small></button><div><span>● {{ beans(leftPlayer.beans) }}</span><i v-if="game && game.doubles[leftPlayer.seat] === 2" class="double-tag">加倍 ×2</i><i v-if="!leftPlayer.connected">离线</i><i v-else-if="leftPlayer.trustee">托管中</i><i v-else-if="!game && leftPlayer.ready">已准备</i></div></template><template v-else><strong>虚位以待</strong><span>邀请一位好友</span></template></div>
        <div class="opponent-nameplate right" :class="{ 'active-player': game && game.phase !== 'finished' && game.turn === rightPlayer?.seat }"><template v-if="rightPlayer"><button @click="socialTarget = rightPlayer.id"><span v-if="game?.landlord === rightPlayer.seat" class="landlord-label">地主</span>{{ rightPlayer.nickname }} <small>{{ rightPlayer.isHost ? '房主' : '牌友' }}</small></button><div><span>● {{ beans(rightPlayer.beans) }}</span><i v-if="game && game.doubles[rightPlayer.seat] === 2" class="double-tag">加倍 ×2</i><i v-if="!rightPlayer.connected">离线</i><i v-else-if="rightPlayer.trustee">托管中</i><i v-else-if="!game && rightPlayer.ready">已准备</i></div></template><template v-else><strong>虚位以待</strong><span>邀请一位好友</span></template></div>
        <div class="self-nameplate"><span class="avatar small" :class="`character-${self?.character ?? 0}`">{{ charIcon(self?.character ?? 0) }}</span><div><strong>{{ self?.nickname }}<span v-if="self?.isHost" class="host-tag">房主</span></strong><small>{{ game && self?.seat === game.landlord ? '♛ 地主' : game && game.landlord >= 0 ? '♣ 农民' : '☀ 快乐入座，好运将至' }}</small></div></div>
        <div v-if="game" class="round-info"><span>{{ phaseName }}</span><strong>× {{ game.multiplier || 1 }}</strong><small>公共倍数</small><span v-if="self && game.doubles[self.seat] >= 1" class="my-double">{{ game.doubles[self.seat] === 2 ? '我的加倍 ×2' : '我不加倍' }}</span></div>
        <div v-if="game && phase !== 'finished'" class="turn-indicator" :class="{ 'your-turn': yourDecision, urgent: seconds <= 10 }"><span class="turn-clock">{{ seconds }}</span><div>{{ yourDecision ? (phase === 'bidding' ? '轮到你叫分' : phase === 'doubling' ? '选择是否加倍' : '轮到你出牌') : phase === 'doubling' ? '等待大家选择加倍' : `等待 ${activePlayer?.nickname ?? '牌友'} ${phase === 'bidding' ? '叫分' : '出牌'}` }}<small>{{ phase === 'bidding' ? '叫分越高，越有机会成为地主' : phase === 'doubling' ? '稳稳地打，也可以放手一搏' : myTurn ? '点选手牌，再点击出牌' : '喝口茶，好牌值得等一等' }}</small></div></div>
        <div v-if="socialText" class="social-toast"><strong>{{ socialText.from }}</strong><span>{{ socialText.text }}</span></div>
        <TransitionGroup name="speech" tag="div" class="speech-layer"><div v-for="bubble in visibleBubbles" :key="bubble.id" class="player-speech" :class="bubblePosition(bubble.seat)"><span>{{ bubble.text }}</span></div></TransitionGroup>

        <section v-if="!game" class="waiting-panel glass-panel"><span class="waiting-flower">✿</span><p class="tiny-label">好朋友，慢慢来</p><h2>{{ snapshot.players.length < 3 ? '小院开桌，等你入座' : '牌友已到齐，准备开局' }}</h2><p>三位牌友都准备好后，牌局将自动开始。</p><div class="waiting-seats"><div v-for="(player, seat) in seatPlayers" :key="seat" class="waiting-seat"><template v-if="player"><span class="avatar" :class="`character-${player.character}`">{{ charIcon(player.character) }}</span><strong>{{ player.nickname }}</strong><small :class="{ ready: player.ready }">{{ player.ready ? '✓ 已准备' : '等待准备' }}</small></template><template v-else><span class="avatar vacant">＋</span><strong>留个好位置</strong><small>等待好友加入</small></template></div></div><button class="button gold" :disabled="noActions" @click="ready">{{ busy === 'ready' ? '正在准备…' : self?.ready ? '取消准备' : '我准备好了' }}</button><button class="text-button" @click="copyRoom">复制房间地址，邀请好友 ↗</button><button v-if="hasBankruptPlayer" class="text-button reset-proposal" :disabled="noActions" @click="voteReset(true)">提议重置欢乐豆</button><div class="waiting-address"><span>{{ snapshot.room.address }}</span><i>{{ snapshot.room.locked ? '私密房间 · 加入需要密码' : '公开房间 · 好友可直接加入' }}</i></div></section>

        <div v-if="game && phase !== 'finished'" class="action-row">
          <template v-if="phase === 'bidding' && myTurn"><button class="button cream" :disabled="noActions" @click="action('bid', { score: 0 })">不叫</button><button v-for="score in [1, 2, 3]" :key="score" class="button" :class="score === 3 ? 'gold' : 'cream'" :disabled="noActions || score <= highestBid" @click="action('bid', { score })">{{ score }} 分</button></template>
          <template v-else-if="phase === 'doubling' && !hasDoubled"><button class="button cream" :disabled="noActions" @click="action('double', { double: false })">不加倍</button><button class="button gold" :disabled="noActions" @click="action('double', { double: true })">加倍 <small>×2</small></button></template>
          <template v-else-if="phase === 'playing' && myTurn && !self?.trustee"><button class="button cream" :disabled="noActions || !canPass" @click="action('pass')">不出</button><button class="button cream" :disabled="noActions" @click="hint">{{ busy === 'hint' ? '想一想…' : '提示' }}</button><button class="button gold play-button" :disabled="noActions || !selected.length" @click="action('play', { cards: selectedSorted })">{{ busy === 'play' ? '出牌中…' : '出牌' }}<small v-if="selected.length">{{ selected.length }} 张</small></button></template>
          <div v-else-if="self?.trustee" class="trustee-panel"><span>✦ 正在为你托管</span><button class="button cream compact" :disabled="noActions" @click="action('trustee', { enabled: false })">我来打</button></div>
          <span v-else-if="phase === 'doubling'" class="passive-label">✓ 已选择，等待其他牌友</span>
        </div>
        <div v-if="game && phase === 'playing'" class="selection-toolbar"><button v-if="selected.length" @click="selected = []">取消选牌 <kbd>Esc</kbd></button><span v-if="selected.length">已选 {{ selected.length }} 张</span><span v-if="myTurn && !self?.trustee" class="keyboard-hints"><kbd>H</kbd> 提示 <kbd>P</kbd> 不出 <kbd>空格</kbd> 出牌</span></div>
        <div class="table-bottom-tools"><button class="table-tool" @click="socialTarget = (leftPlayer ?? rightPlayer)?.id ?? null"><span>☏</span>互动</button><button v-if="game && phase !== 'finished'" class="table-tool" :class="{ active: self?.trustee }" :disabled="noActions" @click="action('trustee', { enabled: !self?.trustee })"><span>♙</span>{{ self?.trustee ? '取消托管' : '托管' }}</button><button class="table-tool" @click="openModal('rules')"><span>?</span>规则</button></div>

        <template v-if="fallback"><div v-for="opponent in opponents" :key="opponent.id" class="fallback-character" :class="(opponent.seat - (self?.seat ?? 0) + 3) % 3 === 2 ? 'left' : 'right'"><button class="avatar giant" :class="`character-${opponent.character}`" @click="socialTarget = opponent.id">{{ charIcon(opponent.character) }}</button><span v-if="game">剩余 {{ game.remaining[opponent.seat] }} 张</span></div><div v-if="game" class="fallback-bottom"><span v-for="(card, index) in (game.bottom.length ? game.bottom : [-1, -1, -1])" :key="index" class="mini-card" :class="{ red: redCard(card), 'face-down': card < 0 }">{{ card < 0 ? '♠' : cardText(card) + cardSuit(card) }}</span></div><div v-if="game?.lastPlay" class="fallback-play"><span v-for="card in game.lastPlay.cards" :key="card" class="mini-card" :class="{ red: redCard(card) }">{{ cardText(card) }}{{ cardSuit(card) }}</span></div><div v-if="game" class="fallback-hand"><button v-for="card in hand" :key="card" class="playing-card" :class="{ red: redCard(card), selected: selected.includes(card) }" :aria-pressed="selected.includes(card)" :aria-label="`${cardText(card)}${cardSuit(card)}`" :style="{ marginLeft: `${Math.min(-16, (960 - 110 * hand.length) / Math.max(1, hand.length - 1))}px` }" @click="toggleCard(card)"><strong>{{ cardText(card) }}</strong><span>{{ cardSuit(card) }}</span><i>{{ cardSuit(card) }}</i></button></div><span class="fallback-label">兼容模式</span></template>

        <section v-if="game?.phase === 'finished'" class="settlement-panel glass-panel"><span class="settlement-laurel">{{ won ? '✦' : '♧' }}</span><p class="tiny-label">这一局，打得痛快</p><h2>{{ won ? '好牌，好运气！' : '胜负常有，下把再来' }}</h2><div class="settlement-score" :class="{ negative: myDelta < 0 }">{{ myDelta >= 0 ? '+' : '−' }}{{ beans(Math.abs(myDelta)) }}<small>欢乐豆</small></div><div class="settlement-tags"><span>最终倍数 ×{{ game.multiplier }}</span><span v-if="game.settlement?.spring">✿ 春天</span></div><div class="settlement-players"><div v-for="player in snapshot.players" :key="player.id"><span>{{ player.seat === game.landlord ? '♛' : '♣' }} {{ player.nickname }}</span><strong :class="{ negative: (game.settlement?.deltas[player.seat] ?? 0) < 0 }">{{ (game.settlement?.deltas[player.seat] ?? 0) >= 0 ? '+' : '' }}{{ beans(game.settlement?.deltas[player.seat]) }}</strong><small>余 {{ beans(player.beans) }}</small></div></div><button class="button gold" :disabled="noActions" @click="ready">{{ self?.ready ? '取消准备' : '再来一局' }}</button><p class="settlement-hint">{{ snapshot.players.filter(p => p.ready).length }}/3 已准备，全部准备后自动开始</p><button v-if="hasBankruptPlayer" class="text-button" :disabled="noActions" @click="voteReset(!snapshot.resetVotes.includes(snapshot.selfId))">{{ snapshot.resetVotes.includes(snapshot.selfId) ? '撤回重置投票' : '发起重置欢乐豆' }}</button></section>

        <div v-if="snapshot.resetVotes?.length" class="reset-banner"><span>有人提议重置欢乐豆 <b>{{ snapshot.resetVotes.length }}/3</b></span><small>全员同意后恢复至每人 {{ beans(snapshot.room.initialBeans) }} 豆</small><button v-if="!snapshot.resetVotes.includes(snapshot.selfId)" :disabled="noActions" @click="voteReset(true)">同意重置</button><button class="reject-reset" :disabled="noActions" @click="voteReset(false)">{{ snapshot.resetVotes.includes(snapshot.selfId) ? '撤回并取消' : '暂不重置' }}</button></div>
        <section v-if="socialTarget" class="social-menu glass-panel"><div class="social-heading"><span>给 {{ targetPlayer?.nickname ?? '牌友' }} 送点心意</span><button aria-label="关闭互动菜单" @click="socialTarget = null">×</button></div><div class="social-targets"><button v-for="player in opponents" :key="player.id" :class="{ selected: socialTarget === player.id }" @click="socialTarget = player.id">{{ player.nickname }}</button></div><div class="gift-options"><button v-for="gift in gifts" :key="gift.kind" :disabled="!!busy" @click="sendSocial(gift.kind)"><span>{{ gift.icon }}</span>{{ gift.name }}</button></div><div class="phrase-options"><button v-for="phrase in phrases" :key="phrase" :disabled="!!busy" @click="sendSocial('phrase', phrase)">{{ phrase }} <span>↗</span></button></div><small class="social-note">小小心意，不扣欢乐豆</small></section>
      </div>
    </main>

    <div v-if="error && !modal" class="error-toast" role="alert"><span>!</span>{{ error }}<button aria-label="关闭提示" @click="error = ''">×</button></div>
    <Transition name="toast"><div v-if="notice" class="toast-message" role="status"><span>✦</span>{{ notice }}</div></Transition>

    <div v-if="modal" class="modal-scrim" @click.self="closeModal" @keydown.esc="closeModal">
      <section class="modal-card" :class="{ 'settings-modal': modal === 'settings', 'rules-modal': modal === 'rules' }" role="dialog" aria-modal="true" :aria-labelledby="'modal-title'">
        <button class="modal-close" :disabled="!!busy" aria-label="关闭弹窗" @click="closeModal">×</button>
        <template v-if="modal === 'create'"><span class="modal-icon">♣</span><p class="tiny-label">把好朋友，聚在一张桌</p><h2 id="modal-title">开一间自己的小院</h2><form @submit.prevent @keydown.enter="submitFromField($event, createRoom)"><label class="field-label">房间名称<input v-model="form.name" maxlength="24" placeholder="给小院起个名字"></label><div class="field-label">房间类型<div class="segmented"><button type="button" :class="{ selected: !form.locked }" @click="form.locked = false"><b>☀ 公开小院</b><small>局域网好友可直接加入</small></button><button type="button" :class="{ selected: form.locked }" @click="form.locked = true"><b>♜ 私密小院</b><small>凭密码入座</small></button></div></div><label v-if="form.locked" class="field-label">入座密码<input v-model="form.password" type="password" maxlength="32" autocomplete="new-password" placeholder="告诉好友这个小秘密"></label><label class="field-label">每位牌友的起始欢乐豆<div class="bean-input"><span>●</span><input v-model.number="form.initialBeans" type="number" min="1000" max="1000000" step="100"><span>豆 / 人</span></div></label><div class="bean-presets"><button v-for="amount in [1000, 10000, 100000]" :key="amount" type="button" :class="{ selected: form.initialBeans === amount }" @click="form.initialBeans = amount">{{ beans(amount) }}</button></div><p class="form-note">欢乐豆仅用于本房间娱乐计分。三人都准备后自动开局。</p><p v-if="error" class="form-error" role="alert">{{ error }}</p><button class="button gold full-width" :disabled="!!busy" type="button" @click="createRoom">{{ busy === 'create' ? '正在布置小院…' : '创建房间，等好友来' }}<span>→</span></button></form></template>
        <template v-else-if="modal === 'join'"><span class="modal-icon">{{ joinRoom?.locked ? '♜' : '♣' }}</span><p class="tiny-label">这张牌桌，还缺一个你</p><h2 id="modal-title">{{ joinRoom?.name }}</h2><div class="join-summary"><span>房号 <b>{{ joinRoom?.id }}</b></span><span>已入座 <b>{{ joinRoom?.count }}/3</b></span><span>起始欢乐豆 <b>{{ beans(joinRoom?.initialBeans) }}</b></span></div><form @submit.prevent @keydown.enter="submitFromField($event, () => join(false))"><label v-if="joinRoom?.locked" class="field-label">入座密码<input v-model="form.password" type="password" maxlength="32" autocomplete="off" placeholder="输入房主告诉你的密码"></label><p v-else class="form-note">准备好一杯茶，和好友一起入座吧。</p><p v-if="error" class="form-error" role="alert">{{ error }}</p><button class="button gold full-width" :disabled="!!busy" type="button" @click="join(false)">{{ busy === 'join' ? '正在入座…' : '加入这张牌桌' }}<span>→</span></button></form></template>
        <template v-else-if="modal === 'direct'"><span class="modal-icon">⌁</span><p class="tiny-label">沿着地址，找到老朋友</p><h2 id="modal-title">直连好友</h2><form @submit.prevent @keydown.enter="submitFromField($event, () => join(true))"><label class="field-label">房主地址<input v-model="form.address" spellcheck="false" autocomplete="off" placeholder="例如 192.168.1.8:39080"><small>请粘贴房主在牌桌中复制的地址，需处于同一局域网。</small></label><label class="field-label">房间号 <span class="optional">选填</span><input v-model="form.roomId" maxlength="40" placeholder="房主分享的房号"></label><label class="field-label">房间密码 <span class="optional">公开房间不用填</span><input v-model="form.password" type="password" maxlength="32" autocomplete="off" placeholder="私密房间的入座密码"></label><p v-if="error" class="form-error" role="alert">{{ error }}</p><button class="button gold full-width" :disabled="!!busy" type="button" @click="join(true)">{{ busy === 'join' ? '正在连接…' : '找到好友，入座' }}<span>→</span></button></form></template>
        <template v-else-if="modal === 'invite'"><span class="modal-icon">⌂</span><h2 id="modal-title">邀请好友来小院</h2><p class="form-note">好友可直接搜索「{{ snapshot?.room.name }}」，或在「直连好友」输入下面的地址。多网卡电脑请选择与好友同一局域网的地址。</p><div class="invite-addresses"><label v-for="address in roomAddresses" :key="address"><input :value="address" readonly :aria-label="`房间地址 ${address}`" @focus="($event.target as HTMLInputElement).select()"><button type="button" class="button cream compact" @click="copyAddress(address)">复制</button></label></div><p class="form-note">{{ snapshot?.room.locked ? '这是密码房，请另行告诉好友入座密码。' : '这是公开房间，三位好友到齐后全部准备即可开始。' }}</p></template>
        <template v-else-if="modal === 'settings'"><p class="tiny-label">以你喜欢的样子入座</p><h2 id="modal-title">我的牌桌偏好</h2><form @submit.prevent @keydown.enter="submitFromField($event, saveSettings)"><label class="field-label">牌桌昵称<input v-model="settings.nickname" maxlength="16" placeholder="让朋友一眼认出你"></label><div class="field-label character-heading">我的形象 <span>五位牌友，各有声色 · 点击试听</span><div class="character-picker" role="group" aria-label="选择角色"><button v-for="(character, index) in characters" :key="character" type="button" :class="{ selected: settings.character === index }" :aria-pressed="settings.character === index" :aria-label="`${character}，${characterMoods[index]}，点击选择并试听`" @click="chooseCharacter(index)"><span class="avatar" :class="`character-${index}`">{{ charIcon(index) }}</span><b>{{ character }}</b><small>{{ characterMoods[index] }}</small><span class="character-selected">{{ settings.character === index ? '✓ 已选择' : '试听声音' }}</span></button></div></div><div class="music-library"><div><strong>牌桌原声</strong><small :title="importedMusicName">{{ importedMusicName || '田园牌局 · 轻快国风' }}</small></div><label class="music-import" :class="{ busy: !!busy }">{{ busy === 'music' ? '导入中…' : '更换音乐' }}<input type="file" accept="audio/mpeg,audio/ogg,audio/wav,audio/x-wav,audio/mp4,.mp3,.ogg,.wav,.m4a" :disabled="!!busy" @change="importMusic"></label><button v-if="importedMusicName" type="button" :disabled="!!busy" @click="restoreMusic">恢复原声</button><p>可导入你有权使用的 MP3、OGG、WAV 或 M4A 音乐，最大 4 MB，保存在本机。</p></div><div class="sound-settings"><label><span>♫ 背景音乐</span><input v-model.number="settings.music" type="range" min="0" max="1" step="0.05"><output>{{ Math.round(settings.music * 100) }}%</output></label><label><span>♩ 游戏音效</span><input v-model.number="settings.sound" type="range" min="0" max="1" step="0.05"><output>{{ Math.round(settings.sound * 100) }}%</output></label><label><span>☏ 角色语音</span><input v-model.number="settings.voice" type="range" min="0" max="1" step="0.05"><output>{{ Math.round(settings.voice * 100) }}%</output></label></div><label class="motion-setting"><span><b>减少动态效果</b><small>更安静的牌桌，也更适合低性能设备</small></span><input v-model="settings.lowMotion" type="checkbox" role="switch"></label><p v-if="error" class="form-error" role="alert">{{ error }}</p><button class="button gold full-width" :disabled="!!busy" type="button" @click="saveSettings">{{ busy === 'settings' ? '正在保存…' : '就这样，保存偏好' }}</button></form></template>
        <template v-else-if="modal === 'leave'"><span class="modal-icon">⌂</span><h2 id="modal-title">回大厅歇一会儿？</h2><p class="leave-copy">{{ game && game.phase !== 'finished' ? '牌局进行中，离开后将由托管接手。' : '你将离开当前房间，之后可以重新加入。' }}{{ self?.isHost ? '你是房主，离开会关闭房间，请先和牌友打个招呼。' : '' }}</p><p v-if="error" class="form-error" role="alert">{{ error }}</p><div class="modal-actions"><button class="button cream" :disabled="!!busy" @click="closeModal">继续打牌</button><button class="button gold" :disabled="!!busy" @click="leave">{{ busy === 'leave' ? '正在离开…' : '返回大厅' }}</button></div></template>
        <template v-else-if="modal === 'rules'"><p class="tiny-label">轻松入门，快乐开局</p><h2 id="modal-title">三人经典斗地主</h2><div class="rules-content"><section><b>01 · 入座与准备</b><p>三位牌友进入同一房间，全部准备后自动发牌。每人 17 张，地主获得额外的 3 张底牌。</p></section><section><b>02 · 叫分与加倍</b><p>依次选择不叫、1 分、2 分或 3 分，叫分最高者成为地主。选定地主后，每位玩家选择是否加倍。</p></section><section><b>03 · 出牌与配合</b><p>地主先出。可出单张、对子、三张、三带一、三带二、顺子、连对、飞机、四带二、炸弹与王炸。同牌型比较主牌大小；炸弹可压普通牌型，王炸最大。</p></section><section><b>04 · 胜负与欢乐豆</b><p>地主先出完则地主获胜；任一农民先出完则农民共同获胜。炸弹、王炸、春天与加倍影响最终结算。欢乐豆仅用于本房间娱乐计分。</p></section><section><b>05 · 和朋友互动</b><p>点击牌友形象，可以倒茶、送花、点赞，或发送快捷语。网络波动时会自动尝试重连，超时可由托管接手。互动免费，每人每 3 秒一次。</p></section><section><b>06 · 飞机与四带二</b><p>连续牌不能含 2 或王。飞机的主体每个点数恰好三张，第四张不能作翼；单翼允许一对，不许三张或炸弹，也不许同时带大小王。对翼必须是不同点数的对子。四带二可带一对，四带两对不能把炸弹拆成两对。</p></section><section><b>07 · 限时与结算</b><p>叫分 15 秒，加倍 10 秒，出牌 20 秒。底分 100 豆，计入叫分、双方加倍、炸弹和春天。余额不足按应付比例支付，任何人不会负债。有人输光后，需要三名在席且在线的牌友一致同意才能重置。</p></section></div><button class="button gold full-width" @click="closeModal">懂了，好运开局</button></template>
      </section>
    </div>
  </div>
</template>
