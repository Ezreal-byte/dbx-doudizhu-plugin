package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"dbx-doudizhu-plugin/backend/internal/game"
	"golang.org/x/crypto/bcrypt"
)

type member struct {
	view           PlayerView
	token          string
	epoch          string
	sink           EventSink
	left           bool
	seen           map[string]bool
	order          []string
	lastSocial     int64
	disconnectedAt int64
}

type Room struct {
	mu       sync.Mutex
	info     RoomInfo
	hostID   string
	password []byte
	players  [3]*member
	engine   *game.Engine
	revision uint64
	votes    map[string]bool
	round    int
	settled  bool
	closed   bool
	ledger   map[string]int64
}

func NewRoom(p Profile, input CreateParams, sink EventSink) (*Room, error) {
	input.Name = cleanText(input.Name, 32)
	if input.Name == "" {
		input.Name = p.Nickname + "的牌桌"
	}
	if input.InitialBeans == 0 {
		input.InitialBeans = 10000
	}
	if input.InitialBeans < 1000 || input.InitialBeans > MaxBeans {
		return nil, errors.New("初始欢乐豆范围是 1,000–1,000,000")
	}
	if input.Password != "" && (len(input.Password) < 4 || len(input.Password) > 32) {
		return nil, errors.New("房间密码需要 4–32 个字节")
	}
	r := &Room{info: RoomInfo{ID: randomID(), Name: input.Name, Count: 1, Locked: input.Password != "", Phase: "waiting", InitialBeans: input.InitialBeans, Protocol: Protocol}, hostID: p.ID, revision: 1, votes: map[string]bool{}, ledger: map[string]int64{p.ID: input.InitialBeans}}
	if input.Password != "" {
		var err error
		r.password, err = bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
	}
	r.players[0] = &member{view: PlayerView{ID: p.ID, Nickname: p.Nickname, Character: p.Character, Seat: 0, Beans: input.InitialBeans, Connected: true, IsHost: true}, token: randomID(), epoch: randomID(), sink: sink, seen: map[string]bool{}}
	return r, nil
}

func (r *Room) SetAddresses(addresses []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.info.Addresses = append([]string{}, addresses...)
	if len(addresses) > 0 {
		r.info.Address = addresses[0]
	}
}
func (r *Room) Info() RoomInfo { r.mu.Lock(); defer r.mu.Unlock(); return r.infoLocked() }
func (r *Room) infoLocked() RoomInfo {
	info := r.info
	info.Addresses = append([]string{}, info.Addresses...)
	info.Count = 0
	for _, m := range r.players {
		if m != nil {
			info.Count++
		}
	}
	return info
}
func (r *Room) CheckPassword(password string) bool {
	return len(r.password) == 0 || bcrypt.CompareHashAndPassword(r.password, []byte(password)) == nil
}
func (r *Room) IsClosed() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.closed }

// A signed identity is required by the transport before this call. A token is
// bound to that identity and cannot be used by a different player.
func (r *Room) Join(p Profile, token string, sink EventSink) (Snapshot, string, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return Snapshot{}, "", "", errors.New("房间已经关闭")
	}
	if !validNickname(p.Nickname) || p.Character < 0 || p.Character >= CharacterCount {
		return Snapshot{}, "", "", errors.New("玩家资料无效")
	}
	for _, m := range r.players {
		if m != nil && m.view.ID == p.ID {
			if m.left {
				return Snapshot{}, "", "", errors.New("已离开本局，请等本局结束后重新加入")
			}
			if token != "" && token != m.token {
				return Snapshot{}, "", "", errors.New("重连凭据已失效")
			}
			if token == "" && m.view.Connected {
				return Snapshot{}, "", "", errors.New("该玩家已在房间中")
			}
			if token == "" {
				m.token = randomID()
			}
			m.epoch = randomID()
			m.sink = sink
			m.view.Connected = true
			m.disconnectedAt = 0
			m.view.Nickname = p.Nickname
			m.view.Character = p.Character
			r.changedLocked()
			return r.snapshotLocked(p.ID), m.token, m.epoch, nil
		}
	}
	if token != "" {
		return Snapshot{}, "", "", errors.New("本次房间会话已失效")
	}
	if r.engine != nil && !r.engine.Finished() {
		return Snapshot{}, "", "", errors.New("牌局进行中，请等待下一局")
	}
	for seat, m := range r.players {
		if m == nil {
			if r.engine != nil && r.engine.Finished() {
				r.engine = nil
				r.info.Phase = "waiting"
			}
			balance, existed := r.ledger[p.ID]
			if !existed {
				balance = r.info.InitialBeans
				r.ledger[p.ID] = balance
			}
			m = &member{view: PlayerView{ID: p.ID, Nickname: p.Nickname, Character: p.Character, Seat: seat, Beans: balance, Connected: true}, token: randomID(), epoch: randomID(), sink: sink, seen: map[string]bool{}}
			r.players[seat] = m
			r.votes = map[string]bool{}
			r.changedLocked()
			return r.snapshotLocked(p.ID), m.token, m.epoch, nil
		}
	}
	return Snapshot{}, "", "", errors.New("房间已满（最多 3 人）")
}

