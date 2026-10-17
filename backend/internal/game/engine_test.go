package game

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"reflect"
	"testing"
)

func playing(hands [3][]int, landlord int) *Engine {
	e := &Engine{roundID: "test", phase: "playing", hands: hands, landlord: landlord, winner: -1, turn: landlord,
		bids: [3]int{0, 0, 0}, doubles: [3]int{1, 1, 1}, multiplier: 1}
	for s := range 3 {
		SortHand(e.hands[s])
	}
	e.bids[landlord] = 1
	e.setDeadline(1000, TurnDurationMS)
	return e
}

func do(t *testing.T, e *Engine, seat int, a Action, now int64) {
	t.Helper()
	if err := e.Apply(seat, a, now); err != nil {
		t.Fatalf("seat %d action %+v: %v", seat, a, err)
	}
}

func TestDealPrivacyBiddingAndDoubling(t *testing.T) {
	e := New("round1", 1, 1000)
	if e.View(1).Deadline != 16000 {
		t.Fatal("initial bid must allow exactly 15 seconds")
	}
	all := map[int]bool{}
	for s := range 3 {
		v := e.View(s)
		if len(v.Hand) != 17 || len(v.Bottom) != 0 || v.Landlord != -1 {
			t.Fatalf("bad deal %+v", v)
		}
		for _, c := range v.Hand {
			if all[c] {
				t.Fatal("duplicate dealt card")
			}
			all[c] = true
		}
	}
	for _, c := range e.bottom {
		if all[c] {
			t.Fatal("duplicate bottom")
		}
		all[c] = true
	}
	if len(all) != 54 {
		t.Fatal("missing cards")
	}
	if len(e.View(-1).Hand) != 0 {
		t.Fatal("spectator sees private hand")
	}
	if err := e.Apply(0, Action{Type: "bid", Score: 1}, 2000); err == nil {
		t.Fatal("out-of-turn bid accepted")
	}
	do(t, e, 1, Action{Type: "bid", Score: 1}, 2000)
	if e.View(2).Deadline != 17000 {
		t.Fatal("next bid must allow exactly 15 seconds")
	}
	if err := e.Apply(2, Action{Type: "bid", Score: 1}, 3000); err == nil {
		t.Fatal("nonincreasing bid")
	}
	do(t, e, 2, Action{Type: "bid", Score: 2}, 3000)
	do(t, e, 0, Action{Type: "bid", Score: 0}, 4000)
	v := e.View(2)
	if v.Phase != "doubling" || v.Landlord != 2 || v.Turn != -1 || len(v.Hand) != 20 || len(v.Bottom) != 3 || v.Deadline != 14000 {
		t.Fatalf("bad landlord %+v", v)
	}
	do(t, e, 0, Action{Type: "double", Double: true}, 5000)
	if err := e.Apply(0, Action{Type: "double"}, 5001); err == nil {
		t.Fatal("revised doubling choice")
	}
	do(t, e, 2, Action{Type: "double"}, 6000)
	do(t, e, 1, Action{Type: "double"}, 7000)
	v = e.View(2)
	if v.Phase != "playing" || v.Turn != 2 || v.Multiplier != 2 || v.Deadline != 27000 || !reflect.DeepEqual(v.Doubles, []int{2, 1, 1}) {
		t.Fatalf("bad play start %+v", v)
	}
}

func TestThreeBidAndAllPassRedeal(t *testing.T) {
	e := New("r", 0, 0)
	for seat := range 3 {
		do(t, e, seat, Action{Type: "bid", Score: 0}, int64(seat+1))
	}
	if e.phase != "bidding" || e.turn != 1 || e.landlord != -1 || e.bids != [3]int{-1, -1, -1} {
		t.Fatal("all-pass must redeal with next first bidder")
	}
	if e.deadline != 15003 {
		t.Fatal("redeal must preserve the 15-second bidding deadline")
	}
	do(t, e, 1, Action{Type: "bid", Score: 3}, 10)
	if e.phase != "doubling" || e.landlord != 1 || e.multiplier != 3 {
		t.Fatal("three should end bidding immediately")
	}
}

func TestApplyValidatesOwnershipTurnAndDuplicatesWithoutMutation(t *testing.T) {
	e := playing([3][]int{cards(3, 4), cards(5), cards(6)}, 0)
	before, _ := json.Marshal(e.View(0))
	for _, tt := range []struct {
		seat int
		a    Action
	}{{-1, Action{Type: "play", Cards: cards(3)}}, {1, Action{Type: "play", Cards: cards(5)}}, {0, Action{Type: "play", Cards: cards(5)}}, {0, Action{Type: "play", Cards: []int{0, 0}}}, {0, Action{Type: "pass"}}, {0, Action{Type: "dance"}}} {
		if err := e.Apply(tt.seat, tt.a, 2000); err == nil {
			t.Fatalf("accepted %+v", tt)
		}
		after, _ := json.Marshal(e.View(0))
		if string(before) != string(after) {
			t.Fatal("rejected action mutated game")
		}
	}
}

