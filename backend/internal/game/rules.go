package game

import (
	"errors"
	"fmt"

	legacy "dbx-doudizhu-plugin/backend/internal/game/thirdparty/dolotech"
)

// Combo keeps the audited classification and upstream packed rank histogram.
// The legacy analyser is not used as an authority: it accepts some invalid
// wing layouts (including a second bomb as the two pairs of four-with-pairs).
type Combo struct {
	Kind   string
	Rank   int
	Size   int
	packed legacy.AnalyseCards
}

var kindNames = map[uint8]string{
	legacy.DAN_TIAO: "single", legacy.DUI_ZI: "pair", legacy.SAN_TIAO: "triple",
	legacy.SAN_DAI_YI: "tripleSingle", legacy.SAN_DAI_YI_DUI: "triplePair",
	legacy.DAN_SHUN_ZI: "straight", legacy.LIAN_DUI: "pairStraight", legacy.SAN_SHUN_ZI: "airplane",
	legacy.FEI_JI_DAI_DAN: "airplaneSingle", legacy.FEI_JI_DAI_DUI: "airplanePair",
	legacy.SI_DAI_DAN: "fourTwoSingle", legacy.SI_DAI_DUI: "fourTwoPair",
	legacy.ZHA_DAN: "bomb", legacy.WANG_ZHA: "rocket",
}

func (c Combo) Beats(previous Combo) bool {
	if c.Kind == "" {
		return false
	}
	if previous.Kind == "" {
		return true
	}
	p := c.packed
	return p.FollowAnalyseCards(previous.packed)
}

func Classify(cards []int) (Combo, error) {
	if len(cards) == 0 || len(cards) > 20 {
		return Combo{}, errors.New("select between one and twenty cards")
	}
	seen := [54]bool{}
	ranks := make([]byte, len(cards))
	for i, c := range cards {
		if c < 0 || c >= 54 {
			return Combo{}, fmt.Errorf("invalid card id %d", c)
		}
		if seen[c] {
			return Combo{}, errors.New("duplicate physical card")
		}
		seen[c] = true
		ranks[i] = byte(Rank(c))
	}
	var packed legacy.AnalyseCards
	packed.SetSortCards(ranks)
	counts := [18]int{}
	for r := 3; r <= 17; r++ {
		counts[r] = int(packed.Get(byte(r)))
	}
	kind, high := classifyCounts(counts, len(cards))
	if kind == 0 {
		return Combo{}, errors.New("invalid card combination")
	}
	packed.SetKind(kind)
	packed.SetValue(byte(high))
	return Combo{Kind: kindNames[kind], Rank: high, Size: len(cards), packed: packed}, nil
}

func classifyCounts(c [18]int, n int) (uint8, int) {
	if n == 2 && c[16] == 1 && c[17] == 1 {
		return legacy.WANG_ZHA, 17
	}
	for r := 3; r <= 17; r++ {
		if c[r] == n {
			switch n {
			case 1:
				return legacy.DAN_TIAO, r
			case 2:
				return legacy.DUI_ZI, r
			case 3:
				return legacy.SAN_TIAO, r
			case 4:
				return legacy.ZHA_DAN, r
			}
		}
	}
	if n == 4 || n == 5 {
		for r := 3; r <= 15; r++ {
			if c[r] == 3 {
				if n == 4 {
					return legacy.SAN_DAI_YI, r
				}
				for w := 3; w <= 15; w++ {
					if w != r && c[w] == 2 {
						return legacy.SAN_DAI_YI_DUI, r
					}
				}
			}
		}
	}
	// Pure runs must contain only 3..A, with exactly the stated multiplicity.
	for _, run := range []struct {
		copies, min int
		kind        uint8
	}{{1, 5, legacy.DAN_SHUN_ZI}, {2, 3, legacy.LIAN_DUI}, {3, 2, legacy.SAN_SHUN_ZI}} {
		if n%run.copies != 0 || n/run.copies < run.min || c[15]+c[16]+c[17] > 0 {
			continue
		}
		low, high, distinct := 0, 0, 0
		valid := true
		for r := 3; r <= 14; r++ {
			if c[r] > 0 {
				if c[r] != run.copies {
					valid = false
					break
				}
				if low == 0 {
					low = r
				}
				high = r
				distinct++
			}
		}
		if valid && distinct > 0 && high-low+1 == distinct {
			return run.kind, high
		}
	}
	if n == 6 || n == 8 {
		for r := 3; r <= 15; r++ {
			if c[r] == 4 {
				if n == 6 && !(c[16] == 1 && c[17] == 1) {
					return legacy.SI_DAI_DAN, r
				}
				if n == 8 {
					pairs := 0
					for w := 3; w <= 15; w++ {
						if w != r && c[w] == 2 {
							pairs++
						}
					}
					if pairs == 2 {
						return legacy.SI_DAI_DUI, r
					}
				}
			}
		}
	}
	// Airplane bodies cannot include 2/jokers or retain a fourth body card as a
	// wing. Single wings may form pairs, but never triples or both jokers.
	for _, spec := range []struct {
		div  int
		kind uint8
	}{{4, legacy.FEI_JI_DAI_DAN}, {5, legacy.FEI_JI_DAI_DUI}} {
		if n%spec.div != 0 {
			continue
		}
		bodies := n / spec.div
		if bodies < 2 {
			continue
		}
		for high := 14; high >= 3+bodies-1; high-- {
			low := high - bodies + 1
			rest := c
			valid := true
			for r := low; r <= high; r++ {
				if rest[r] != 3 {
					valid = false
					break
				}
				rest[r] = 0
			}
			if !valid {
				continue
			}
			if spec.div == 4 {
				if rest[16] > 0 && rest[17] > 0 {
					continue
				}
				for r := 3; r <= 17; r++ {
					if rest[r] > 2 {
						valid = false
						break
					}
				}
			} else {
				pairs := 0
				for r := 3; r <= 17; r++ {
					if rest[r] == 2 && r <= 15 {
						pairs++
					} else if rest[r] != 0 {
						valid = false
						break
					}
				}
				valid = valid && pairs == bodies
			}
			if valid {
				return spec.kind, high
			}
		}
	}
	return 0, 0
}
