package game

import "sort"

// Candidates enumerates rank multiplicities, never suit permutations. Every
// result is independently classified and checked against the previous play.
// The response is bounded to 64 useful choices (a whole-hand win is first).
func Candidates(hand []int, previous Combo) [][]int {
	if len(hand) == 0 || len(hand) > 20 {
		return [][]int{}
	}
	groups := [18][]int{}
	seen := [54]bool{}
	for _, c := range hand {
		if c < 0 || c > 53 || seen[c] {
			return [][]int{}
		}
		seen[c] = true
		groups[Rank(c)] = append(groups[Rank(c)], c)
	}
	for r := 3; r <= 17; r++ {
		sort.Ints(groups[r])
	}
	ranks := make([]int, 0, 15)
	for r := 3; r <= 17; r++ {
		if len(groups[r]) > 0 {
			ranks = append(ranks, r)
		}
	}
	type choice struct {
		cards []int
		combo Combo
	}
	choices := make([]choice, 0, 64)
	counts := [18]int{}
	var visit func(int, int)
	visit = func(index, total int) {
		if index == len(ranks) {
			if total == 0 {
				return
			}
			if previous.Kind != "" && total != previous.Size && total != 4 && total != 2 {
				return
			}
			kind, _ := classifyCounts(counts, total)
			if kind == 0 {
				return
			}
			cards := make([]int, 0, total)
			for _, r := range ranks {
				cards = append(cards, groups[r][:counts[r]]...)
			}
			combo, err := Classify(cards)
			if err != nil || !combo.Beats(previous) {
				return
			}
			SortHand(cards)
			choices = append(choices, choice{cards, combo})
			return
		}
		r := ranks[index]
		for count := 0; count <= len(groups[r]); count++ {
			counts[r] = count
			visit(index+1, total+count)
		}
		counts[r] = 0
	}
	visit(0, 0)
	weight := func(c Combo) int {
		if c.Kind == "rocket" {
			return 2
		}
		if c.Kind == "bomb" {
			return 1
		}
		return 0
	}
	sort.Slice(choices, func(i, j int) bool {
		a, b := choices[i], choices[j]
		aw, bw := len(a.cards) == len(hand), len(b.cards) == len(hand)
		if aw != bw {
			return aw
		}
		if weight(a.combo) != weight(b.combo) {
			return weight(a.combo) < weight(b.combo)
		}
		if previous.Kind == "" && len(a.cards) != len(b.cards) {
			return len(a.cards) > len(b.cards)
		}
		if a.combo.Rank != b.combo.Rank {
			return a.combo.Rank < b.combo.Rank
		}
		if a.combo.Kind != b.combo.Kind {
			return a.combo.Kind < b.combo.Kind
		}
		for k := range min(len(a.cards), len(b.cards)) {
			if a.cards[k] != b.cards[k] {
				return a.cards[k] < b.cards[k]
			}
		}
		return false
	})
	result := make([][]int, 0, min(64, len(choices)))
	for i := 0; i < len(choices) && i < 64; i++ {
		result = append(result, choices[i].cards)
	}
	return result
}
