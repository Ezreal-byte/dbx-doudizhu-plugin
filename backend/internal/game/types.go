package game

// Action is a player's request; the room owns request idempotency and revision checks.
type Action struct {
	Type    string `json:"type"`
	Score   int    `json:"score,omitempty"`
	Double  bool   `json:"double,omitempty"`
	Cards   []int  `json:"cards,omitempty"`
	Enabled bool   `json:"enabled,omitempty"`
}

type Play struct {
	Seat  int    `json:"seat"`
	Cards []int  `json:"cards"`
	Kind  string `json:"kind"`
}

type Settlement struct {
	Deltas   []int64 `json:"deltas"`
	Balances []int64 `json:"balances"`
	Spring   bool    `json:"spring"`
}

type GameView struct {
	RoundID    string      `json:"roundId"`
	Phase      string      `json:"phase"`
	Hand       []int       `json:"hand"`
	Bottom     []int       `json:"bottom"`
	Turn       int         `json:"turn"`
	Bids       []int       `json:"bids"`
	Doubles    []int       `json:"doubles"`
	Landlord   int         `json:"landlord"`
	LastPlay   *Play       `json:"lastPlay"`
	Passes     int         `json:"passes"`
	Remaining  []int       `json:"remaining"`
	Deadline   int64       `json:"deadline"`
	Multiplier int64       `json:"multiplier"`
	Winner     int         `json:"winner"`
	Settlement *Settlement `json:"settlement,omitempty"`
	History    []Play      `json:"history,omitempty"`
}
