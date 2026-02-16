package main

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var webFS embed.FS

type Commit struct {
	SHA     string `json:"sha"`
	TS      int64  `json:"ts"`
	Subject string `json:"subject"`
}

type SSEHub struct {
	mu      sync.Mutex
	nextID  int
	clients map[int]chan string
}

func NewSSEHub() *SSEHub {
	return &SSEHub{clients: make(map[int]chan string)}
}

func (h *SSEHub) Add() (id int, ch chan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	id = h.nextID
	h.nextID++
	ch = make(chan string, 32)
	h.clients[id] = ch
	return id, ch
}

func (h *SSEHub) Remove(id int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ch, ok := h.clients[id]; ok {
		delete(h.clients, id)
		close(ch)
	}
}

func (h *SSEHub) Broadcast(v any) {
	b, _ := json.Marshal(v)
	msg := string(b)

	h.mu.Lock()
	defer h.mu.Unlock()
	for id, ch := range h.clients {
		select {
		case ch <- msg:
		default:
			// Slow consumer; drop.
			delete(h.clients, id)
			close(ch)
		}
	}
}

type Supervisor struct {
	repoDir string

	appHost string
	appPort int
	supPort int

	debounce  time.Duration
	pollEvery time.Duration

	hub *SSEHub

	mu         sync.Mutex
	serverCmd  *exec.Cmd
	serverDead bool
	lastHead   string
}

func (s *Supervisor) envForServer() []string {
	env := os.Environ()
	env = append(env, "HOST="+s.appHost)
	env = append(env, "PORT="+strconv.Itoa(s.appPort))
	return env
}

func (s *Supervisor) startServer() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.serverCmd != nil && s.serverCmd.Process != nil && !s.serverDead {
		return nil
	}

	cmd := exec.Command("node", "--import", "tsx", "src/server.ts")
	cmd.Dir = s.repoDir
	cmd.Env = s.envForServer()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		s.serverDead = true
		s.hub.Broadcast(map[string]any{"type": "status", "server": "down"})
		return err
	}

	s.serverCmd = cmd
	s.serverDead = false
	s.hub.Broadcast(map[string]any{"type": "status", "server": "up"})

	go func() {
		_ = cmd.Wait()
		s.mu.Lock()
		defer s.mu.Unlock()
		s.serverDead = true
		s.hub.Broadcast(map[string]any{"type": "status", "server": "down"})
	}()

	return nil
}

func (s *Supervisor) stopServer() {
	s.mu.Lock()
	cmd := s.serverCmd
	s.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = cmd.Process.Kill()
	}
}

func (s *Supervisor) restartServer() error {
	s.stopServer()
	return s.startServer()
}

func runCmd(dir string, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	var out bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return out.String(), fmt.Errorf("%s %v failed: %s", name, args, msg)
	}
	return out.String(), nil
}

func (s *Supervisor) gitDirtyPaths() ([]string, error) {
	// Includes untracked; excludes ignored.
	out, err := runCmd(s.repoDir, "git", "status", "--porcelain")
	if err != nil {
		return nil, err
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return nil, nil
	}
	var paths []string
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if len(line) < 4 {
			continue
		}
		p := strings.TrimSpace(line[3:])
		if strings.HasPrefix(p, "\"") && strings.HasSuffix(p, "\"") {
			p = strings.Trim(p, "\"")
		}
		paths = append(paths, p)
	}
	return paths, nil
}

func needsUIBuild(paths []string) bool {
	for _, p := range paths {
		if strings.HasPrefix(p, "src/ui/") {
			return true
		}
		if p == "public/index.html" || p == "public/styles.css" {
			return true
		}
	}
	return false
}

func needsServerRestart(paths []string) bool {
	for _, p := range paths {
		if strings.HasPrefix(p, "src/ui/") {
			continue
		}
		if strings.HasPrefix(p, "src/") {
			return true
		}
		if p == "package.json" || p == "package-lock.json" || p == "tsconfig.json" {
			return true
		}
	}
	return false
}

func onlyTriggers(paths []string) bool {
	if len(paths) == 0 {
		return false
	}
	for _, p := range paths {
		if strings.HasPrefix(p, "triggers/") {
			continue
		}
		return false
	}
	return true
}

func (s *Supervisor) buildUI() error {
	_, err := runCmd(s.repoDir, "node", "scripts/build-ui.mjs")
	return err
}

func summarizePaths(paths []string) string {
	if len(paths) == 0 {
		return "no changes"
	}
	if len(paths) == 1 {
		return paths[0]
	}
	if len(paths) <= 4 {
		return strings.Join(paths, ", ")
	}
	return fmt.Sprintf("%s, %s, %s (+%d more)", paths[0], paths[1], paths[2], len(paths)-3)
}

