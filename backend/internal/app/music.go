package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// The base64 envelope stays below the host SDK's 8 MiB JSONL limit.
const MaxMusicBytes = 4 * 1024 * 1024
const maxMusicJSON = 6 * 1024 * 1024

type MusicInput struct {
	Name       string `json:"name"`
	Mime       string `json:"mime"`
	DataBase64 string `json:"dataBase64"`
	Clear      bool   `json:"clear,omitempty"`
}

// Music is a device-local preference. Room RPC never exposes or broadcasts it.
type MusicStore struct {
	mu   sync.Mutex
	path string
}

func NewMusicStore(dir string) *MusicStore {
	return &MusicStore{path: filepath.Join(dir, "custom-music.json")}
}

func validateMusic(p MusicInput) (MusicInput, error) {
	if len(p.DataBase64) > base64.StdEncoding.EncodedLen(MaxMusicBytes) {
		return MusicInput{}, errors.New("音乐文件不能超过 4 MiB")
	}
	data, err := base64.StdEncoding.DecodeString(p.DataBase64)
	if err != nil || len(data) < 12 || len(data) > MaxMusicBytes {
		return MusicInput{}, errors.New("音乐文件为空、损坏或超过 4 MiB")
	}
	p.Name = cleanText(strings.TrimSpace(p.Name), 80)
	if p.Name == "" {
		return MusicInput{}, errors.New("音乐名称不能为空")
	}
	p.Mime = strings.ToLower(strings.TrimSpace(p.Mime))
	valid := false
	switch p.Mime {
	case "audio/mpeg", "audio/mp3":
		p.Mime = "audio/mpeg"
		valid = bytes.HasPrefix(data, []byte("ID3")) || (data[0] == 0xff && data[1]&0xe0 == 0xe0)
	case "audio/wav", "audio/x-wav", "audio/wave":
		p.Mime = "audio/wav"
		valid = string(data[:4]) == "RIFF" && string(data[8:12]) == "WAVE"
	case "audio/ogg", "audio/opus":
		p.Mime = "audio/ogg"
		valid = bytes.HasPrefix(data, []byte("OggS"))
	case "audio/mp4", "audio/x-m4a":
		p.Mime = "audio/mp4"
		valid = string(data[4:8]) == "ftyp"
	}
	if !valid {
		return MusicInput{}, errors.New("请选择有效的 MP3、WAV、OGG 或 M4A 音乐文件")
	}
	p.Clear = false
	return p, nil
}

func (s *MusicStore) Get() (*MusicInput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxMusicJSON+1))
	if err != nil || len(b) > maxMusicJSON {
		return nil, errors.New("本地音乐文件无法读取，请重新导入")
	}
	var p MusicInput
	if json.Unmarshal(b, &p) != nil {
		return nil, errors.New("本地音乐配置损坏，请重新导入")
	}
	p, err = validateMusic(p)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *MusicStore) Set(p MusicInput) (*MusicInput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Clear {
		if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		return nil, nil
	}
	p, err := validateMusic(p)
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".music-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	if err = os.Rename(f.Name(), s.path); err != nil {
		return nil, err
	}
	return &p, nil
}
