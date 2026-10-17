package app

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestMusicPersistenceValidationAndReset(t *testing.T) {
	dir := t.TempDir()
	a, err := New(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	valid := MusicInput{Name: "我的音乐.mp3", Mime: "audio/mpeg", DataBase64: base64.StdEncoding.EncodeToString([]byte("ID3\x04\x00\x00\x00\x00\x00\x00testmusic"))}
	if _, err := a.Call("music.set", jsonValue(valid)); err != nil {
		t.Fatal(err)
	}
	reopened := NewMusicStore(dir)
	got, err := reopened.Get()
	if err != nil || got == nil || *got != valid {
		t.Fatalf("music not preserved: %+v %v", got, err)
	}
	for _, bad := range []MusicInput{
		{Name: "bad", Mime: "audio/mpeg", DataBase64: "%%%"},
		{Name: "bad", Mime: "audio/mpeg", DataBase64: base64.StdEncoding.EncodeToString([]byte("not audio at all"))},
		{Name: "bad", Mime: "text/html", DataBase64: valid.DataBase64},
		{Name: "bad", Mime: "audio/mpeg", DataBase64: strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxMusicBytes)+4)},
	} {
		if _, err := reopened.Set(bad); err == nil {
			t.Fatal("invalid music accepted")
		}
	}
	got, err = reopened.Get()
	if err != nil || got == nil || got.DataBase64 != valid.DataBase64 {
		t.Fatal("invalid import replaced current music")
	}
	if result, err := a.Call("music.set", jsonValue(MusicInput{Clear: true})); err != nil || result.(*MusicInput) != nil {
		t.Fatalf("reset failed: %v %v", result, err)
	}
	if got, err = reopened.Get(); err != nil || got != nil {
		t.Fatalf("reset not persistent: %v", err)
	}
}

func TestAllFiveCharacterProfiles(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenProfile(dir)
	if err != nil {
		t.Fatal(err)
	}
	p := s.Get()
	for i := 0; i < CharacterCount; i++ {
		p.Character = i
		if _, err = s.Save(p); err != nil {
			t.Fatalf("character %d: %v", i, err)
		}
	}
	p.Character = CharacterCount
	if _, err = s.Save(p); err == nil {
		t.Fatal("out of range character accepted")
	}
	reloaded, err := OpenProfile(dir)
	if err != nil || reloaded.Get().Character != 4 {
		t.Fatal("new character not preserved")
	}
}