func (s *Supervisor) autoCommit() (sha string, msg string, ok bool, err error) {
	// Stage all.
	if _, err = runCmd(s.repoDir, "git", "add", "-A"); err != nil {
		return "", "", false, err
	}

	// Check staged.
	out, err2 := runCmd(s.repoDir, "git", "diff", "--cached", "--name-only")
	if err2 != nil {
		return "", "", false, err2
	}
	files := []string{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		files = append(files, line)
	}
	if len(files) == 0 {
		return "", "", false, nil
	}

	ts := time.Now().UTC().Format(time.RFC3339)
	msg = fmt.Sprintf("auto: %s %s", ts, summarizePaths(files))
	if _, err = runCmd(s.repoDir, "git", "commit", "-m", msg); err != nil {
		return "", "", false, err
	}
	shaOut, err3 := runCmd(s.repoDir, "git", "rev-parse", "HEAD")
	if err3 != nil {
		return "", "", true, nil
	}
	sha = strings.TrimSpace(shaOut)
	s.mu.Lock()
	s.lastHead = sha
	s.mu.Unlock()
	return sha, msg, true, nil
}

func (s *Supervisor) handleSettledChanges(paths []string) {
	// Decide actions based on dirty paths.
	uiChanged := needsUIBuild(paths)
	srvChanged := needsServerRestart(paths)

	if uiChanged {
		if err := s.buildUI(); err != nil {
			log.Printf("ui build failed: %v", err)
		}
	}
	if srvChanged {
		if err := s.restartServer(); err != nil {
			log.Printf("server restart failed: %v", err)
		}
	}

	sha, msg, didCommit, err := s.autoCommit()
	if err != nil {
		log.Printf("auto-commit failed: %v", err)
	} else if didCommit {
		s.hub.Broadcast(map[string]any{"type": "commit", "sha": sha, "msg": msg})
	}

	// Triggers are hot-reloaded by the server; no browser reload needed.
	if uiChanged || srvChanged {
		s.hub.Broadcast(map[string]any{"type": "reload", "reason": "change_settled"})
	}

	// Optional: if only triggers changed, still emit something visible.
	if onlyTriggers(paths) {
		s.hub.Broadcast(map[string]any{"type": "reload", "reason": "triggers_updated", "note": "no page reload needed"})
	}
}

func (s *Supervisor) handleCommittedChanges(paths []string) {
	// For changes that arrive via git (commit/rollback/branch switch) where the worktree may be clean.
	uiChanged := needsUIBuild(paths)
	srvChanged := needsServerRestart(paths)

	if uiChanged {
		if err := s.buildUI(); err != nil {
			log.Printf("ui build failed: %v", err)
		}
	}
	if srvChanged {
		if err := s.restartServer(); err != nil {
			log.Printf("server restart failed: %v", err)
		}
	}

	if uiChanged || srvChanged {
		s.hub.Broadcast(map[string]any{"type": "reload", "reason": "head_changed"})
	}
	if onlyTriggers(paths) {
		s.hub.Broadcast(map[string]any{"type": "reload", "reason": "triggers_updated", "note": "no page reload needed"})
	}
}

func (s *Supervisor) pollLoop(stop <-chan struct{}) {
	var pending []string
	var lastDirty time.Time
	var lastSeen = map[string]bool{}

	t := time.NewTicker(s.pollEvery)
	defer t.Stop()

	for {
		select {
		case <-stop:
			return
		case <-t.C:
			// React to git HEAD changes even when the working tree is clean.
			// This catches quick edit+commit bursts, rollbacks, and branch switches.
			if lastDirty.IsZero() && len(pending) == 0 {
				if headOut, err := runCmd(s.repoDir, "git", "rev-parse", "HEAD"); err == nil {
					head := strings.TrimSpace(headOut)
					s.mu.Lock()
					prev := s.lastHead
					if prev == "" {
						s.lastHead = head
						prev = head
					}
					s.mu.Unlock()

					if head != "" && prev != "" && head != prev {
						diffOut, err := runCmd(s.repoDir, "git", "diff", "--name-only", prev, head)
						if err != nil {
							log.Printf("git diff failed (%s..%s): %v", prev, head, err)
							// Fallback: restart+rebuild as a safe default.
							s.handleCommittedChanges([]string{"src/server.ts", "src/ui/app.ts"})
						} else {
							var changed []string
							for _, line := range strings.Split(strings.TrimSpace(diffOut), "\n") {
								line = strings.TrimSpace(line)
								if line == "" {
									continue
								}
								changed = append(changed, line)
							}
							s.handleCommittedChanges(changed)
						}

						s.mu.Lock()
						s.lastHead = head
						s.mu.Unlock()
					}
				}
			}

			paths, err := s.gitDirtyPaths()
			if err != nil {
				log.Printf("git status failed: %v", err)
				continue
			}

			now := time.Now()
			if len(paths) > 0 {
				lastDirty = now
				// Track union (unique).
				for _, p := range paths {
					lastSeen[p] = true
				}
				pending = pending[:0]
				for p := range lastSeen {
					pending = append(pending, p)
				}
				continue
			}

			if !lastDirty.IsZero() && now.Sub(lastDirty) >= s.debounce && len(pending) > 0 {
				// Settled.
				settled := make([]string, 0, len(pending))
				settled = append(settled, pending...)
				pending = nil
				lastDirty = time.Time{}
				lastSeen = map[string]bool{}

				s.handleSettledChanges(settled)

				// Keep lastHead in sync; autoCommit updates it, but this also covers no-op commits.
				if headOut, err := runCmd(s.repoDir, "git", "rev-parse", "HEAD"); err == nil {
					s.mu.Lock()
					s.lastHead = strings.TrimSpace(headOut)
					s.mu.Unlock()
				}
			}
		}
	}
}

