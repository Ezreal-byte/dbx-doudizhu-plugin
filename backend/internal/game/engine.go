package game

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"sort"
)

const (
	BidDurationMS    int64 = 15_000
	TurnDurationMS   int64 = 20_000
	DoubleDurationMS int64 = 10_000
	TrusteeDelayMS   int64 = 1_000
	BaseBeans        int64 = 100
)

// Engine is serialized by the room owner. Every field exposed through View is
// copied: callers cannot mutate hands, action history or cached settlement.
type Engine struct {
	roundID                             string
	phase                               string
	hands                               [3][]int
	bottom                              []int
	turn, firstBidder, landlord, winner int
	bids, doubles                       [3]int
	last                                *Play
	lastCombo                           Combo
	passes                              int
	deadline, multiplier                int64
	naturalDeadline                     int64
	trustees                            [3]bool
	played                              [3]int
	history                             []Play
	settlement                          *Settlement
	spring                              bool
}

func New(roundID string, firstBidder int, nowMS int64) *Engine {
	if firstBidder < 0 || firstBidder > 2 {
		firstBidder = 0
	}
	e := &Engine{roundID: roundID, firstBidder: firstBidder}
	e.deal(nowMS)
	return e
}

func (e *Engine) deal(nowMS int64) {
	deck := make([]int, 54)
	for i := range deck {
		deck[i] = i
	}
	for i := len(deck) - 1; i > 0; i-- {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		if err != nil {
			panic(fmt.Errorf("secure shuffle: %w", err))
		}
		j := int(n.Int64())
		deck[i], deck[j] = deck[j], deck[i]
	}
	e.phase, e.turn, e.landlord, e.winner = "bidding", e.firstBidder, -1, -1
	e.bids, e.doubles = [3]int{-1, -1, -1}, [3]int{-1, -1, -1}
	e.last, e.lastCombo, e.passes = nil, Combo{}, 0
	e.multiplier, e.played, e.history, e.settlement, e.spring = 1, [3]int{}, nil, nil, false
	for seat := range 3 {
		e.hands[seat] = append([]int(nil), deck[seat*17:(seat+1)*17]...)
		SortHand(e.hands[seat])
	}
	e.bottom = append([]int(nil), deck[51:]...)
	e.setDeadline(nowMS, BidDurationMS)
}

func (e *Engine) setDeadline(nowMS, duration int64) {
	e.naturalDeadline = nowMS + duration
	e.deadline = e.naturalDeadline
	if e.turn >= 0 && e.turn < 3 && e.trustees[e.turn] {
		e.deadline = nowMS + TrusteeDelayMS
	}
}

func (e *Engine) Apply(seat int, action Action, nowMS int64) error {
	return e.apply(seat, action, nowMS, false)
}

func (e *Engine) apply(seat int, action Action, nowMS int64, timed bool) error {
	if seat < 0 || seat >= 3 {
		return errors.New("invalid seat")
	}
	if action.Type == "trustee" {
		if e.trustees[seat] == action.Enabled {
			return nil
		}
		e.trustees[seat] = action.Enabled
		if e.phase != "finished" && e.turn == seat {
			e.deadline = e.naturalDeadline
			if action.Enabled {
				e.deadline = min(e.deadline, nowMS+TrusteeDelayMS)
			}
		}
		if action.Enabled && e.phase == "doubling" && e.doubles[seat] == -1 {
			e.doubles[seat] = 1
			e.maybeStartPlaying(nowMS)
		}
		return nil
	}
	if e.phase == "finished" {
		return errors.New("round has finished")
	}
	if !timed && nowMS >= e.deadline {
		return errors.New("action deadline has expired")
	}
	switch action.Type {
	case "bid":
		if e.phase != "bidding" || e.turn != seat {
			return errors.New("not your bidding turn")
		}
		high := 0
		for _, b := range e.bids {
			if b > high {
				high = b
			}
		}
		if action.Score < 0 || action.Score > 3 || (action.Score != 0 && action.Score <= high) {
			return errors.New("bid must be zero or greater than the current bid, up to three")
		}
		e.bids[seat] = action.Score
		complete := action.Score == 3
		if !complete {
			complete = true
			for _, b := range e.bids {
				if b == -1 {
					complete = false
				}
			}
		}
		if complete {
			best := -1
			for s, b := range e.bids {
				if b > 0 && (best == -1 || b > e.bids[best]) {
					best = s
				}
			}
			if best == -1 {
				e.firstBidder = (e.firstBidder + 1) % 3
				e.deal(nowMS)
				return nil
			}
			e.landlord, e.phase, e.turn = best, "doubling", -1
			e.hands[best] = append(e.hands[best], e.bottom...)
			SortHand(e.hands[best])
			e.multiplier = int64(e.bids[best])
			e.deadline = nowMS + DoubleDurationMS
			for s := range 3 {
				if e.trustees[s] {
					e.doubles[s] = 1
				}
			}
			e.maybeStartPlaying(nowMS)
		} else {
			e.turn = (seat + 1) % 3
			e.setDeadline(nowMS, BidDurationMS)
		}
		return nil
	case "double":
		if e.phase != "doubling" {
			return errors.New("not in doubling phase")
		}
		if e.doubles[seat] != -1 {
			return errors.New("doubling choice already made")
		}
		e.doubles[seat] = 1
		if action.Double {
			e.doubles[seat] = 2
		}
		e.maybeStartPlaying(nowMS)
		return nil
	case "play", "pass":
		if e.phase != "playing" || e.turn != seat {
			return errors.New("not your playing turn")
		}
		if action.Type == "pass" {
			if e.last == nil {
				return errors.New("cannot pass when leading")
			}
			e.history = append(e.history, Play{Seat: seat, Cards: []int{}, Kind: "pass"})
			e.passes++
			if e.passes == 2 {
				e.turn = e.last.Seat
				e.last = nil
				e.lastCombo = Combo{}
				e.passes = 0
			} else {
				e.turn = (seat + 1) % 3
			}
			e.setDeadline(nowMS, TurnDurationMS)
			return nil
		}
		combo, err := Classify(action.Cards)
		if err != nil {
			return err
		}
		owned := [54]bool{}
		for _, c := range e.hands[seat] {
			owned[c] = true
		}
		for _, c := range action.Cards {
			if !owned[c] {
				return errors.New("cards are not in your hand")
			}
		}
		if e.last != nil && !combo.Beats(e.lastCombo) {
			return errors.New("play does not beat the previous play")
		}
		selected := [54]bool{}
		for _, c := range action.Cards {
			selected[c] = true
		}
		remaining := make([]int, 0, len(e.hands[seat])-len(action.Cards))
		for _, c := range e.hands[seat] {
			if !selected[c] {
				remaining = append(remaining, c)
			}
		}
		e.hands[seat] = remaining
		cards := append([]int(nil), action.Cards...)
		SortHand(cards)
		e.last, e.lastCombo, e.passes = &Play{Seat: seat, Cards: cards, Kind: combo.Kind}, combo, 0
		e.history = append(e.history, *clonePlay(e.last))
		e.played[seat]++
		if combo.Kind == "bomb" || combo.Kind == "rocket" {
			e.multiplier *= 2
		}
		if len(remaining) == 0 {
			e.phase, e.winner, e.turn, e.deadline = "finished", seat, -1, 0
			if seat == e.landlord {
				e.spring = e.played[(seat+1)%3] == 0 && e.played[(seat+2)%3] == 0
			} else {
				e.spring = e.played[e.landlord] == 1
			}
			if e.spring {
				e.multiplier *= 2
			}
		} else {
			e.turn = (seat + 1) % 3
			e.setDeadline(nowMS, TurnDurationMS)
		}
		return nil
	default:
		return errors.New("unknown action")
	}
}

