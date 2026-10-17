package game

import "math/big"

// Settle is idempotent. Each losing player's payment is capped by that player's
// pre-settlement balance. A winner has no earnings cap. When the landlord loses
// and cannot pay both farmers, the farmers share the available beans in their
// theoretical payout ratio; indivisible beans go to ascending seat numbers.
func (e *Engine) Settle(balances [3]int64) Settlement {
	if e.settlement != nil {
		return copySettlement(*e.settlement)
	}
	s := Settlement{Deltas: make([]int64, 3), Balances: make([]int64, 3), Spring: e.spring}
	for seat, b := range balances {
		if b < 0 {
			b = 0
		}
		s.Balances[seat] = b
	}
	if !e.Finished() {
		return s
	}
	landlord := e.landlord
	amounts := [3]int64{}
	for seat := range 3 {
		if seat != landlord {
			amounts[seat] = BaseBeans * e.multiplier * int64(e.doubles[seat]) * int64(e.doubles[landlord])
		}
	}
	if e.winner == landlord {
		for seat := range 3 {
			if seat != landlord {
				paid := min(amounts[seat], s.Balances[seat])
				s.Deltas[seat] = -paid
				s.Deltas[landlord] += paid
			}
		}
	} else {
		total := amounts[0] + amounts[1] + amounts[2]
		available := min(total, s.Balances[landlord])
		payout := proportional(amounts, available)
		for seat := range 3 {
			if seat != landlord {
				s.Deltas[seat] = payout[seat]
				s.Deltas[landlord] -= payout[seat]
			}
		}
	}
	for seat := range 3 {
		s.Balances[seat] += s.Deltas[seat]
	}
	e.settlement = &s
	return copySettlement(s)
}

func proportional(weights [3]int64, total int64) [3]int64 {
	out := [3]int64{}
	sum := weights[0] + weights[1] + weights[2]
	if total <= 0 || sum <= 0 {
		return out
	}
	var paid int64
	for seat, w := range weights {
		if w > 0 {
			n := new(big.Int).Mul(big.NewInt(total), big.NewInt(w))
			n.Quo(n, big.NewInt(sum))
			out[seat] = n.Int64()
			paid += out[seat]
		}
	}
	for seat := 0; paid < total; seat = (seat + 1) % 3 {
		if weights[seat] > 0 && out[seat] < weights[seat] {
			out[seat]++
			paid++
		}
	}
	return out
}
