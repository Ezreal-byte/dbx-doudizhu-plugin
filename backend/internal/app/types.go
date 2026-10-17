package app

import "dbx-doudizhu-plugin/backend/internal/game"

// Protocol 2 adds five-character profiles; older clients reject indices 3 and 4.
const Protocol = 2
const CharacterCount = 5
const MaxBeans int64 = 1000000

type Profile struct {
	ID        string  `json:"id"`
	Nickname  string  `json:"nickname"`
	Character int     `json:"character"`
	Music     float64 `json:"music"`
	Sound     float64 `json:"sound"`
	Voice     float64 `json:"voice"`
	LowMotion bool    `json:"lowMotion"`
}

type RoomInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Address      string   `json:"address"`
	Addresses    []string `json:"addresses,omitempty"`
	Count        int      `json:"count"`
	Locked       bool     `json:"locked"`
	Phase        string   `json:"phase"`
	InitialBeans int64    `json:"initialBeans"`
	Protocol     int      `json:"protocol"`
}

type PlayerView struct {
	ID        string `json:"id"`
	Nickname  string `json:"nickname"`
	Character int    `json:"character"`
	Seat      int    `json:"seat"`
	Beans     int64  `json:"beans"`
	Ready     bool   `json:"ready"`
	Connected bool   `json:"connected"`
	Trustee   bool   `json:"trustee"`
	IsHost    bool   `json:"isHost"`
}

type Snapshot struct {
	Room       RoomInfo       `json:"room"`
	SelfID     string         `json:"selfId"`
	HostID     string         `json:"hostId"`
	Players    []PlayerView   `json:"players"`
	Game       *game.GameView `json:"game"`
	Revision   uint64         `json:"revision"`
	ResetVotes []string       `json:"resetVotes"`
	Connection string         `json:"connection"`
}

type SocialEvent struct {
	ID       string `json:"id"`
	RoomID   string `json:"roomId"`
	FromID   string `json:"fromId"`
	TargetID string `json:"targetId"`
	Kind     string `json:"kind"`
	Phrase   string `json:"phrase,omitempty"`
	At       int64  `json:"at"`
}

type EventSink func(method string, params any)

type CreateParams struct {
	Name         string `json:"name"`
	Password     string `json:"password"`
	InitialBeans int64  `json:"initialBeans"`
}

type JoinParams struct {
	Address  string `json:"address"`
	RoomID   string `json:"roomId"`
	Password string `json:"password"`
}

type ActionParams struct {
	ActionID         string  `json:"actionId"`
	ExpectedRevision *uint64 `json:"expectedRevision,omitempty"`
	ExpectedRoundID  string  `json:"expectedRoundId,omitempty"`
	game.Action
}

type SocialParams struct {
	ActionID string `json:"actionId"`
	TargetID string `json:"targetId"`
	Kind     string `json:"kind"`
	Phrase   string `json:"phrase,omitempty"`
}
