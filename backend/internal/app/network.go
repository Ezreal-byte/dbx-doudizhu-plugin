package app

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxWireBytes = 128 * 1024

type wireMessage struct {
	written   chan struct{}
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
	Token     string          `json:"token,omitempty"`
	Nonce     string          `json:"nonce,omitempty"`
	RoomID    string          `json:"roomId,omitempty"`
	HostID    string          `json:"hostId,omitempty"`
	Protocol  int             `json:"protocol,omitempty"`
	PublicKey []byte          `json:"publicKey,omitempty"`
	Signature []byte          `json:"signature,omitempty"`
	Password  string          `json:"password,omitempty"`
	Profile   *Profile        `json:"profile,omitempty"`
	Room      *RoomInfo       `json:"room,omitempty"`
}

func jsonValue(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func scannerFor(conn net.Conn) *bufio.Scanner {
	s := bufio.NewScanner(conn)
	s.Buffer(make([]byte, 4096), maxWireBytes)
	return s
}
func readMessage(s *bufio.Scanner) (wireMessage, error) {
	var m wireMessage
	if !s.Scan() {
		if err := s.Err(); err != nil {
			return m, err
		}
		return m, errors.New("连接已断开")
	}
	if err := json.Unmarshal(s.Bytes(), &m); err != nil {
		return m, errors.New("网络协议格式错误")
	}
	return m, nil
}
func writeMessage(conn net.Conn, m wireMessage) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > maxWireBytes {
		return errors.New("消息过大")
	}
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err = conn.Write(append(b, '\n'))
	return err
}
func proofMessage(nonce, roomID string) []byte {
	return []byte(fmt.Sprintf("dbxddz:%d|%s|%s", Protocol, nonce, roomID))
}

type attempt struct {
	count int
	since time.Time
}
type RoomServer struct {
	room        *Room
	listener    net.Listener
	key         ed25519.PrivateKey
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	mu          sync.Mutex
	connections map[net.Conn]bool
	sessions    map[string]net.Conn
	attempts    map[string]attempt
	closeOnce   sync.Once
}