func (s *Supervisor) serveEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	id, ch := s.hub.Add()
	defer s.hub.Remove(id)

	// Initial ping.
	fmt.Fprintf(w, "data: %s\n\n", `{"type":"hello"}`)
	fl.Flush()

	keep := time.NewTicker(20 * time.Second)
	defer keep.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			fl.Flush()
		case <-keep.C:
			fmt.Fprintf(w, "data: %s\n\n", `{"type":"keepalive"}`)
			fl.Flush()
		}
	}
}

func readJSON(r io.Reader, v any) error {
	b, err := io.ReadAll(io.LimitReader(r, 1<<20))
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return errors.New("empty body")
	}
	return json.Unmarshal(b, v)
}

func (s *Supervisor) apiCommits(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	format := "%H\t%ct\t%s"
	out, err := runCmd(s.repoDir, "git", "log", "-n", strconv.Itoa(limit), "--pretty=format:"+format)
	if err != nil {
		http.Error(w, `{"error":"git log failed"}`, http.StatusInternalServerError)
		return
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	var commits []Commit
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		ts, _ := strconv.ParseInt(parts[1], 10, 64)
		commits = append(commits, Commit{SHA: parts[0], TS: ts, Subject: parts[2]})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"commits": commits})
}

func (s *Supervisor) rollbackTo(sha string) error {
	sha = strings.TrimSpace(sha)
	if sha == "" {
		return errors.New("sha is required")
	}
	// Hard reset is the whole point of rollback; auto-commit keeps history.
	if _, err := runCmd(s.repoDir, "git", "reset", "--hard", sha); err != nil {
		return err
	}
	if headOut, err := runCmd(s.repoDir, "git", "rev-parse", "HEAD"); err == nil {
		s.mu.Lock()
		s.lastHead = strings.TrimSpace(headOut)
		s.mu.Unlock()
	}
	// Best-effort rebuild/restart.
	_ = s.buildUI()
	_ = s.restartServer()
	s.hub.Broadcast(map[string]any{"type": "reload", "reason": "rollback"})
	return nil
}

func (s *Supervisor) apiRollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SHA string `json:"sha"`
	}
	if err := readJSON(r.Body, &body); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if err := s.rollbackTo(body.SHA); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Supervisor) apiRollbackLast(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	out, err := runCmd(s.repoDir, "git", "rev-parse", "HEAD~1")
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}
	if err := s.rollbackTo(strings.TrimSpace(out)); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Supervisor) serveIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	b, err := webFS.ReadFile("web/index.html")
	if err != nil {
		http.Error(w, "missing ui", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(b)
}

func mustAbs(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return a
}

func main() {
	var (
		repoDir   = flag.String("repo", ".", "path to agent-tide repo")
		appPort   = flag.Int("app-port", 4821, "port for main app server")
		supPort   = flag.Int("sup-port", 4822, "port for supervisor/rollback ui")
		debounce  = flag.Duration("debounce", 800*time.Millisecond, "debounce time before acting on changes")
		pollEvery = flag.Duration("poll", 500*time.Millisecond, "poll interval for git status")
	)
	flag.Parse()

	rdir := mustAbs(*repoDir)

	// Basic sanity: ensure .git exists.
	if _, err := os.Stat(filepath.Join(rdir, ".git")); err != nil {
		log.Fatalf("not a git repo: %s (missing .git)", rdir)
	}

	s := &Supervisor{
		repoDir:   rdir,
		appHost:   "127.0.0.1",
		appPort:   *appPort,
		supPort:   *supPort,
		debounce:  *debounce,
		pollEvery: *pollEvery,
		hub:       NewSSEHub(),
	}
	if headOut, err := runCmd(s.repoDir, "git", "rev-parse", "HEAD"); err == nil {
		s.lastHead = strings.TrimSpace(headOut)
	}

	if err := s.buildUI(); err != nil {
		log.Printf("initial ui build failed: %v", err)
	}
	if err := s.startServer(); err != nil {
		log.Printf("initial server start failed: %v", err)
	}

	stop := make(chan struct{})
	go s.pollLoop(stop)

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.serveIndex)
	mux.HandleFunc("/events", s.serveEvents)
	mux.HandleFunc("/api/commits", s.apiCommits)
	mux.HandleFunc("/api/rollback", s.apiRollback)
	mux.HandleFunc("/api/rollback-last", s.apiRollbackLast)

	addr := fmt.Sprintf("127.0.0.1:%d", s.supPort)
	log.Printf("supervisor ui: http://%s", addr)
	log.Printf("app:           http://127.0.0.1:%d", s.appPort)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}

	close(stop)
}
