package app

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"time"
)

type queuedEvent struct {
	method string
	params any
	scope  string
}
type App struct {
	mu        sync.Mutex
	profile   *ProfileStore
	music     *MusicStore
	room      *Room
	server    *RoomServer
	discovery *Discovery
	remote    *Remote
	known     map[string]discoveredRoom
	sink      EventSink
	events    chan queuedEvent
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	closed    bool
	scope     string
}

func New(dataDir string, sink EventSink) (*App, error) {
	profile, err := OpenProfile(dataDir)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	if sink == nil {
		sink = func(string, any) {}
	}
	a := &App{profile: profile, music: NewMusicStore(dataDir), sink: sink, events: make(chan queuedEvent, 128), ctx: ctx, cancel: cancel, known: map[string]discoveredRoom{}}
	a.wg.Add(2)
	go a.eventLoop()
	go a.tickLoop()
	return a, nil
}
func (a *App) emit(method string, params any) {
	select {
	case a.events <- queuedEvent{method: method, params: params}:
	default: /* snapshots are recovered by polling; social events are ephemeral */
	}
}
func (a *App) scopedSink(scope string) EventSink {
	return func(method string, params any) {
		select {
		case a.events <- queuedEvent{method: method, params: params, scope: scope}:
		default:
		}
	}
}
func (a *App) eventLoop() {
	defer a.wg.Done()
	for {
		select {
		case <-a.ctx.Done():
			return
		case e := <-a.events:
			var closedRemote *Remote
			if e.scope != "" {
				a.mu.Lock()
				current := a.scope
				if e.scope == current && e.method == "room.closed" && a.remote != nil {
					closedRemote = a.remote
					a.remote = nil
					a.scope = ""
				}
				a.mu.Unlock()
				if e.scope != current {
					continue
				}
			}
			a.sink(e.method, e.params)
			if closedRemote != nil {
				closedRemote.Close()
			}
		}
	}
}
func (a *App) tickLoop() {
	defer a.wg.Done()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case now := <-ticker.C:
			a.mu.Lock()
			room := a.room
			a.mu.Unlock()
			if room != nil {
				room.Tick(now.UnixMilli())
			}
		}
	}
}