func StartRoomServer(room *Room, key ed25519.PrivateKey) (*RoomServer, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	template := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: room.hostID}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(30 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, key.Public(), key)
	if err != nil {
		return nil, err
	}
	listener, err := tls.Listen("tcp", "0.0.0.0:0", &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &RoomServer{room: room, listener: listener, key: key, ctx: ctx, cancel: cancel, connections: map[net.Conn]bool{}, sessions: map[string]net.Conn{}, attempts: map[string]attempt{}}
	port := listener.Addr().(*net.TCPAddr).Port
	room.SetAddresses(localAddresses(port))
	s.wg.Add(1)
	go s.acceptLoop()
	return s, nil
}
func (s *RoomServer) Port() int       { return s.listener.Addr().(*net.TCPAddr).Port }
func (s *RoomServer) Address() string { return net.JoinHostPort("127.0.0.1", strconv.Itoa(s.Port())) }
func localAddresses(port int) []string {
	result := []string{}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipNet.IP.To4()
		if ip == nil || ip.IsLoopback() || !ip.IsPrivate() {
			continue
		}
		result = append(result, net.JoinHostPort(ip.String(), strconv.Itoa(port)))
	}
	result = append(result, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	return result
}
func (s *RoomServer) acceptLoop() {
	defer s.wg.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if len(s.connections) >= 16 {
			s.mu.Unlock()
			conn.Close()
			continue
		}
		s.connections[conn] = true
		s.mu.Unlock()
		s.wg.Add(1)
		go s.serve(conn)
	}
}
func (s *RoomServer) rateLimited(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.attempts[ip]
	return a.count >= 5 && time.Since(a.since) < time.Minute
}
func (s *RoomServer) failedAuth(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.attempts) > 256 {
		for key, a := range s.attempts {
			if time.Since(a.since) > time.Minute {
				delete(s.attempts, key)
			}
		}
	}
	a := s.attempts[ip]
	if time.Since(a.since) > time.Minute {
		a = attempt{since: time.Now()}
	}
	a.count++
	s.attempts[ip] = a
}
func (s *RoomServer) serve(conn net.Conn) {
	defer s.wg.Done()
	defer conn.Close()
	defer func() { s.mu.Lock(); delete(s.connections, conn); s.mu.Unlock() }()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	if c, ok := conn.(*tls.Conn); ok {
		if err := c.HandshakeContext(s.ctx); err != nil {
			return
		}
	}
	ip, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
	nonce := randomID()
	info := s.room.Info()
	if err := writeMessage(conn, wireMessage{Type: "challenge", Nonce: nonce, RoomID: info.ID, HostID: s.room.hostID, Protocol: Protocol, Room: &info}); err != nil {
		return
	}
	scanner := scannerFor(conn)
	auth, err := readMessage(scanner)
	if err != nil {
		return
	}
	reject := func(message string) {
		_ = writeMessage(conn, wireMessage{Type: "response", ID: "auth", Error: message})
	}
	if s.rateLimited(ip) {
		reject("密码尝试过于频繁，请一分钟后再试")
		return
	}
	if auth.Type != "auth" || auth.Profile == nil || auth.Protocol != Protocol || auth.RoomID != info.ID || len(auth.PublicKey) != ed25519.PublicKeySize || !ed25519.Verify(auth.PublicKey, proofMessage(nonce, info.ID), auth.Signature) {
		s.failedAuth(ip)
		reject("身份或协议验证失败")
		return
	}
	if len(auth.Password) > 32 || auth.Token == "" && !s.room.CheckPassword(auth.Password) {
		s.failedAuth(ip)
		reject("房间密码错误")
		return
	}
	profile := *auth.Profile
	profile.ID = identityID(auth.PublicKey)
	out := make(chan wireMessage, 64)
	done := make(chan struct{})
	var writeWG sync.WaitGroup
	writeWG.Add(1)
	go func() {
		defer writeWG.Done()
		for {
			select {
			case <-done:
				return
			case msg := <-out:
				if writeMessage(conn, msg) != nil {
					conn.Close()
					return
				}
				if msg.written != nil {
					close(msg.written)
				}
			}
		}
	}()
	defer func() { close(done); conn.Close(); writeWG.Wait() }()
	enqueue := func(msg wireMessage) {
		select {
		case out <- msg:
		default:
			conn.Close()
		}
	}
	snapshot, token, epoch, err := s.room.Join(profile, auth.Token, func(method string, value any) {
		enqueue(wireMessage{Type: "event", Method: method, Params: jsonValue(value)})
	})
	if err != nil {
		_ = writeMessage(conn, wireMessage{Type: "response", ID: "auth", Error: err.Error()})
		return
	}
	s.mu.Lock()
	old := s.sessions[profile.ID]
	s.sessions[profile.ID] = conn
	delete(s.attempts, ip)
	s.mu.Unlock()
	if old != nil && old != conn {
		old.Close()
	}
	defer func() {
		s.room.Disconnect(profile.ID, epoch)
		s.mu.Lock()
		if s.sessions[profile.ID] == conn {
			delete(s.sessions, profile.ID)
		}
		s.mu.Unlock()
	}()
	enqueue(wireMessage{Type: "response", ID: "auth", Result: jsonValue(snapshot), Token: token})
	_ = conn.SetDeadline(time.Time{})
	for {
		_ = conn.SetReadDeadline(time.Now().Add(20 * time.Second))
		message, err := readMessage(scanner)
		if err != nil {
			return
		}
		if message.Type != "request" || len(message.ID) > 96 || message.ID == "" {
			return
		}
		if message.Method == "ping" {
			enqueue(wireMessage{Type: "response", ID: message.ID, Result: jsonValue(map[string]bool{"ok": true})})
			continue
		}
		result, callErr := s.room.Call(profile.ID, epoch, message.Method, message.Params)
		response := wireMessage{Type: "response", ID: message.ID, Result: jsonValue(result)}
		if callErr != nil {
			response.Result = nil
			response.Error = callErr.Error()
		}
		if message.Method == "room.leave" && callErr == nil {
			response.written = make(chan struct{})
			enqueue(response)
			select {
			case <-response.written:
			case <-time.After(time.Second):
			}
			return
		}
		enqueue(response)
	}
}
func (s *RoomServer) Close() {
	s.closeOnce.Do(func() {
		s.cancel()
		s.listener.Close()
		s.mu.Lock()
		for conn := range s.connections {
			conn.Close()
		}
		s.mu.Unlock()
		s.wg.Wait()
	})
}

