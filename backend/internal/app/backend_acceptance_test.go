package app

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"testing"
)

// A unanimous reset is only intended to recover a room after a player is
// bankrupt. Without this guard, players can refill beans after any loss.
func TestAcceptanceResetRequiresBankruptcyAndUnanimousVote(t *testing.T) {
	r, err := NewRoom(testProfile("host"), CreateParams{InitialBeans: 10000}, noopSink)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"guest", "third"} {
		if _, _, _, err := r.Join(testProfile(id), "", noopSink); err != nil {
			t.Fatal(err)
		}
	}

	// Keep the ledger internally consistent while representing ordinary losses.
	for seat, balance := range []int64{6000, 9000, 15000} {
		r.players[seat].view.Beans = balance
		r.ledger[r.players[seat].view.ID] = balance
	}
	for seat, player := range r.players {
		if _, err := r.Call(player.view.ID, player.epoch, "room.reset", jsonValue(map[string]bool{"agree": true})); err == nil {
			t.Fatalf("reset vote %d was accepted before bankruptcy", seat)
		}
	}
	view, err := r.Snapshot("host")
	if err != nil {
		t.Fatal(err)
	}
	for seat, expected := range []int64{6000, 9000, 15000} {
		if view.Players[seat].Beans != expected {
			t.Fatalf("non-bankrupt unanimous vote minted beans: got %d at seat %d", view.Players[seat].Beans, seat)
		}
	}
	if len(view.ResetVotes) != 0 {
		t.Fatalf("pre-bankruptcy calls must not accumulate votes, got %v", view.ResetVotes)
	}

	// After bankruptcy every current player may vote; a no vote clears prior
	// votes, and unanimity is required to restore the initial balances.
	r.players[2].view.Beans = 0
	r.ledger["third"] = 0
	for seat := range 2 {
		player := r.players[seat]
		if _, err = r.Call(player.view.ID, player.epoch, "room.reset", jsonValue(map[string]bool{"agree": true})); err != nil {
			t.Fatalf("eligible reset vote %d: %v", seat, err)
		}
	}
	if _, err = r.Call("guest", r.players[1].epoch, "room.reset", jsonValue(map[string]bool{"agree": false})); err != nil {
		t.Fatal(err)
	}
	if r.players[1].view.Beans != 9000 || len(r.votes) != 0 {
		t.Fatal("no vote changed balances or failed to clear prior votes")
	}
	for seat, player := range r.players {
		if _, err = r.Call(player.view.ID, player.epoch, "room.reset", jsonValue(map[string]bool{"agree": true})); err != nil {
			t.Fatalf("eligible unanimous reset vote %d: %v", seat, err)
		}
		if seat < 2 && r.players[0].view.Beans != 6000 {
			t.Fatal("reset occurred before the final current player voted")
		}
	}
	view, err = r.Snapshot("host")
	if err != nil {
		t.Fatal(err)
	}
	for seat, player := range view.Players {
		if player.Beans != 10000 {
			t.Fatalf("bankruptcy reset did not restore seat %d: %d", seat, player.Beans)
		}
	}
}