func (a *App) Call(method string, params json.RawMessage) (any, error) {
	switch method {
	case "music.get":
		return a.music.Get()
	case "music.set":
		var p MusicInput
		if err := decode(params, &p); err != nil {
			return nil, err
		}
		return a.music.Set(p)
	case "profile.get":
		return a.profile.Get(), nil
	case "profile.save":
		var p Profile
		if err := decode(params, &p); err != nil {
			return nil, err
		}
		saved, err := a.profile.Save(p)
		if err != nil {
			return nil, err
		}
		a.mu.Lock()
		room, remote := a.room, a.remote
		a.mu.Unlock()
		if room != nil {
			_, _ = room.Call(saved.ID, room.HostEpoch(), "profile.update", jsonValue(saved))
		}
		if remote != nil {
			_, _ = remote.Call("profile.update", jsonValue(saved))
		}
		return saved, nil
	case "lobby.scan":
		var p struct {
			Query string `json:"query"`
		}
		if err := decode(params, &p); err != nil {
			return nil, err
		}
		a.mu.Lock()
		if a.closed {
			a.mu.Unlock()
			return nil, errors.New("插件已关闭")
		}
		room := a.room
		a.mu.Unlock()
		found, err := ScanRooms(a.ctx)
		if err != nil {
			log.Printf("LAN discovery unavailable: %v", err)
		}
		if room != nil && !room.IsClosed() {
			found = append(found, discoveredRoom{Info: room.Info(), HostID: room.hostID})
		}
		rooms := []RoomInfo{}
		seen := map[string]bool{}
		query := strings.ToLower(strings.TrimSpace(p.Query))
		a.mu.Lock()
		a.known = map[string]discoveredRoom{}
		for _, item := range found {
			a.known[item.Info.ID] = item
			if !seen[item.Info.ID] && (query == "" || strings.Contains(strings.ToLower(item.Info.Name), query) || strings.Contains(item.Info.ID, query)) {
				rooms = append(rooms, item.Info)
				seen[item.Info.ID] = true
			}
		}
		a.mu.Unlock()
		addresses := []string{}
		for _, v := range localAddresses(1) {
			if host, _, e := splitAddress(v); e == nil {
				addresses = append(addresses, host)
			}
		}
		return map[string]any{"rooms": rooms, "addresses": addresses}, nil
	case "room.create":
		var p CreateParams
		if err := decode(params, &p); err != nil {
			return nil, err
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.closed {
			return nil, errors.New("插件已关闭")
		}
		if a.room != nil || a.remote != nil {
			return nil, errors.New("请先离开当前房间")
		}
		scope := randomID()
		room, err := NewRoom(a.profile.Get(), p, a.scopedSink(scope))
		if err != nil {
			return nil, err
		}
		server, err := StartRoomServer(room, a.profile.Key())
		if err != nil {
			return nil, err
		}
		discovery, discoveryErr := StartDiscovery(room, server.Port(), a.profile.Get().ID)
		if discoveryErr != nil {
			log.Printf("LAN advertisement unavailable (manual address remains available): %v", discoveryErr)
		}
		a.scope = scope
		a.room = room
		a.server = server
		a.discovery = discovery
		snapshot, err := room.Snapshot(a.profile.Get().ID)
		if err == nil {
			a.scopedSink(scope)("room.state", snapshot)
		}
		return snapshot, err
	case "room.join":
		var p JoinParams
		if err := decode(params, &p); err != nil {
			return nil, err
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.closed {
			return nil, errors.New("插件已关闭")
		}
		if a.room != nil || a.remote != nil {
			return nil, errors.New("请先离开当前房间")
		}
		expected := ""
		var addresses []string
		if found, ok := a.known[p.RoomID]; ok {
			expected = found.HostID
			addresses = found.Info.Addresses
			if p.Address == "" {
				p.Address = found.Info.Address
			}
		}
		scope := randomID()
		remote, err := DialRoomCandidates(a.profile, p, expected, addresses, a.scopedSink(scope))
		if err != nil {
			return nil, err
		}
		a.scope = scope
		a.remote = remote
		snapshot := remote.Snapshot()
		a.scopedSink(scope)("room.state", snapshot)
		return snapshot, nil
	case "room.leave":
		return a.leave()
	default:
		a.mu.Lock()
		room, remote := a.room, a.remote
		a.mu.Unlock()
		if room == nil && remote == nil {
			if method == "room.snapshot" {
				return nil, nil
			}
			return nil, errors.New("请先创建或加入房间")
		}
		if room != nil {
			return room.Call(a.profile.Get().ID, room.HostEpoch(), method, params)
		}
		if method == "room.snapshot" {
			snapshot := remote.Snapshot()
			if snapshot.Connection != "connected" {
				return snapshot, nil
			}
			raw, err := remote.Call(method, params)
			if err != nil {
				return remote.Snapshot(), nil
			}
			var fresh Snapshot
			if err = json.Unmarshal(raw, &fresh); err != nil {
				return nil, err
			}
			return fresh, nil
		}
		raw, err := remote.Call(method, params)
		if err != nil {
			return nil, err
		}
		return raw, nil
	}
}
func splitAddress(v string) (string, string, error) {
	i := strings.LastIndex(v, ":")
	if i < 0 {
		return "", "", errors.New("invalid address")
	}
	return v[:i], v[i+1:], nil
}

func (a *App) leave() (any, error) {
	a.mu.Lock()
	room, remote, server, discovery := a.room, a.remote, a.server, a.discovery
	a.room = nil
	a.remote = nil
	a.server = nil
	a.discovery = nil
	a.scope = ""
	a.mu.Unlock()
	if room != nil {
		room.Close("房主已关闭房间")
		time.Sleep(30 * time.Millisecond)
	}
	if remote != nil {
		_, _ = remote.Call("room.leave", nil)
		remote.Close()
	}
	if discovery != nil {
		discovery.Close()
	}
	if server != nil {
		server.Close()
	}
	return map[string]bool{"ok": true}, nil
}
func (a *App) Close() {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	a.closed = true
	a.mu.Unlock()
	_, _ = a.leave()
	a.cancel()
	a.wg.Wait()
}