type Remote struct {
	mu                             sync.Mutex
	writeMu                        sync.Mutex
	conn                           net.Conn
	pending                        map[string]chan wireMessage
	profile                        *ProfileStore
	address, roomID, hostID, token string
	params                         JoinParams
	snapshot                       Snapshot
	status                         string
	sink                           EventSink
	ctx                            context.Context
	cancel                         context.CancelFunc
	wg                             sync.WaitGroup
	closeOnce                      sync.Once
	addresses                      []string
	connectTimeout                 time.Duration
}

func DialRoom(store *ProfileStore, p JoinParams, expectedHost string, sink EventSink) (*Remote, error) {
	return DialRoomCandidates(store, p, expectedHost, nil, sink)
}

func DialRoomCandidates(store *ProfileStore, p JoinParams, expectedHost string, addresses []string, sink EventSink) (*Remote, error) {
	address, err := normalizeAddress(p.Address)
	if err != nil {
		return nil, err
	}
	p.Address = address
	ctx, cancel := context.WithCancel(context.Background())
	r := &Remote{profile: store, address: address, roomID: p.RoomID, hostID: expectedHost, params: p, pending: map[string]chan wireMessage{}, sink: sink, ctx: ctx, cancel: cancel, status: "connected"}
	r.addresses = append([]string{address}, addresses...)
	r.connectTimeout = 5 * time.Second
	if len(addresses) > 1 {
		r.connectTimeout = 1500 * time.Millisecond
	}
	conn, scanner, snapshot, token, hostID, err := r.connectCandidates("")
	if err != nil {
		cancel()
		return nil, err
	}
	r.conn = conn
	r.snapshot = snapshot
	r.token = token
	r.roomID = snapshot.Room.ID
	r.hostID = hostID
	r.params.Password = ""
	r.wg.Add(2)
	go r.run(conn, scanner)
	go r.heartbeat()
	return r, nil
}

func (r *Remote) connectCandidates(token string) (net.Conn, *bufio.Scanner, Snapshot, string, string, error) {
	seen := map[string]bool{}
	candidates := append([]string{r.address}, r.addresses...)
	var lastErr error
	for _, candidate := range candidates {
		address, err := normalizeAddress(candidate)
		if err != nil || seen[address] {
			continue
		}
		seen[address] = true
		if len(seen) > 8 {
			break
		}
		r.address = address
		conn, scanner, snapshot, newToken, hostID, err := r.connect(token)
		if err == nil {
			return conn, scanner, snapshot, newToken, hostID, nil
		}
		lastErr = err
		var networkError net.Error
		if !errors.As(err, &networkError) && !strings.Contains(err.Error(), "房主身份") {
			return nil, nil, Snapshot{}, "", "", err
		}
	}
	if lastErr == nil {
		lastErr = errors.New("没有可连接的房间地址")
	}
	return nil, nil, Snapshot{}, "", "", lastErr
}

func normalizeAddress(v string) (string, error) {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "dbxddz://")
	host, port, err := net.SplitHostPort(v)
	if err != nil || host == "" {
		return "", errors.New("请输入房主的 IP:端口，例如 192.168.1.8:45678")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", errors.New("端口范围必须为 1–65535")
	}
	if strings.ContainsAny(host, "/\\\n\r\t ") {
		return "", errors.New("房间地址无效")
	}
	return net.JoinHostPort(host, strconv.Itoa(n)), nil
}

