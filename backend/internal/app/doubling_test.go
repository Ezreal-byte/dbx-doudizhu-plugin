package app

import (
	"fmt"
	"sync"
	"testing"
)

func TestSimultaneousDoublingPreservesEveryDecision(t *testing.T) {
	r, err := NewRoom(testProfile("host"), CreateParams{InitialBeans: 10000}, noopSink)
	if err != nil {
		t.Fatal(err)
	}
	_, _, secondEpoch, err := r.Join(testProfile("second"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	_, _, thirdEpoch, err := r.Join(testProfile("third"), "", noopSink)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{"host", "second", "third"}
	epochs := []string{r.HostEpoch(), secondEpoch, thirdEpoch}
	for i, id := range ids {
		if _, err := r.Call(id, epochs[i], "room.ready", jsonValue(map[string]bool{"ready": true})); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.Call(ids[0], epochs[0], "game.action", jsonValue(map[string]any{"actionId": "bid", "type": "bid", "score": 3})); err != nil {
		t.Fatal(err)
	}
	base, _ := r.Snapshot("host")
	params := func(id string, revision uint64, round string, doubled bool) []byte {
		return jsonValue(map[string]any{"actionId": id, "type": "double", "double": doubled, "expectedRevision": revision, "expectedRoundId": round})
	}
	// Future or foreign-round requests cannot borrow the simultaneous-action exception.
	for _, p := range [][]byte{params("future", base.Revision+1, base.Game.RoundID, true), params("old-round", base.Revision, "prior-round", true)} {
		if _, err := r.Call(ids[0], epochs[0], "game.action", p); err == nil {
			t.Fatal("invalid double accepted")
		}
	}
	var wg sync.WaitGroup
	errors := make(chan error, 3)
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			_, err := r.Call(id, epochs[i], "game.action", params(fmt.Sprintf("double-%d", i), base.Revision, base.Game.RoundID, i != 1))
			errors <- err
		}(i, id)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("simultaneous decision discarded: %v", err)
		}
	}
	after, _ := r.Snapshot("host")
	if after.Game.Phase != "playing" || fmt.Sprint(after.Game.Doubles) != "[2 1 2]" {
		t.Fatalf("decisions not preserved: %+v", after.Game)
	}
	// A retry keeps the original choice, and a new action cannot change it after play begins.
	if _, err := r.Call(ids[0], epochs[0], "game.action", params("double-0", base.Revision, base.Game.RoundID, false)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Call(ids[0], epochs[0], "game.action", params("double-changed", base.Revision, base.Game.RoundID, false)); err == nil {
		t.Fatal("post-decision edit accepted")
	}
	if _, err := r.Call(ids[0], epochs[0], "game.action", jsonValue(map[string]any{"actionId": "stale-play", "type": "play", "cards": []int{after.Game.Hand[0]}, "expectedRevision": base.Revision, "expectedRoundId": base.Game.RoundID})); err == nil {
		t.Fatal("stale turn-based play accepted")
	}
}
