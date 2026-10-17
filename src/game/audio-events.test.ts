import { describe, expect, it } from 'vitest'
import { playCaption, tableCues } from './audio-events'
import type { GameView, Snapshot } from '../types'

function snapshot(revision: number, game: Partial<GameView> = {}): Snapshot {
  return {
    room: { id: 'room-a', name: '测试小院', address: '127.0.0.1:39080', count: 3, locked: false, phase: 'playing', initialBeans: 10000, protocol: 2 },
    selfId: 'self', hostId: 'self', revision, connection: 'connected', resetVotes: [],
    players: [4, 3, 2].map((character, seat) => ({ id: seat === 0 ? 'self' : `friend-${seat}`, nickname: `牌友 ${seat}`, character, seat, beans: 10000, ready: true, connected: true, trustee: false, isHost: seat === 0 })),
    game: { roundId: 'round-a', phase: 'playing', hand: [0, 4], bottom: [1, 2, 3], turn: 0, bids: [3, 0, 0], doubles: [1, 1, 1], landlord: 0, lastPlay: null, passes: 0, remaining: [2, 17, 17], deadline: 20000, multiplier: 3, winner: -1, history: [], ...game },
  }
}

describe('authoritative table voice transitions', () => {
  it('uses initial, duplicate, older, other-room and other-round snapshots as silent state', () => {
    const first = snapshot(1), play = snapshot(2, { history: [{ seat: 0, kind: 'single', cards: [0] }] })
    expect(tableCues(null, play)).toEqual([])
    expect(tableCues(play, play)).toEqual([])
    expect(tableCues(play, first)).toEqual([])
    expect(tableCues(first, { ...play, room: { ...play.room, id: 'another-room' } })).toEqual([])
    expect(tableCues(first, snapshot(2, { ...play.game!, roundId: 'another-round' }))).toEqual([])
  })

  it('does not replay history or settlement when resuming a disconnected client', () => {
    const old = snapshot(1), finish = snapshot(3, { phase: 'finished', winner: 1, history: [{ seat: 1, kind: 'single', cards: [44] }] })
    expect(tableCues(old, finish, true)).toEqual([])
    expect(tableCues({ ...old, connection: 'reconnecting' }, finish)).toEqual([])
    expect(tableCues(old, { ...finish, connection: 'reconnecting' })).toEqual([])
  })

  it('announces the second pass even though the trick reset makes passes return to zero', () => {
    const play = { seat: 0, kind: 'single', cards: [0] }
    const before = snapshot(2, { history: [play] })
    const firstPass = snapshot(3, { passes: 1, history: [play, { seat: 1, kind: 'pass', cards: [] }] })
    const secondPass = snapshot(4, { passes: 0, lastPlay: null, history: [...firstPass.game!.history!, { seat: 2, kind: 'pass', cards: [] }] })
    expect(tableCues(before, firstPass)).toMatchObject([{ kind: 'pass', seat: 1, character: 3 }])
    expect(tableCues(firstPass, secondPass)).toMatchObject([{ kind: 'pass', seat: 2, character: 2 }])
    expect(tableCues(secondPass, secondPass)).toEqual([])
  })

  it('does not enqueue a burst of old plays after missing multiple history entries', () => {
    const before = snapshot(1)
    const after = snapshot(4, { history: [{ seat: 0, kind: 'single', cards: [0] }, { seat: 1, kind: 'single', cards: [4] }] })
    expect(tableCues(before, after)).toEqual([])
    expect(tableCues(snapshot(2, { history: [{ seat: 0, kind: 'single', cards: [8] }] }), after)).toEqual([])
  })

  it.each([0, 1, 2, 3])('voices bid %i using the actual player character', score => {
    const before = snapshot(5, { phase: 'bidding', bids: [-1, -1, -1] })
    const after = snapshot(6, { phase: score === 3 ? 'doubling' : 'bidding', bids: [-1, score, -1] })
    expect(tableCues(before, after)).toMatchObject([{ kind: 'bid', score, seat: 1, character: 3 }])
  })

  it.each([1, 2])('voices doubling choice %i exactly once', value => {
    const before = snapshot(7, { phase: 'doubling', doubles: [-1, -1, -1] })
    const after = snapshot(8, { phase: 'doubling', doubles: [-1, value, -1] })
    const cue = tableCues(before, after)[0]!
    expect(cue).toMatchObject({ kind: 'double', doubled: value === 2, seat: 1, character: 3 })
    expect(cue.eventId).toBe('room-a:round-a:8:1:double')
    expect(tableCues(after, after)).toEqual([])
  })

  it('keeps the final card announcement and then announces victory', () => {
    const before = snapshot(9)
    const after = snapshot(10, { phase: 'finished', winner: 0, history: [{ seat: 0, kind: 'pair', cards: [44, 45] }] })
    const cues = tableCues(before, after)
    expect(cues.map(cue => cue.kind)).toEqual(['play', 'win'])
    expect(cues[0]).toMatchObject({ text: '对 A', cards: [44, 45], playKind: 'pair', character: 4 })
  })

  it('reports the self team outcome, including a teammate winning', () => {
    const before = snapshot(9, { landlord: 2 })
    expect(tableCues(before, snapshot(10, { phase: 'finished', landlord: 2, winner: 1 }))).toMatchObject([{ kind: 'win', seat: 0 }])
    expect(tableCues(before, snapshot(10, { phase: 'finished', landlord: 2, winner: 2 }))).toMatchObject([{ kind: 'lose', seat: 0 }])
  })

  it('labels jokers and compound card patterns for speech bubbles', () => {
    expect(playCaption({ seat: 0, kind: 'single', cards: [53] })).toBe('大王')
    expect(playCaption({ seat: 0, kind: 'single', cards: [52] })).toBe('小王')
    expect(playCaption({ seat: 0, kind: 'triplePair', cards: [0, 1, 2, 8, 9] })).toBe('三带二')
    expect(playCaption({ seat: 0, kind: 'rocket', cards: [52, 53] })).toBe('王炸！')
  })
})