func (r *Remote) connect(token string) (net.Conn, *bufio.Scanner, Snapshot, string, string, error) {
	var empty Snapshot
	var verifiedHost string
	config := &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) != 1 {
			return errors.New("房主证书无效")
		}
		cert := cs.PeerCertificates[0]
		pub, ok := cert.PublicKey.(ed25519.PublicKey)
		if !ok {
			return errors.New("房主身份密钥无效")
		}
		if time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
			return errors.New("房主证书已过期")
		}
		if err := cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature); err != nil {
			return errors.New("房主证书签名无效")
		}
		verifiedHost = identityID(pub)
		if r.hostID != "" && r.hostID != verifiedHost {
			return errors.New("房主身份与发现的房间不一致")
		}
		return r.profile.CheckPin(r.address, verifiedHost, false)
	}}
	dialTimeout := r.connectTimeout
	if dialTimeout == 0 {
		dialTimeout = 5 * time.Second
	}
	dialer := tls.Dialer{NetDialer: &net.Dialer{Timeout: dialTimeout}, Config: config}
	conn, err := dialer.DialContext(r.ctx, "tcp", r.address)
	if err != nil {
		return nil, nil, empty, "", "", fmt.Errorf("无法连接房间：%w", err)
	}
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	scanner := scannerFor(conn)
	challenge, err := readMessage(scanner)
	if err != nil {
		return nil, nil, empty, "", "", err
	}
	if challenge.Type != "challenge" || challenge.Protocol != Protocol || challenge.HostID != verifiedHost || len(challenge.Nonce) < 16 {
		return nil, nil, empty, "", "", errors.New("房间协议不兼容")
	}
	if r.roomID != "" && challenge.RoomID != r.roomID {
		return nil, nil, empty, "", "", errors.New("原房间已关闭，请重新搜索房间")
	}
	key := r.profile.Key()
	profile := r.profile.Get()
	auth := wireMessage{Type: "auth", ID: "auth", RoomID: challenge.RoomID, Protocol: Protocol, Profile: &profile, PublicKey: key.Public().(ed25519.PublicKey), Signature: ed25519.Sign(key, proofMessage(challenge.Nonce, challenge.RoomID)), Token: token, Password: r.params.Password}
	if err = writeMessage(conn, auth); err != nil {
		return nil, nil, empty, "", "", err
	}
	for {
		message, readErr := readMessage(scanner)
		if readErr != nil {
			return nil, nil, empty, "", "", readErr
		}
		if message.Type != "response" || message.ID != "auth" {
			continue
		}
		if message.Error != "" {
			return nil, nil, empty, "", "", errors.New(message.Error)
		}
		if err = json.Unmarshal(message.Result, &empty); err != nil {
			return nil, nil, empty, "", "", err
		}
		if len(message.Token) < 16 || empty.SelfID != profile.ID || empty.HostID != verifiedHost {
			return nil, nil, Snapshot{}, "", "", errors.New("房间身份响应无效")
		}
		if err = r.profile.CheckPin(r.address, verifiedHost, true); err != nil {
			return nil, nil, empty, "", "", err
		}
		_ = conn.SetDeadline(time.Time{})
		ok = true
		return conn, scanner, empty, message.Token, verifiedHost, nil
	}
}