func (e *Engine) maybeStartPlaying(nowMS int64) {
	for _, d := range e.doubles {
		if d == -1 {
			return
		}
	}
	e.phase, e.turn = "playing", e.landlord
	e.setDeadline(nowMS, TurnDurationMS)
}

// Tick applies at most one timed transition. Network code should call it often.
func (e *Engine) Tick(nowMS int64) bool {
	if e.phase == "finished" || nowMS < e.deadline {
		return false
	}
	if e.phase == "doubling" {
		for s := range 3 {
			if e.doubles[s] == -1 {
				e.doubles[s] = 1
			}
		}
		e.maybeStartPlaying(nowMS)
		return true
	}
	seat := e.turn
	if e.phase == "bidding" {
		return e.apply(seat, Action{Type: "bid", Score: 0}, nowMS, true) == nil
	}
	if e.last != nil {
		return e.apply(seat, Action{Type: "pass"}, nowMS, true) == nil
	}
	if len(e.hands[seat]) == 0 {
		return false
	}
	card := e.hands[seat][len(e.hands[seat])-1]
	return e.apply(seat, Action{Type: "play", Cards: []int{card}}, nowMS, true) == nil
}

func (e *Engine) Finished() bool        { return e.phase == "finished" }
func (e *Engine) Trustee(seat int) bool { return seat >= 0 && seat < 3 && e.trustees[seat] }

func (e *Engine) Hint(seat int) [][]int {
	if e.phase != "playing" || e.turn != seat || seat < 0 || seat > 2 {
		return [][]int{}
	}
	return Candidates(e.hands[seat], e.lastCombo)
}

func (e *Engine) View(seat int) GameView {
	v := GameView{RoundID: e.roundID, Phase: e.phase, Hand: []int{}, Bottom: []int{}, Turn: e.turn,
		Bids: append([]int(nil), e.bids[:]...), Doubles: append([]int(nil), e.doubles[:]...), Landlord: e.landlord,
		LastPlay: clonePlay(e.last), Passes: e.passes, Remaining: []int{len(e.hands[0]), len(e.hands[1]), len(e.hands[2])},
		Deadline: e.deadline, Multiplier: e.multiplier, Winner: e.winner}
	if seat >= 0 && seat < 3 {
		v.Hand = append(v.Hand, e.hands[seat]...)
	}
	if e.landlord >= 0 {
		v.Bottom = append(v.Bottom, e.bottom...)
	}
	v.History = make([]Play, len(e.history))
	for i := range e.history {
		v.History[i] = *clonePlay(&e.history[i])
	}
	if e.settlement != nil {
		s := copySettlement(*e.settlement)
		v.Settlement = &s
	}
	return v
}

func clonePlay(p *Play) *Play {
	if p == nil {
		return nil
	}
	return &Play{Seat: p.Seat, Cards: append([]int{}, p.Cards...), Kind: p.Kind}
}
func copySettlement(s Settlement) Settlement {
	return Settlement{Deltas: append([]int64{}, s.Deltas...), Balances: append([]int64{}, s.Balances...), Spring: s.Spring}
}

// Rank returns 3..15 (2), 16/17 (jokers), or -1 for an invalid physical card.
func Rank(card int) int {
	if card < 0 || card > 53 {
		return -1
	}
	if card >= 52 {
		return card - 36
	}
	return card/4 + 3
}
func SortHand(cards []int) {
	sort.Slice(cards, func(i, j int) bool {
		ri, rj := Rank(cards[i]), Rank(cards[j])
		if ri != rj {
			return ri > rj
		}
		return cards[i] > cards[j]
	})
}