func (r *Room) HostEpoch() string { r.mu.Lock(); defer r.mu.Unlock(); return r.players[0].epoch }
func (r *Room) Snapshot(id string) (Snapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return Snapshot{}, errors.New("房间已经关闭")
	}
	if r.findLocked(id) == nil {
		return Snapshot{}, errors.New("你不在房间中")
	}
	return r.snapshotLocked(id), nil
}
func (r *Room) snapshotLocked(id string) Snapshot {
	s := Snapshot{Room: r.infoLocked(), SelfID: id, HostID: r.hostID, Players: []PlayerView{}, Revision: r.revision, ResetVotes: []string{}, Connection: "connected"}
	for _, m := range r.players {
		if m != nil {
			v := m.view
			if r.engine != nil {
				v.Trustee = r.engine.Trustee(v.Seat)
			}
			s.Players = append(s.Players, v)
			if r.votes[v.ID] {
				s.ResetVotes = append(s.ResetVotes, v.ID)
			}
		}
	}
	if m := r.findLocked(id); m != nil && r.engine != nil {
		v := r.engine.View(m.view.Seat)
		s.Game = &v
	}
	return s
}
func (r *Room) findLocked(id string) *member {
	for _, m := range r.players {
		if m != nil && m.view.ID == id {
			return m
		}
	}
	return nil
}
func (r *Room) changedLocked() { r.revision++; r.emitStateLocked() }
func (r *Room) emitStateLocked() {
	for _, m := range r.players {
		if m != nil && m.view.Connected && m.sink != nil {
			m.sink("room.state", r.snapshotLocked(m.view.ID))
		}
	}
}
func (r *Room) emitLocked(method string, value any) {
	for _, m := range r.players {
		if m != nil && m.view.Connected && m.sink != nil {
			m.sink(method, value)
		}
	}
}

func (r *Room) Disconnect(id, epoch string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.findLocked(id)
	if m == nil || m.epoch != epoch || r.closed {
		return
	}
	m.view.Connected = false
	m.view.Ready = false
	m.disconnectedAt = time.Now().UnixMilli()
	m.sink = nil
	delete(r.votes, id)
	if r.engine != nil && !r.engine.Finished() {
		_ = r.engine.Apply(m.view.Seat, game.Action{Type: "trustee", Enabled: true}, time.Now().UnixMilli())
	}
	r.changedLocked()
}