func TestAcceptanceResetWaitsForThreeOccupiedConnectedSeats(t *testing.T) {
	r, err := NewRoom(testProfile("host"), CreateParams{InitialBeans: 1000}, noopSink)
	if err != nil {
		t.Fatal(err)
	}
	_, _, guestEpoch, err := r.Join(testProfile("guest"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	r.players[0].view.Beans = 0
	r.players[1].view.Beans = 2000
	r.ledger["host"] = 0
	r.ledger["guest"] = 2000
	for _, vote := range []struct{ id, epoch string }{{"host", r.HostEpoch()}, {"guest", guestEpoch}} {
		if _, err = r.Call(vote.id, vote.epoch, "room.reset", jsonValue(map[string]bool{"agree": true})); err != nil {
			t.Fatal(err)
		}
	}
	if r.players[0].view.Beans != 0 || len(r.votes) != 2 {
		t.Fatal("two-player unanimous vote reset an empty third seat")
	}

	_, thirdToken, thirdEpoch, err := r.Join(testProfile("third"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	// Filling the empty seat starts a fresh vote. An offline third seat also
	// cannot be silently omitted from the unanimity requirement.
	if len(r.votes) != 0 {
		t.Fatal("joining player inherited votes from the two-player room")
	}
	r.Disconnect("third", thirdEpoch)
	for _, vote := range []struct{ id, epoch string }{{"host", r.HostEpoch()}, {"guest", guestEpoch}} {
		if _, err = r.Call(vote.id, vote.epoch, "room.reset", jsonValue(map[string]bool{"agree": true})); err != nil {
			t.Fatal(err)
		}
	}
	if r.players[0].view.Beans != 0 || len(r.votes) != 2 {
		t.Fatal("two online players reset while the third seat was disconnected")
	}

	if _, _, thirdEpoch, err = r.Join(testProfile("third"), thirdToken, noopSink); err != nil {
		t.Fatal(err)
	}
	if _, err = r.Call("third", thirdEpoch, "room.reset", jsonValue(map[string]bool{"agree": true})); err != nil {
		t.Fatal(err)
	}
	for seat, player := range r.players {
		if player.view.Beans != 1000 {
			t.Fatalf("three connected votes failed to reset seat %d: %d", seat, player.view.Beans)
		}
	}
}

func TestAcceptanceIncompatibleProtocolRejectedOverTLS(t *testing.T) {
	host, err := New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	initial := snapshotOf(t, mustCall(t, host, "room.create", CreateParams{Name: "协议验收", InitialBeans: 10000}))

	conn, err := tls.Dial("tcp", host.server.Address(), &tls.Config{InsecureSkipVerify: true}) //nolint:gosec -- intentional protocol probe against the in-process test host
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	scanner := scannerFor(conn)
	challenge, err := readMessage(scanner)
	if err != nil || challenge.Type != "challenge" {
		t.Fatalf("expected protocol challenge, got %+v: %v", challenge, err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	message := proofMessage(challenge.Nonce, challenge.RoomID)
	if err = writeMessage(conn, wireMessage{
		Type:      "auth",
		RoomID:    challenge.RoomID,
		Protocol:  Protocol + 1,
		PublicKey: publicKey,
		Signature: ed25519.Sign(privateKey, message),
		Profile:   &Profile{Nickname: "旧协议客户端", Character: 0},
	}); err != nil {
		t.Fatal(err)
	}
	response, err := readMessage(scanner)
	if err != nil {
		t.Fatal(err)
	}
	if response.ID != "auth" || response.Error == "" || response.Result != nil {
		t.Fatalf("incompatible protocol was not rejected during auth: %+v", response)
	}
	after := snapshotOf(t, mustCall(t, host, "room.snapshot", nil))
	if after.Room.ID != initial.Room.ID || after.Room.Count != 1 {
		t.Fatal("rejected incompatible client altered the room")
	}
}

func TestAcceptanceRemoteSnapshotsNeverRegressAcrossEventsAndResponses(t *testing.T) {
	events := []Snapshot{}
	r := &Remote{snapshot: Snapshot{Revision: 12, Connection: "connected"}, status: "connected"}
	r.sink = func(method string, value any) {
		if method != "room.state" {
			return
		}
		snapshot := snapshotOf(t, value)
		events = append(events, snapshot)
	}

	stale := Snapshot{Revision: 11, Connection: "connected"}
	r.receive(wireMessage{Type: "event", Method: "room.state", Params: jsonValue(stale)})
	if len(events) != 0 || r.Snapshot().Revision != 12 {
		t.Fatal("stale room.state event was forwarded or lowered the remote cache")
	}

	// This models a newer event arriving before the RPC response for the
	// action that produced an older snapshot.
	newer := Snapshot{Revision: 13, Connection: "connected"}
	r.receive(wireMessage{Type: "event", Method: "room.state", Params: jsonValue(newer)})
	olderResponse := r.reconcileSnapshot(jsonValue(Snapshot{Revision: 12, Connection: "connected"}))
	var returned Snapshot
	if err := json.Unmarshal(olderResponse, &returned); err != nil {
		t.Fatal(err)
	}
	if returned.Revision != 13 || r.Snapshot().Revision != 13 || len(events) != 1 || events[0].Revision != 13 {
		t.Fatalf("older RPC response regressed a newer event snapshot: return=%d cache=%d events=%+v", returned.Revision, r.Snapshot().Revision, events)
	}

	// Equal-revision snapshots still carry a connection transition and must be
	// forwarded so reconnect status can recover without changing state order.
	r.receive(wireMessage{Type: "event", Method: "room.state", Params: jsonValue(Snapshot{Revision: 13, Connection: "reconnecting"})})
	r.receive(wireMessage{Type: "event", Method: "room.state", Params: jsonValue(Snapshot{Revision: 13, Connection: "connected"})})
	r.mu.Lock()
	connection := r.snapshot.Connection
	r.mu.Unlock()
	if connection != "connected" || len(events) != 3 || events[2].Connection != "connected" {
		t.Fatal("same-revision reconnect status transition was suppressed")
	}
}
