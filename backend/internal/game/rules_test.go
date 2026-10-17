package game

import (
	"fmt"
	"math/rand/v2"
	"reflect"
	"testing"
)

func cards(ranks ...int) []int {
	used := [18]int{}
	out := make([]int, 0, len(ranks))
	for _, r := range ranks {
		if r == 16 {
			out = append(out, 52)
		} else if r == 17 {
			out = append(out, 53)
		} else {
			out = append(out, (r-3)*4+used[r])
			used[r]++
		}
	}
	return out
}

func mustCombo(t *testing.T, ranks ...int) Combo {
	t.Helper()
	c, err := Classify(cards(ranks...))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestAllFourteenCombinations(t *testing.T) {
	tests := []struct {
		kind  string
		rank  int
		ranks []int
	}{
		{"single", 17, []int{17}}, {"pair", 15, []int{15, 15}}, {"triple", 3, []int{3, 3, 3}},
		{"tripleSingle", 5, []int{5, 5, 5, 17}}, {"triplePair", 6, []int{6, 6, 6, 15, 15}},
		{"straight", 14, []int{10, 11, 12, 13, 14}}, {"pairStraight", 6, []int{4, 4, 5, 5, 6, 6}},
		{"airplane", 5, []int{3, 3, 3, 4, 4, 4, 5, 5, 5}},
		{"airplaneSingle", 4, []int{3, 3, 3, 4, 4, 4, 8, 17}},
		{"airplanePair", 4, []int{3, 3, 3, 4, 4, 4, 8, 8, 15, 15}},
		{"fourTwoSingle", 5, []int{5, 5, 5, 5, 3, 16}},
		{"fourTwoPair", 5, []int{5, 5, 5, 5, 3, 3, 15, 15}},
		{"bomb", 15, []int{15, 15, 15, 15}}, {"rocket", 17, []int{16, 17}},
	}
	for _, test := range tests {
		t.Run(test.kind, func(t *testing.T) {
			c, err := Classify(cards(test.ranks...))
			if err != nil {
				t.Fatal(err)
			}
			if c.Kind != test.kind || c.Rank != test.rank || c.Size != len(test.ranks) {
				t.Fatalf("got %+v", c)
			}
			if c.Beats(c) {
				t.Fatal("same play beats itself")
			}
		})
	}
}

func TestInvalidShapesAndCardIDs(t *testing.T) {
	invalid := [][]int{
		{}, {54}, {-1}, {0, 0}, cards(3, 4), cards(3, 3, 4), cards(3, 4, 5, 6),
		cards(11, 12, 13, 14, 15), cards(3, 4, 5, 6, 16), cards(3, 3, 4, 4),
		cards(3, 3, 4, 4, 6, 6), cards(14, 14, 14, 15, 15, 15),
		cards(3, 3, 3, 4, 4, 4, 16, 17),     // Both jokers cannot be single wings.
		cards(3, 3, 3, 3, 4, 4, 4, 4),       // Fourth body cards cannot be wings or two pairs.
		cards(3, 3, 3, 4, 4, 4, 7, 7, 7, 7), // A bomb is not two different wing pairs.
		cards(3, 3, 3, 4, 4, 4, 7, 7, 8, 9),
		cards(3, 3, 3, 3, 16, 17),
		cards(3, 3, 3, 4, 4, 4, 5, 5, 5, 8, 8, 8), // Triple is not three single wings.
	}
	for _, hand := range invalid {
		if got, err := Classify(hand); err == nil {
			t.Errorf("accepted %v as %+v", hand, got)
		}
	}
}

func TestWingVariantsAndPureRunPrecedence(t *testing.T) {
	for _, tt := range []struct {
		ranks []int
		kind  string
	}{
		{[]int{3, 3, 3, 4, 4, 4, 9, 9}, "airplaneSingle"},
		{[]int{3, 3, 3, 4, 4, 4, 5, 5, 5, 7, 7, 17}, "airplaneSingle"},
		{[]int{3, 3, 3, 3, 9, 9}, "fourTwoSingle"},
		{[]int{3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6}, "airplane"},
		{[]int{13, 13, 13, 14, 14, 14, 15, 15}, "airplaneSingle"},
	} {
		c, err := Classify(cards(tt.ranks...))
		if err != nil || c.Kind != tt.kind {
			t.Fatalf("%v got %+v %v", tt.ranks, c, err)
		}
	}
}

func TestComparisonShapeLengthAndBombPriority(t *testing.T) {
	if !mustCombo(t, 4).Beats(mustCombo(t, 3)) {
		t.Fatal("higher single")
	}
	if mustCombo(t, 4, 4).Beats(mustCombo(t, 3)) {
		t.Fatal("pair cannot beat single")
	}
	if mustCombo(t, 4, 5, 6, 7, 8, 9).Beats(mustCombo(t, 3, 4, 5, 6, 7)) {
		t.Fatal("run lengths must match")
	}
	if !mustCombo(t, 4, 4, 4, 3).Beats(mustCombo(t, 3, 3, 3, 17)) {
		t.Fatal("triple value determines comparison")
	}
	if !mustCombo(t, 3, 3, 3, 3).Beats(mustCombo(t, 17)) {
		t.Fatal("bomb should beat ordinary shape")
	}
	if !mustCombo(t, 4, 4, 4, 4).Beats(mustCombo(t, 3, 3, 3, 3)) {
		t.Fatal("higher bomb")
	}
	if !mustCombo(t, 16, 17).Beats(mustCombo(t, 15, 15, 15, 15)) {
		t.Fatal("rocket should beat bomb")
	}
	if mustCombo(t, 15, 15, 15, 15).Beats(mustCombo(t, 16, 17)) {
		t.Fatal("nothing beats rocket")
	}
}

func TestHintsAreLegalAndFindComplexResponse(t *testing.T) {
	hand := cards(4, 4, 4, 5, 5, 5, 9, 9, 10, 10, 12, 12, 12, 12, 16, 17)
	previous := mustCombo(t, 3, 3, 3, 4, 4, 4, 7, 7, 8, 8)
	choices := Candidates(hand, previous)
	if len(choices) == 0 {
		t.Fatal("missing airplane pair response")
	}
	foundPlane := false
	seen := map[string]bool{}
	for _, choice := range choices {
		c, err := Classify(choice)
		if err != nil || !c.Beats(previous) {
			t.Fatalf("invalid hint %v: %v", choice, err)
		}
		if c.Kind == "airplanePair" {
			foundPlane = true
		}
		key := fmt.Sprint(choice)
		if seen[key] {
			t.Fatal("duplicate hint")
		}
		seen[key] = true
		for _, card := range choice {
			present := false
			for _, h := range hand {
				present = present || card == h
			}
			if !present {
				t.Fatal("hint outside hand")
			}
		}
	}
	if !foundPlane {
		t.Fatal("missing airplane pair")
	}
	if got := Candidates(hand, mustCombo(t, 16, 17)); len(got) != 0 {
		t.Fatal("hint beats rocket")
	}
	whole := cards(3, 3, 3, 4, 4, 4, 5, 5, 5)
	if got := Candidates(whole, Combo{}); len(got) == 0 || len(got[0]) != len(whole) {
		t.Fatal("whole-hand win should be first")
	}
}

func TestClassificationDoesNotDependOnCardOrder(t *testing.T) {
	rng := rand.New(rand.NewPCG(17, 41))
	deck := make([]int, 54)
	for i := range deck {
		deck[i] = i
	}
	for i := 0; i < 2000; i++ {
		rng.Shuffle(54, func(a, b int) { deck[a], deck[b] = deck[b], deck[a] })
		hand := append([]int{}, deck[:1+rng.IntN(20)]...)
		a, ae := Classify(hand)
		rng.Shuffle(len(hand), func(a, b int) { hand[a], hand[b] = hand[b], hand[a] })
		b, be := Classify(hand)
		if (ae == nil) != (be == nil) || !reflect.DeepEqual(a, b) {
			t.Fatalf("order changed classification %v %+v %+v", hand, a, b)
		}
	}
}

func BenchmarkHintTwentyCards(b *testing.B) {
	hand := cards(3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17)
	for i := 0; i < b.N; i++ {
		Candidates(hand, Combo{})
	}
}