func (r *Room) Call(id, epoch, method string, raw json.RawMessage) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, errors.New("房间已经关闭")
	}
	m := r.findLocked(id)
	if m == nil || m.epoch != epoch || m.left || !m.view.Connected {
		return nil, errors.New("玩家会话已失效")
	}
	now := time.Now().UnixMilli()
	switch method {
	case "profile.update":
		var p Profile
		if err := decode(raw, &p); err != nil {
			return nil, err
		}
		if !validNickname(p.Nickname) || p.Character < 0 || p.Character >= CharacterCount {
			return nil, errors.New("玩家资料无效")
		}
		m.view.Nickname = p.Nickname
		m.view.Character = p.Character
		r.changedLocked()
		return r.snapshotLocked(id), nil
	case "room.snapshot":
		return r.snapshotLocked(id), nil
	case "room.ready":
		var p struct {
			Ready bool `json:"ready"`
		}
		if err := decode(raw, &p); err != nil {
			return nil, err
		}
		if r.engine != nil && !r.engine.Finished() {
			return nil, errors.New("本局已经开始")
		}
		if p.Ready && m.view.Beans <= 0 {
			return nil, errors.New("欢乐豆不足，请发起重置投票")
		}
		m.view.Ready = p.Ready
		r.votes = map[string]bool{}
		ready := true
		for _, player := range r.players {
			if player == nil || !player.view.Ready || !player.view.Connected || player.view.Beans <= 0 {
				ready = false
			}
		}
		if ready {
			r.engine = game.New(randomID(), r.round%3, now)
			r.round++
			r.settled = false
			r.info.Phase = "bidding"
			for _, player := range r.players {
				player.view.Ready = false
			}
		}
		r.changedLocked()
		return r.snapshotLocked(id), nil
	case "room.reset":
		if r.engine != nil && !r.engine.Finished() {
			return nil, errors.New("牌局进行中不能重置欢乐豆")
		}
		var p struct {
			Agree bool `json:"agree"`
		}
		if err := decode(raw, &p); err != nil {
			return nil, err
		}
		bankrupt := false
		for _, player := range r.players {
			if player != nil && player.view.Beans == 0 {
				bankrupt = true
				break
			}
		}
		if !bankrupt {
			return nil, errors.New("无人输光，暂不可重置欢乐豆")
		}
		if p.Agree {
			r.votes[id] = true
		} else {
			r.votes = map[string]bool{}
		}
		all := p.Agree
		for _, player := range r.players {
			if player == nil || !player.view.Connected || !r.votes[player.view.ID] {
				all = false
			}
		}
		if all {
			for playerID := range r.ledger {
				r.ledger[playerID] = r.info.InitialBeans
			}
			for _, player := range r.players {
				if player != nil {
					player.view.Beans = r.info.InitialBeans
					player.view.Ready = false
				}
			}
			r.engine = nil
			r.info.Phase = "waiting"
			r.votes = map[string]bool{}
		}
		r.changedLocked()
		return r.snapshotLocked(id), nil
	case "room.leave":
		if id == r.hostID {
			r.closeLocked("房主已关闭房间")
			return map[string]bool{"ok": true}, nil
		}
		m.token = ""
		m.epoch = randomID()
		m.view.Connected = false
		m.view.Ready = false
		m.sink = nil
		m.left = true
		delete(r.votes, id)
		if r.engine == nil || r.engine.Finished() {
			r.players[m.view.Seat] = nil
		} else {
			_ = r.engine.Apply(m.view.Seat, game.Action{Type: "trustee", Enabled: true}, now)
		}
		r.changedLocked()
		return map[string]bool{"ok": true}, nil
	case "game.action":
		var p ActionParams
		if err := decode(raw, &p); err != nil {
			return nil, err
		}
		if !validActionID(p.ActionID) {
			return nil, errors.New("动作编号无效")
		}
		key := "game:" + p.ActionID
		if m.seen[key] {
			return r.snapshotLocked(id), nil
		}
		if r.engine == nil {
			return nil, errors.New("请先准备开始游戏")
		}
		view := r.engine.View(m.view.Seat)
		if p.ExpectedRoundID != "" && p.ExpectedRoundID != view.RoundID {
			return nil, errors.New("这局已经结束，请使用当前牌局操作")
		}
		if p.ExpectedRevision != nil && *p.ExpectedRevision != r.revision {
			// Doubling is simultaneous: another player's choice must not discard
			// this player's independent decision. A round token prevents a delayed
			// choice from being applied to a later round. Turn-based moves stay strict.
			independentDouble := p.Type == "double" && *p.ExpectedRevision < r.revision &&
				p.ExpectedRoundID == view.RoundID && view.Phase == "doubling" &&
				view.Doubles[m.view.Seat] < 0
			if !independentDouble {
				return nil, errors.New("牌桌已更新，请刷新后重试")
			}
		}
		if err := r.engine.Apply(m.view.Seat, p.Action, now); err != nil {
			return nil, err
		}
		m.remember(key)
		r.updateEngineLocked()
		r.changedLocked()
		return r.snapshotLocked(id), nil
	case "game.hint":
		if r.engine == nil {
			return map[string]any{"candidates": [][]int{}}, nil
		}
		return map[string]any{"candidates": r.engine.Hint(m.view.Seat)}, nil
	case "social.send":
		var p SocialParams
		if err := decode(raw, &p); err != nil {
			return nil, err
		}
		if !validActionID(p.ActionID) {
			return nil, errors.New("动作编号无效")
		}
		key := "social:" + p.ActionID
		if m.seen[key] {
			return map[string]bool{"ok": true}, nil
		}
		if r.findLocked(p.TargetID) == nil {
			return nil, errors.New("玩家已离开")
		}
		allowed := map[string]bool{"tea": true, "flower": true, "tomato": true, "egg": true, "like": true, "phrase": true}
		if !allowed[p.Kind] {
			return nil, errors.New("互动类型不存在")
		}
		if now-m.lastSocial < 3000 {
			return nil, errors.New("互动太频繁，请稍后再试")
		}
		phrase := ""
		if p.Kind == "phrase" {
			if !allowedPhrase(p.Phrase) {
				return nil, errors.New("请选择预设快捷语")
			}
			phrase = p.Phrase
		}
		m.lastSocial = now
		m.remember(key)
		r.emitLocked("social.event", SocialEvent{ID: p.ActionID, RoomID: r.info.ID, FromID: id, TargetID: p.TargetID, Kind: p.Kind, Phrase: phrase, At: now})
		return map[string]bool{"ok": true}, nil
	default:
		return nil, fmt.Errorf("未知房间操作: %s", method)
	}
}