func TestTwoPassesResetLead(t *testing.T) {
	e := playing([3][]int{cards(3, 7), cards(4, 8), cards(5, 9)}, 0)
	do(t, e, 0, Action{Type: "play", Cards: cards(7)}, 1100)
	do(t, e, 1, Action{Type: "pass"}, 1200)
	do(t, e, 2, Action{Type: "pass"}, 1300)
	if e.turn != 0 || e.last != nil || e.passes != 0 {
		t.Fatal("lead should return to last player")
	}
	do(t, e, 0, Action{Type: "play", Cards: cards(3)}, 1400)
	if !e.Finished() || e.winner != 0 || !e.spring || e.multiplier != 2 {
		t.Fatal("landlord spring not recorded")
	}
}

func TestTimersAndTrusteeCannotExtendDeadline(t *testing.T) {
	e := playing([3][]int{cards(3, 7), cards(4, 8), cards(5, 9)}, 0)
	if e.Tick(20999) {
		t.Fatal("early transition")
	}
	if !e.Tick(21000) || e.last.Cards[0] != cards(3)[0] || e.turn != 1 {
		t.Fatal("timeout should lead smallest single")
	}
	if !e.Tick(41000) || e.passes != 1 || e.turn != 2 {
		t.Fatal("timeout should pass when following")
	}
	e = playing([3][]int{cards(3, 7), cards(4, 8), cards(5, 9)}, 0)
	do(t, e, 0, Action{Type: "trustee", Enabled: true}, 10000)
	if e.deadline != 11000 {
		t.Fatal("trustee delay")
	}
	do(t, e, 0, Action{Type: "trustee", Enabled: false}, 10500)
	if e.deadline != 21000 {
		t.Fatal("trustee cancellation extended turn")
	}
	do(t, e, 0, Action{Type: "trustee", Enabled: false}, 20500)
	if e.deadline != 21000 {
		t.Fatal("repeated false extended turn")
	}
	do(t, e, 0, Action{Type: "trustee", Enabled: true}, 20500)
	if e.deadline != 21000 {
		t.Fatal("trustee should not extend almost-expired turn")
	}
	e = New("r", 0, 0)
	if e.Tick(14999) || !e.Tick(15000) || e.bids[0] != 0 || e.turn != 1 || e.deadline != 30000 {
		t.Fatal("bid timeout")
	}
	do(t, e, 1, Action{Type: "bid", Score: 3}, 16000)
	if e.Tick(25999) || !e.Tick(26000) || e.phase != "playing" || e.doubles != [3]int{1, 1, 1} || e.deadline != 46000 {
		t.Fatal("doubling timeout")
	}
}

func TestLatePlayerActionsAreRejectedAndTimerStillAdvances(t *testing.T) {
	e := playing([3][]int{cards(3, 7), cards(4, 8), cards(5, 9)}, 0)
	before, _ := json.Marshal(e.View(0))
	if err := e.Apply(0, Action{Type: "play", Cards: cards(7)}, 21000); err == nil {
		t.Fatal("accepted action exactly at deadline")
	}
	after, _ := json.Marshal(e.View(0))
	if string(before) != string(after) {
		t.Fatal("late action mutated state")
	}
	if !e.Tick(21000) || e.last.Cards[0] != cards(3)[0] {
		t.Fatal("timer must apply automatic smallest single")
	}
	e = New("r", 0, 0)
	do(t, e, 0, Action{Type: "bid", Score: 3}, 1)
	if err := e.Apply(1, Action{Type: "double", Double: true}, 10001); err == nil {
		t.Fatal("late doubling accepted")
	}
	if !e.Tick(10001) || e.doubles != [3]int{1, 1, 1} {
		t.Fatal("doubling timeout failed")
	}
}

func TestBombRocketAndAntiSpring(t *testing.T) {
	e := playing([3][]int{cards(3, 3, 3, 3, 4), cards(16, 17), cards(5, 6)}, 0)
	do(t, e, 0, Action{Type: "play", Cards: cards(3, 3, 3, 3)}, 1100)
	if e.multiplier != 2 {
		t.Fatal("bomb did not double")
	}
	do(t, e, 1, Action{Type: "play", Cards: cards(16, 17)}, 1200)
	if e.multiplier != 8 || !e.spring || e.winner != 1 {
		t.Fatal("rocket/anti-spring expected 8x")
	}
	e = playing([3][]int{cards(3, 4), cards(5), cards(6)}, 0)
	e.played[0] = 1
	do(t, e, 0, Action{Type: "play", Cards: cards(3)}, 1100)
	do(t, e, 1, Action{Type: "play", Cards: cards(5)}, 1200)
	if e.spring || e.multiplier != 1 {
		t.Fatal("landlord already played twice: no anti-spring")
	}
}

