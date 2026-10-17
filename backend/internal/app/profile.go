package app

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

type diskProfile struct {
	Profile    Profile           `json:"profile"`
	PrivateKey []byte            `json:"privateKey"`
	Pins       map[string]string `json:"pins"`
}

type ProfileStore struct {
	mu   sync.Mutex
	path string
	data diskProfile
}

func OpenProfile(dir string) (*ProfileStore, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &ProfileStore{path: filepath.Join(dir, "identity.json")}
	b, err := os.ReadFile(s.path)
	if err == nil {
		if err = json.Unmarshal(b, &s.data); err != nil {
			return nil, errors.New("玩家身份文件损坏，请备份后恢复身份文件")
		}
		if len(s.data.PrivateKey) != ed25519.PrivateKeySize {
			return nil, errors.New("玩家身份密钥无效")
		}
		s.data.Profile.ID = identityID(ed25519.PrivateKey(s.data.PrivateKey).Public().(ed25519.PublicKey))
		if s.data.Pins == nil {
			s.data.Pins = map[string]string{}
		}
		return s, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	s.data = diskProfile{Profile: Profile{ID: identityID(pub), Nickname: "田园牌友", Music: .3, Sound: .6, Voice: .6}, PrivateKey: key, Pins: map[string]string{}}
	return s, s.writeLocked()
}

func identityID(key ed25519.PublicKey) string {
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:16])
}
func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func (s *ProfileStore) Get() Profile { s.mu.Lock(); defer s.mu.Unlock(); return s.data.Profile }
func (s *ProfileStore) Key() ed25519.PrivateKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append(ed25519.PrivateKey(nil), s.data.PrivateKey...)
}
func cleanText(v string, max int) string {
	v = strings.TrimSpace(v)
	v = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, v)
	r := []rune(v)
	if len(r) > max {
		v = string(r[:max])
	}
	return v
}
func validNickname(v string) bool {
	return utf8.ValidString(v) && len([]rune(strings.TrimSpace(v))) > 0 && len([]rune(v)) <= 16 && cleanText(v, 16) == v
}
func (s *ProfileStore) Save(p Profile) (Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !validNickname(p.Nickname) {
		return Profile{}, errors.New("昵称需要 1–16 个字符且不能包含控制字符")
	}
	if p.Character < 0 || p.Character >= CharacterCount {
		return Profile{}, errors.New("角色不存在")
	}
	for _, v := range []float64{p.Music, p.Sound, p.Voice} {
		if math.IsNaN(v) || v < 0 || v > 1 {
			return Profile{}, errors.New("音量必须为 0–1")
		}
	}
	p.ID = s.data.Profile.ID
	previous := s.data.Profile
	s.data.Profile = p
	if err := s.writeLocked(); err != nil {
		s.data.Profile = previous
		return Profile{}, err
	}
	return p, nil
}

// Trust-on-first-use pins the host signing key per address. TLS always encrypts
// the password and session token; reconnects reject an identity substitution.
func (s *ProfileStore) CheckPin(address, id string, save bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old := s.data.Pins[address]; old != "" && old != id {
		return errors.New("房主身份与之前不一致；请核对地址，使用该房主新的房间地址")
	}
	if save && s.data.Pins[address] == "" {
		s.data.Pins[address] = id
		if err := s.writeLocked(); err != nil {
			delete(s.data.Pins, address)
			return err
		}
	}
	return nil
}
func (s *ProfileStore) writeLocked() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".identity-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(b)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, s.path)
}