func allowedPhrase(p string) bool {
	switch p {
	case "快点吧，花儿都谢了！", "这牌打得真漂亮！", "快点吧，我等到花儿都谢了", "你的牌打得也太好了", "不要走，决战到天亮", "和你合作真是太愉快了", "你好，很高兴见到各位", "快点吧，我等得花儿都谢了！", "你的牌打得也太好了！", "和你合作真是太愉快了！", "不要走，决战到天亮！":
		return true
	}
	return false
}
func validActionID(v string) bool { return len(v) > 0 && len(v) <= 96 && strings.TrimSpace(v) == v }
func (m *member) remember(id string) {
	m.seen[id] = true
	m.order = append(m.order, id)
	if len(m.order) > 256 {
		delete(m.seen, m.order[0])
		m.order = m.order[1:]
	}
}
func (r *Room) Tick(now int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	changed := false
	if r.engine != nil && r.engine.Tick(now) {
		r.updateEngineLocked()
		changed = true
	}
	if r.engine == nil || r.engine.Finished() {
		for i, m := range r.players {
			if m != nil && !m.view.IsHost && !m.view.Connected && m.disconnectedAt > 0 && now-m.disconnectedAt > 60000 {
				delete(r.votes, m.view.ID)
				r.players[i] = nil
				changed = true
			}
		}
	}
	if changed {
		r.changedLocked()
	}
}
func (r *Room) updateEngineLocked() {
	if r.engine == nil {
		return
	}
	r.info.Phase = string(r.engine.View(0).Phase)
	if !r.engine.Finished() || r.settled {
		return
	}
	var balances [3]int64
	for i, m := range r.players {
		if m != nil {
			balances[i] = m.view.Beans
		}
	}
	s := r.engine.Settle(balances)
	r.settled = true
	for i, m := range r.players {
		if m != nil {
			if i < len(s.Balances) {
				m.view.Beans = s.Balances[i]
				r.ledger[m.view.ID] = m.view.Beans
			}
			m.view.Ready = false
			if m.left {
				r.players[i] = nil
			}
		}
	}
	r.votes = map[string]bool{}
}
func (r *Room) Close(reason string) { r.mu.Lock(); defer r.mu.Unlock(); r.closeLocked(reason) }
func (r *Room) closeLocked(reason string) {
	if r.closed {
		return
	}
	r.closed = true
	r.emitLocked("room.closed", map[string]string{"reason": reason})
	for _, m := range r.players {
		if m != nil {
			m.token = ""
			m.epoch = randomID()
		}
	}
}
func decode(raw json.RawMessage, out any) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return errors.New("请求参数格式错误")
	}
	return nil
}
