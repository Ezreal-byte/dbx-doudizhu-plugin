package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"

	"dbx-doudizhu-plugin/backend/internal/app"
	dbx "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

type handler struct {
	application *app.App
	mu          sync.RWMutex
	emitter     *dbx.Emitter
}

func (h *handler) Handle(_ dbx.RequestContext, method string, params json.RawMessage, emitter *dbx.Emitter) (any, *dbx.PluginError) {
	h.mu.Lock()
	h.emitter = emitter
	h.mu.Unlock()
	result, err := h.application.Call(method, params)
	if err != nil {
		return nil, dbx.NewError(-32000, err.Error())
	}
	return result, nil
}
func (h *handler) emit(method string, params any) {
	h.mu.RLock()
	emitter := h.emitter
	h.mu.RUnlock()
	if emitter != nil {
		if err := emitter.Event(method, params); err != nil {
			log.Printf("event delivery failed: %s", err.Message)
		}
	}
}

func main() {
	log.SetOutput(os.Stderr)
	dir := os.Getenv("DBX_PLUGIN_DATA_DIR")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			log.Fatal(err)
		}
		dir = filepath.Join(base, "dbx-doudizhu")
	}
	h := &handler{}
	application, err := app.New(dir, h.emit)
	if err != nil {
		log.Fatal(err)
	}
	h.application = application
	defer application.Close()
	server := dbx.NewServer(dbx.Metadata{ID: "io.dbx.doudizhu", Version: "0.1.0", Capabilities: []string{"events", "lan-game"}}, h)
	if err = server.Serve(); err != nil {
		log.Printf("DBX bridge stopped: %v", err)
	}
}