func (r *Remote) run(conn net.Conn, scanner *bufio.Scanner) {
	defer r.wg.Done()
	for {
		for {
			_ = conn.SetReadDeadline(time.Now().Add(20 * time.Second))
			msg, err := readMessage(scanner)
			if err != nil {
				break
			}
			r.receive(msg)
		}
		conn.Close()
		r.mu.Lock()
		if r.conn == conn {
			r.conn = nil
		}
		for id, ch := range r.pending {
			ch <- wireMessage{Error: "连接中断，请稍后重试"}
			delete(r.pending, id)
		}
		r.mu.Unlock()
		if r.ctx.Err() != nil {
			return
		}
		r.setStatus("reconnecting", "连接中断，正在尝试重连")
		deadline := time.Now().Add(60 * time.Second)
		reconnected := false
		for time.Now().Before(deadline) {
			select {
			case <-r.ctx.Done():
				return
			case <-time.After(time.Second):
			}
			r.mu.Lock()
			token := r.token
			r.mu.Unlock()
			next, nextScanner, snapshot, newToken, _, err := r.connectCandidates(token)
			if err != nil {
				if strings.Contains(err.Error(), "原房间已关闭") || strings.Contains(err.Error(), "会话已失效") || strings.Contains(err.Error(), "凭据已失效") || strings.Contains(err.Error(), "房间已经关闭") {
					r.setStatus("disconnected", err.Error())
					r.sink("room.closed", map[string]string{"reason": err.Error()})
					r.cancel()
					return
				}
				continue
			}
			r.mu.Lock()
			r.conn = next
			r.snapshot = snapshot
			r.token = newToken
			r.mu.Unlock()
			conn = next
			scanner = nextScanner
			reconnected = true
			r.setStatus("connected", "")
			r.sink("room.state", snapshot)
			break
		}
		if !reconnected {
			reason := "房主已离线，本局不作结算；可以返回大厅"
			r.setStatus("disconnected", reason)
			r.sink("room.closed", map[string]string{"reason": reason})
			r.cancel()
			return
		}
	}
}
func (r *Remote) receive(msg wireMessage) {
	if msg.Type == "response" {
		r.mu.Lock()
		ch := r.pending[msg.ID]
		delete(r.pending, msg.ID)
		r.mu.Unlock()
		if ch != nil {
			ch <- msg
		}
		return
	}
	if msg.Type != "event" {
		return
	}
	if msg.Method == "room.state" {
		var snapshot Snapshot
		if json.Unmarshal(msg.Params, &snapshot) != nil {
			return
		}
		r.mu.Lock()
		if snapshot.Revision < r.snapshot.Revision {
			r.mu.Unlock()
			return
		}
		r.snapshot = snapshot
		r.mu.Unlock()
	}
	if msg.Method == "room.closed" {
		r.setStatus("disconnected", "房间已关闭")
		r.cancel()
	}
	r.sink(msg.Method, msg.Params)
}
func (r *Remote) setStatus(status, message string) {
	r.mu.Lock()
	r.status = status
	r.snapshot.Connection = status
	r.mu.Unlock()
	r.sink("connection.state", map[string]string{"status": status, "message": message})
}
func (r *Remote) Snapshot() Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.snapshot
	s.Connection = r.status
	return s
}
func (r *Remote) Call(method string, params json.RawMessage) (json.RawMessage, error) {
	id := randomID()
	ch := make(chan wireMessage, 1)
	r.mu.Lock()
	conn := r.conn
	if conn == nil || r.status != "connected" {
		r.mu.Unlock()
		return nil, errors.New("正在重连，请稍后再试")
	}
	r.pending[id] = ch
	r.mu.Unlock()
	r.writeMu.Lock()
	err := writeMessage(conn, wireMessage{Type: "request", ID: id, Method: method, Params: params})
	r.writeMu.Unlock()
	if err != nil {
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
		conn.Close()
		return nil, err
	}
	select {
	case response := <-ch:
		if response.Error != "" {
			return nil, errors.New(response.Error)
		}
		if snapshotResultMethod(method) {
			return r.reconcileSnapshot(response.Result), nil
		}
		return response.Result, nil
	case <-r.ctx.Done():
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
		return nil, errors.New("房间连接已关闭")
	case <-time.After(5 * time.Second):
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
		return nil, errors.New("房间操作超时")
	}
}

func snapshotResultMethod(method string) bool {
	switch method {
	case "profile.update", "room.snapshot", "room.ready", "room.reset", "game.action":
		return true
	default:
		return false
	}
}

// reconcileSnapshot keeps RPC results and event snapshots on one monotonic
// revision stream. A later room.state can arrive before an earlier request's
// response because both share the server's asynchronous write queue.
func (r *Remote) reconcileSnapshot(raw json.RawMessage) json.RawMessage {
	var incoming Snapshot
	if json.Unmarshal(raw, &incoming) != nil {
		return raw
	}
	r.mu.Lock()
	if incoming.Revision >= r.snapshot.Revision {
		r.snapshot = incoming
	} else {
		incoming = r.snapshot
	}
	r.mu.Unlock()
	if result, err := json.Marshal(incoming); err == nil {
		return result
	}
	return raw
}

func (r *Remote) heartbeat() {
	defer r.wg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			_, _ = r.Call("ping", nil)
		}
	}
}
func (r *Remote) Close() {
	r.closeOnce.Do(func() {
		r.cancel()
		r.mu.Lock()
		if r.conn != nil {
			r.conn.Close()
		}
		r.mu.Unlock()
		r.wg.Wait()
	})
}