func TestSettlementLossCapsRemainderAndIdempotency(t *testing.T) {
	e := &Engine{phase: "finished", landlord: 0, winner: 0, multiplier: 3, doubles: [3]int{2, 2, 1}}
	s := e.Settle([3]int64{10, 100, 1000})
	if !reflect.DeepEqual(s.Deltas, []int64{700, -100, -600}) || !reflect.DeepEqual(s.Balances, []int64{710, 0, 400}) {
		t.Fatalf("wrong caps, winner must have no cap: %+v", s)
	}
	s.Deltas[0] = -999
	if again := e.Settle([3]int64{99, 99, 99}); again.Deltas[0] != 700 {
		t.Fatal("settlement not immutable/idempotent")
	}
	e = &Engine{phase: "finished", landlord: 1, winner: 0, multiplier: 1, doubles: [3]int{1, 1, 2}}
	s = e.Settle([3]int64{100, 100, 100})
	if !reflect.DeepEqual(s.Deltas, []int64{34, -100, 66}) {
		t.Fatalf("proportional remainder should go to lower seat: %+v", s)
	}
	if s.Balances[0]+s.Balances[1]+s.Balances[2] != 300 {
		t.Fatal("beans not conserved")
	}
	e = &Engine{phase: "finished", landlord: 2, winner: 0, multiplier: 1, doubles: [3]int{1, 1, 1}}
	if got := e.Settle([3]int64{0, 0, 1}); !reflect.DeepEqual(got.Deltas, []int64{1, 0, -1}) {
		t.Fatalf("one bean remainder %+v", got)
	}
}

func TestViewClonesPrivateAndSharedSlices(t *testing.T) {
	e := playing([3][]int{cards(3, 7), cards(4, 8), cards(5, 9)}, 0)
	do(t, e, 0, Action{Type: "play", Cards: cards(3)}, 1100)
	v := e.View(0)
	v.Hand[0] = 53
	v.Bids[0] = 99
	v.LastPlay.Cards[0] = 53
	v.History[0].Cards[0] = 52
	if e.hands[0][0] != cards(7)[0] || e.bids[0] != 1 || e.last.Cards[0] != 0 || e.history[0].Cards[0] != 0 {
		t.Fatal("View leaks mutable references")
	}
	data, err := json.Marshal(e.View(1))
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"roundId", "phase", "hand", "bottom", "turn", "bids", "doubles", "landlord", "lastPlay", "passes", "remaining", "deadline", "multiplier", "winner"} {
		if _, ok := wire[key]; !ok {
			t.Fatalf("missing contract key %s", key)
		}
	}
}

func TestRandomFullRounds(t *testing.T) {
	rng := rand.New(rand.NewPCG(2026, 1016))
	for round := range 36 {
		e := New(fmt.Sprint(round), round%3, 0)
		deck := rng.Perm(54)
		for s := range 3 {
			e.hands[s] = append([]int{}, deck[s*17:(s+1)*17]...)
			SortHand(e.hands[s])
		}
		e.bottom = append([]int{}, deck[51:]...)
		now := int64(1)
		do(t, e, round%3, Action{Type: "bid", Score: 3}, now)
		for seat := range 3 {
			now++
			do(t, e, seat, Action{Type: "double", Double: rng.IntN(2) == 1}, now)
		}
		for step := 0; !e.Finished() && step < 200; step++ {
			now++
			seat := e.turn
			choices := e.Hint(seat)
			action := Action{Type: "pass"}
			if len(choices) > 0 {
				action = Action{Type: "play", Cards: choices[rng.IntN(min(4, len(choices)))]}
			}
			do(t, e, seat, action, now)
			seen := [54]bool{}
			count := 0
			for _, h := range e.hands {
				for _, c := range h {
					if seen[c] {
						t.Fatalf("round %d duplicate held card", round)
					}
					seen[c] = true
					count++
				}
			}
			for _, p := range e.history {
				for _, c := range p.Cards {
					if seen[c] {
						t.Fatalf("round %d reused played card", round)
					}
					seen[c] = true
					count++
				}
			}
			if count != 54 {
				t.Fatalf("round %d card conservation: %d", round, count)
			}
		}
		if !e.Finished() {
			t.Fatalf("round %d failed to terminate", round)
		}
		balances := [3]int64{int64(rng.IntN(1_000_000)), int64(rng.IntN(1_000_000)), int64(rng.IntN(1_000_000))}
		s := e.Settle(balances)
		var deltas, total int64
		for seat := range 3 {
			deltas += s.Deltas[seat]
			total += s.Balances[seat]
			if s.Balances[seat] < 0 {
				t.Fatal("negative beans")
			}
		}
		if deltas != 0 || total != balances[0]+balances[1]+balances[2] {
			t.Fatalf("round %d non-zero-sum %+v", round, s)
		}
	}
}
