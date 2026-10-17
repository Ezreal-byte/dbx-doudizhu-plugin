package app

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"errors"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

const serviceType = "_dbxddz._tcp"

type discoveredRoom struct {
	Info   RoomInfo
	HostID string
}
type Discovery struct {
	mu     sync.Mutex
	server *zeroconf.Server
	room   *Room
	hostID string
}

func StartDiscovery(room *Room, port int, hostID string) (*Discovery, error) {
	d := &Discovery{room: room, hostID: hostID}
	info := room.Info()
	server, err := zeroconf.Register(info.ID, serviceType, "local.", port, discoveryTXT(info, hostID), nil)
	if err != nil {
		return d, err
	}
	d.server = server
	return d, nil
}
func discoveryTXT(info RoomInfo, hostID string) []string {
	return []string{"v=" + strconv.Itoa(Protocol), "id=" + info.ID, "name=" + info.Name, "count=" + strconv.Itoa(info.Count), "locked=" + strconv.FormatBool(info.Locked), "phase=" + info.Phase, "beans=" + strconv.FormatInt(info.InitialBeans, 10), "host=" + hostID}
}

// zeroconf v1.0.0 SetText races with its internal probe goroutine. Keep the
// announcement immutable; current count/phase comes from an authenticated TLS
// hello during each scan. This also removes stale advertisements from the UI.
func (d *Discovery) Close() {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.server != nil {
		d.server.Shutdown()
		d.server = nil
	}
}

func ScanRooms(ctx context.Context) ([]discoveredRoom, error) {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		return nil, err
	}
	entries := make(chan *zeroconf.ServiceEntry, 32)
	scanCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	if err = resolver.Browse(scanCtx, serviceType, "local.", entries); err != nil {
		return nil, err
	}
	rooms := map[string]discoveredRoom{}
	finish := func() []discoveredRoom {
		result := make([]discoveredRoom, 0, len(rooms))
		for _, room := range rooms {
			result = append(result, room)
		}
		sort.Slice(result, func(i, j int) bool { return result[i].Info.Name < result[j].Info.Name })
		return result
	}
	for {
		select {
		case <-scanCtx.Done():
			return probeDiscoveredRooms(ctx, finish()), nil
		case entry, ok := <-entries:
			if !ok {
				return probeDiscoveredRooms(ctx, finish()), nil
			}
			if room, ok := parseDiscovery(entry); ok {
				rooms[room.Info.ID] = room
			}
		}
	}
}

func probeDiscoveredRooms(ctx context.Context, rooms []discoveredRoom) []discoveredRoom {
	if len(rooms) > 32 {
		rooms = rooms[:32]
	}
	results := make(chan discoveredRoom, len(rooms))
	slots := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, room := range rooms {
		wg.Add(1)
		go func(room discoveredRoom) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()
			if live, ok := probeDiscoveredRoom(ctx, room); ok {
				results <- live
			}
		}(room)
	}
	wg.Wait()
	close(results)
	live := []discoveredRoom{}
	for room := range results {
		live = append(live, room)
	}
	sort.Slice(live, func(i, j int) bool { return live[i].Info.Name < live[j].Info.Name })
	return live
}

func probeDiscoveredRoom(ctx context.Context, room discoveredRoom) (discoveredRoom, bool) {
	probeCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	addresses := room.Info.Addresses
	if len(addresses) > 8 {
		addresses = addresses[:8]
	}
	results := make(chan discoveredRoom, len(addresses))
	var wg sync.WaitGroup
	for _, address := range addresses {
		wg.Add(1)
		go func(address string) {
			defer wg.Done()
			config := &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error {
				if len(cs.PeerCertificates) != 1 {
					return errors.New("invalid certificate")
				}
				cert := cs.PeerCertificates[0]
				pub, ok := cert.PublicKey.(ed25519.PublicKey)
				if !ok || identityID(pub) != room.HostID || time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
					return errors.New("host identity mismatch")
				}
				return cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature)
			}}
			dialer := tls.Dialer{NetDialer: &net.Dialer{Timeout: time.Second}, Config: config}
			conn, err := dialer.DialContext(probeCtx, "tcp", address)
			if err != nil {
				return
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			message, err := readMessage(scannerFor(conn))
			if err != nil || message.Type != "challenge" || message.Protocol != Protocol || message.RoomID != room.Info.ID || message.HostID != room.HostID || message.Room == nil || message.Room.ID != room.Info.ID {
				return
			}
			info := *message.Room
			info.Address = address
			info.Addresses = append([]string{address}, room.Info.Addresses...)
			select {
			case results <- discoveredRoom{Info: info, HostID: room.HostID}:
			case <-probeCtx.Done():
			}
		}(address)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case result := <-results:
		return result, true
	case <-done:
		select {
		case result := <-results:
			return result, true
		default:
			return discoveredRoom{}, false
		}
	case <-probeCtx.Done():
		return discoveredRoom{}, false
	}
}
func parseDiscovery(entry *zeroconf.ServiceEntry) (discoveredRoom, bool) {
	var result discoveredRoom
	values := map[string]string{}
	for _, v := range entry.Text {
		parts := strings.SplitN(v, "=", 2)
		if len(parts) == 2 {
			values[parts[0]] = parts[1]
		}
	}
	version, _ := strconv.Atoi(values["v"])
	count, _ := strconv.Atoi(values["count"])
	beans, _ := strconv.ParseInt(values["beans"], 10, 64)
	locked, _ := strconv.ParseBool(values["locked"])
	if version != Protocol || len(values["id"]) != 32 || len(values["host"]) != 32 || entry.Port < 1 || entry.Port > 65535 || count < 1 || count > 3 || beans < 1000 || beans > MaxBeans {
		return result, false
	}
	addresses := []string{}
	for _, ip := range entry.AddrIPv4 {
		if ip.IsPrivate() || ip.IsLoopback() {
			addresses = append(addresses, net.JoinHostPort(ip.String(), strconv.Itoa(entry.Port)))
		}
	}
	if len(addresses) == 0 {
		return result, false
	}
	result = discoveredRoom{Info: RoomInfo{ID: values["id"], Name: cleanText(values["name"], 32), Address: addresses[0], Addresses: addresses, Count: count, Locked: locked, Phase: values["phase"], InitialBeans: beans, Protocol: version}, HostID: values["host"]}
	return result, true
}
