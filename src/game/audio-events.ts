import type { Play, Snapshot } from '../types'

export interface TableCue {
  kind: 'bid' | 'double' | 'play' | 'pass' | 'win' | 'lose'
  character: number
  seat: number
  eventId: string
  score?: number
  doubled?: boolean
  cards?: number[]
  playKind?: string
  text: string
}

const playNames: Record<string, string> = {
  triple: '三张', tripleSingle: '三带一', triplePair: '三带二', straight: '顺子',
  pairStraight: '连对', airplane: '飞机', airplaneSingle: '飞机带翅膀',
  airplanePair: '飞机带对子', fourTwoSingle: '四带二', fourTwoPair: '四带两对',
  bomb: '炸弹！', rocket: '王炸！', pass: '不出',
}

function rankLabel(card: number) {
  const rank = card >= 52 ? card - 36 : Math.floor(card / 4) + 3
  return ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' } as Record<number, string>)[rank] ?? String(rank)
}

export function playCaption(play: Play) {
  if (play.kind === 'single') return rankLabel(play.cards[0] ?? 0)
  if (play.kind === 'pair') return `对 ${rankLabel(play.cards[0] ?? 0)}`
  return playNames[play.kind] ?? '好牌！'
}

/** Only adjacent, live action transitions are spoken; resumed snapshots are a silent baseline. */
export function tableCues(previous: Snapshot | null, next: Snapshot | null, resumed = false): TableCue[] {
  if (resumed || !previous || !next || previous.room.id !== next.room.id ||
      next.revision <= previous.revision || previous.connection !== 'connected' || next.connection !== 'connected') return []
  const old = previous.game, game = next.game
  if (!old || !game || old.roundId !== game.roundId) return []
  const cues: TableCue[] = []
  const add = (seat: number, kind: TableCue['kind'], text: string, values: Partial<TableCue> = {}) => {
    const player = next.players.find(p => p.seat === seat)
    if (player) cues.push({ kind, seat, character: player.character, eventId: `${next.room.id}:${game.roundId}:${next.revision}:${seat}:${kind}`, text, ...values })
  }
  const bids = game.bids.map((score, seat) => ({ score, seat })).filter(({ score, seat }) => score >= 0 && score !== old.bids[seat])
  if (bids.length === 1) {
    const bid = bids[0]!
    add(bid.seat, 'bid', bid.score ? `${['', '一', '二', '三'][bid.score]}分！` : '这把先不叫', { score: bid.score })
  }
  const doubles = game.doubles.map((value, seat) => ({ value, seat })).filter(({ value, seat }) => value >= 1 && value !== old.doubles[seat])
  // Simultaneously restored decisions are not a new sequence of three spoken actions.
  if (doubles.length === 1) {
    const choice = doubles[0]!
    add(choice.seat, 'double', choice.value === 2 ? '加倍，来吧！' : '稳一点，不加倍', { doubled: choice.value === 2 })
  }
  const before = old.history ?? [], after = game.history ?? []
  const previousTailMatches = !before.length || JSON.stringify(before.at(-1)) === JSON.stringify(after[before.length - 1])
  // History includes passes even when the second pass resets the public passes counter to zero.
  if (previousTailMatches && after.length === before.length + 1) {
    const play = after.at(-1)!
    add(play.seat, play.kind === 'pass' ? 'pass' : 'play', playCaption(play), { cards: play.cards, playKind: play.kind })
  }
  if (game.phase === 'finished' && old.phase !== 'finished') {
    const player = next.players.find(p => p.id === next.selfId)
    if (player) {
      const won = (player.seat === game.landlord) === (game.winner === game.landlord)
      add(player.seat, won ? 'win' : 'lose', won ? '好牌，好配合！' : '下把再来！')
    }
  }
  return cues
}
