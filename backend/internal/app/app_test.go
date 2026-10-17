package app

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grandcat/zeroconf"
)

func testProfile(id string) Profile {
	return Profile{ID: id, Nickname: "牌友" + id, Character: 0, Music: .3, Sound: .5, Voice: .5}
}
func noopSink(string, any) {}
func contextForTest(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}
func mustCall(t *testing.T, a *App, method string, value any) any {
	t.Helper()
	result, err := a.Call(method, jsonValue(value))
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	return result
}
func snapshotOf(t *testing.T, value any) Snapshot {
	t.Helper()
	var snapshot Snapshot
	b := jsonValue(value)
	if err := json.Unmarshal(b, &snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}
func waitFor(t *testing.T, timeout time.Duration, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition did not become true before timeout")
}

func TestPersistentIdentityAndPreferences(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenProfile(dir)
	if err != nil {
		t.Fatal(err)
	}
	original := s.Get()
	key := s.Key()
	p := original
	p.ID = "forged"
	p.Nickname = "测试牌友"
	p.Character = 2
	p.Music = .8
	saved, err := s.Save(p)
	if err != nil {
		t.Fatal(err)
	}
	if saved.ID != original.ID {
		t.Fatal("caller replaced authenticated identity")
	}
	again, err := OpenProfile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if string(key) != string(again.Key()) || again.Get().Nickname != p.Nickname {
		t.Fatal("identity/preferences did not persist")
	}
	p.Music = 2
	if _, err = s.Save(p); err == nil {
		t.Fatal("out-of-range volume accepted")
	}
	if err = s.CheckPin("127.0.0.1:1234", "host-a", true); err != nil {
		t.Fatal(err)
	}
	if err = s.CheckPin("127.0.0.1:1234", "host-b", false); err == nil {
		t.Fatal("changed host identity accepted")
	}
}

func TestRoomPersonalizedCardsRevisionsAndDeduplication(t *testing.T) {
	r, err := NewRoom(testProfile("host"), CreateParams{Name: "测试", InitialBeans: 10000}, noopSink)
	if err != nil {
		t.Fatal(err)
	}
	_, guestToken, guestEpoch, err := r.Join(testProfile("guest"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	_, _, thirdEpoch, err := r.Join(testProfile("third"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{"host", "guest", "third"}
	epochs := []string{r.HostEpoch(), guestEpoch, thirdEpoch}
	for i, id := range ids {
		if _, err = r.Call(id, epochs[i], "room.ready", jsonValue(map[string]bool{"ready": true})); err != nil {
			t.Fatal(err)
		}
	}
	cards := map[int]bool{}
	for _, id := range ids {
		view, err := r.Snapshot(id)
		if err != nil {
			t.Fatal(err)
		}
		if view.Game == nil || len(view.Game.Hand) != 17 || len(view.Game.Bottom) != 0 {
			t.Fatal("initial private snapshot malformed")
		}
		for _, card := range view.Game.Hand {
			if cards[card] {
				t.Fatal("private hands overlap")
			}
			cards[card] = true
		}
	}
	before, _ := r.Snapshot("host")
	bad := before.Revision - 1
	if _, err = r.Call("host", epochs[0], "game.action", jsonValue(map[string]any{"actionId": "stale", "expectedRevision": bad, "type": "bid", "score": 3})); err == nil {
		t.Fatal("stale action accepted")
	}
	params := jsonValue(map[string]any{"actionId": "bid-once", "expectedRevision": before.Revision, "type": "bid", "score": 3})
	first, err := r.Call("host", epochs[0], "game.action", params)
	if err != nil {
		t.Fatal(err)
	}
	second, err := r.Call("host", epochs[0], "game.action", params)
	if err != nil {
		t.Fatal(err)
	}
	if snapshotOf(t, first).Revision != snapshotOf(t, second).Revision {
		t.Fatal("duplicate action mutated room")
	}
	r.Disconnect("guest", guestEpoch)
	_, _, replacement, err := r.Join(testProfile("guest"), guestToken, noopSink)
	if err != nil {
		t.Fatal(err)
	}
	if replacement == guestEpoch {
		t.Fatal("reconnect reused generation")
	}
	if _, err = r.Call("guest", guestEpoch, "room.snapshot", nil); err == nil {
		t.Fatal("old connection still authorized")
	}
	r.Disconnect("guest", guestEpoch)
	view, _ := r.Snapshot("guest")
	if !view.Players[1].Connected {
		t.Fatal("old socket disconnect affected replacement")
	}
}

func TestResetVotesAndSocialCooldown(t *testing.T) {
	events := []SocialEvent{}
	sink := func(method string, value any) {
		if method == "social.event" {
			events = append(events, value.(SocialEvent))
		}
	}
	r, err := NewRoom(testProfile("host"), CreateParams{InitialBeans: 3000}, sink)
	if err != nil {
		t.Fatal(err)
	}
	_, _, epoch, err := r.Join(testProfile("guest"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	_, _, thirdEpoch, err := r.Join(testProfile("third"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	r.players[0].view.Beans = 0
	r.players[1].view.Beans = 6000
	r.players[2].view.Beans = 3000
	r.ledger["host"] = 0
	r.ledger["guest"] = 6000
	r.ledger["third"] = 3000
	if _, err = r.Call("host", r.HostEpoch(), "room.reset", jsonValue(map[string]bool{"agree": true})); err != nil {
		t.Fatal(err)
	}
	view, _ := r.Snapshot("host")
	if view.Players[0].Beans != 0 || len(view.ResetVotes) != 1 {
		t.Fatal("reset occurred before unanimous vote")
	}
	if _, err = r.Call("guest", epoch, "room.reset", jsonValue(map[string]bool{"agree": true})); err != nil {
		t.Fatal(err)
	}
	view, _ = r.Snapshot("host")
	if view.Players[0].Beans != 0 || len(view.ResetVotes) != 2 {
		t.Fatal("reset occurred before the third seat voted")
	}
	if _, err = r.Call("third", thirdEpoch, "room.reset", jsonValue(map[string]bool{"agree": true})); err != nil {
		t.Fatal(err)
	}
	view, _ = r.Snapshot("host")
	if view.Players[0].Beans != 3000 || view.Players[1].Beans != 3000 || view.Players[2].Beans != 3000 || len(view.ResetVotes) != 0 {
		t.Fatal("reset failed")
	}
	params := jsonValue(SocialParams{ActionID: "tea-once", TargetID: "guest", Kind: "tea"})
	if _, err = r.Call("host", r.HostEpoch(), "social.send", params); err != nil {
		t.Fatal(err)
	}
	if _, err = r.Call("host", r.HostEpoch(), "social.send", params); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatal("social replay was broadcast twice")
	}
	if _, err = r.Call("host", r.HostEpoch(), "social.send", jsonValue(SocialParams{ActionID: "too-fast", TargetID: "guest", Kind: "flower"})); err == nil {
		t.Fatal("cooldown bypassed")
	}
	r.players[0].lastSocial = time.Now().UnixMilli() - 2501
	if _, err = r.Call("host", r.HostEpoch(), "social.send", jsonValue(SocialParams{ActionID: "before-three-seconds", TargetID: "guest", Kind: "flower"})); err == nil {
		t.Fatal("old 2.5-second cooldown still active")
	}
	r.players[0].lastSocial = time.Now().UnixMilli() - 3001
	if _, err = r.Call("host", r.HostEpoch(), "social.send", jsonValue(SocialParams{ActionID: "after-three-seconds", TargetID: "guest", Kind: "flower"})); err != nil {
		t.Fatal("three-second cooldown did not expire")
	}
}

func TestRoomLedgerSurvivesLeaveAndRejectsOldToken(t *testing.T) {
	r, err := NewRoom(testProfile("host"), CreateParams{InitialBeans: 10000}, noopSink)
	if err != nil {
		t.Fatal(err)
	}
	_, token, epoch, err := r.Join(testProfile("guest"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	r.players[1].view.Beans = 0
	r.ledger["guest"] = 0
	if _, err = r.Call("guest", epoch, "room.leave", nil); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = r.Join(testProfile("guest"), token, noopSink); err == nil {
		t.Fatal("explicitly left session token was reused")
	}
	view, _, newEpoch, err := r.Join(testProfile("guest"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	if view.Players[1].Beans != 0 {
		t.Fatal("leave/rejoin minted new beans")
	}
	if _, err = r.Call("guest", newEpoch, "room.ready", jsonValue(map[string]bool{"ready": true})); err == nil {
		t.Fatal("bankrupt player could ready")
	}
}

func TestRealTLSThreePlayersPasswordReconnectAndHostClose(t *testing.T) {
	var eventsMu sync.Mutex
	closed := false
	host, err := New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	guest, err := New(t.TempDir(), func(method string, _ any) {
		if method == "room.closed" {
			eventsMu.Lock()
			closed = true
			eventsMu.Unlock()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer guest.Close()
	third, err := New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	hostView := snapshotOf(t, mustCall(t, host, "room.create", CreateParams{Name: "TLS测试房", Password: "test-secret", InitialBeans: 10000}))
	address := host.server.Address()
	if _, err = guest.Call("room.join", jsonValue(JoinParams{Address: address, RoomID: hostView.Room.ID, Password: "wrong"})); err == nil || !strings.Contains(err.Error(), "密码") {
		t.Fatalf("incorrect password accepted: %v", err)
	}
	guestView := snapshotOf(t, mustCall(t, guest, "room.join", JoinParams{Address: address, RoomID: hostView.Room.ID, Password: "test-secret"}))
	mustCall(t, third, "room.join", JoinParams{Address: address, RoomID: hostView.Room.ID, Password: "test-secret"})
	if guestView.SelfID == hostView.SelfID {
		t.Fatal("players shared an identity")
	}
	for _, a := range []*App{host, guest, third} {
		mustCall(t, a, "room.ready", map[string]bool{"ready": true})
	}
	for _, a := range []*App{host, guest, third} {
		view := snapshotOf(t, mustCall(t, a, "room.snapshot", nil))
		if view.Room.Count != 3 || view.Game == nil || len(view.Game.Hand) != 17 {
			t.Fatal("three-player start failed")
		}
	}
	guest.remote.mu.Lock()
	previous := guest.remote.conn
	previous.Close()
	guest.remote.mu.Unlock()
	waitFor(t, 8*time.Second, func() bool {
		guest.remote.mu.Lock()
		defer guest.remote.mu.Unlock()
		return guest.remote.conn != nil && guest.remote.conn != previous && guest.remote.status == "connected"
	})
	reconnected := snapshotOf(t, mustCall(t, guest, "room.snapshot", nil))
	if reconnected.SelfID != guestView.SelfID || reconnected.Room.ID != hostView.Room.ID {
		t.Fatal("reconnect lost identity or room")
	}
	// A captured reconnect token is useless without its matching signing key.
	other, err := OpenProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	guest.remote.mu.Lock()
	token := guest.remote.token
	guest.remote.mu.Unlock()
	fake := &Remote{profile: other, address: address, roomID: hostView.Room.ID, hostID: hostView.HostID, params: JoinParams{Address: address}, ctx: contextForTest(t)}
	if conn, _, _, _, _, err := fake.connect(token); err == nil {
		conn.Close()
		t.Fatal("token usable by another identity")
	}
	mustCall(t, host, "room.leave", nil)
	waitFor(t, 3*time.Second, func() bool { eventsMu.Lock(); defer eventsMu.Unlock(); return closed })
	if result := mustCall(t, guest, "room.snapshot", nil); result != nil {
		t.Fatal("explicit host closure retained a stale room session")
	}
	newRoom := snapshotOf(t, mustCall(t, guest, "room.create", CreateParams{Name: "关房后重新建房", InitialBeans: 5000}))
	joinedAgain := snapshotOf(t, mustCall(t, host, "room.join", JoinParams{Address: guest.server.Address(), RoomID: newRoom.Room.ID}))
	if joinedAgain.Room.ID != newRoom.Room.ID {
		t.Fatal("closed session prevented a new room")
	}
}

func TestDiscoveryRecordValidation(t *testing.T) {
	entry := &zeroconf.ServiceEntry{ServiceRecord: zeroconf.ServiceRecord{Instance: "room"}, Port: 43210, AddrIPv4: []net.IP{net.ParseIP("192.168.1.10")}, Text: discoveryTXT(RoomInfo{ID: strings.Repeat("a", 32), Name: "田园房间", Count: 2, InitialBeans: 10000, Locked: true, Phase: "waiting"}, strings.Repeat("b", 32))}
	found, ok := parseDiscovery(entry)
	if !ok || found.Info.Name != "田园房间" || !found.Info.Locked || found.Info.Address != "192.168.1.10:43210" {
		t.Fatal("valid mDNS room not parsed")
	}
	entry.Text[0] = "v=999"
	if _, ok = parseDiscovery(entry); ok {
		t.Fatal("incompatible protocol advertised")
	}
}

func TestRealMDNSRoomDiscovery(t *testing.T) {
	host, err := New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	view := snapshotOf(t, mustCall(t, host, "room.create", CreateParams{Name: "mDNS发现验收", InitialBeans: 10000}))
	if host.discovery.server == nil {
		t.Skip("OS multicast unavailable; manual TLS address integration is covered separately")
	}
	guest, err := New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer guest.Close()
	mustCall(t, guest, "room.join", JoinParams{Address: host.server.Address(), RoomID: view.Room.ID})
	for attempt := 0; attempt < 3; attempt++ {
		rooms, err := ScanRooms(contextForTest(t))
		if err != nil {
			t.Skipf("OS multicast resolver unavailable: %v", err)
		}
		for _, room := range rooms {
			if room.Info.ID == view.Room.ID {
				if room.HostID != view.HostID || room.Info.Count != 2 {
					t.Fatal("mDNS identity/count mismatch")
				}
				return
			}
		}
	}
	t.Skip("LAN multicast does not loop back on this host; parser and direct TLS joining passed independently")
}

func TestRealPrivateNICFallback(t *testing.T) {
	host, err := New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	view := snapshotOf(t, mustCall(t, host, "room.create", CreateParams{Name: "多网卡回退", InitialBeans: 10000}))
	privateAddresses := []string{}
	for _, address := range view.Room.Addresses {
		ip, _, _ := net.SplitHostPort(address)
		parsed := net.ParseIP(ip)
		if parsed != nil && parsed.IsPrivate() {
			privateAddresses = append(privateAddresses, address)
		}
	}
	if len(privateAddresses) == 0 {
		t.Skip("No private NIC address on this host")
	}
	// An immediately refusing address stands in for an unreachable advertised
	// VPN route; each real private NIC must work as the fallback over TLS.
	for _, address := range privateAddresses {
		t.Run(address, func(t *testing.T) {
			store, err := OpenProfile(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			remote, err := DialRoomCandidates(store, JoinParams{Address: "127.0.0.1:1", RoomID: view.Room.ID}, view.HostID, []string{"127.0.0.1:1", address}, noopSink)
			if err != nil {
				t.Fatalf("reachable LAN candidate was not selected: %v", err)
			}
			if remote.address != address {
				t.Fatal("wrong interface selected")
			}
			if _, err = remote.Call("room.leave", nil); err != nil {
				t.Fatal(err)
			}
			remote.Close()
		})
	}
}
