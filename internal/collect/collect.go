// Package collect reads fleet state from a firstmate home, no-mistakes,
// GitHub, and herdr. Every read is bounded by a timeout; nothing here writes
// to firstmate state.
package collect

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/davidrydberg/fleetwatch/internal/fleet"
)

// Config bounds every command fleetwatch runs.
type Config struct {
	Home string
	// CacheDir receives the bearings snapshot's parent-side remote summary
	// cache, so refreshing never writes into the firstmate home's state/.
	CacheDir      string
	FleetTimeout  time.Duration
	TaskTimeout   time.Duration
	PRTimeout     time.Duration
	FocusTimeout  time.Duration
	Concurrency   int // concurrent local commands
	PRConcurrency int // concurrent GitHub reads
}

// Fleet is one bearings read and the agents it yields.
type Fleet struct {
	Bearings *fleet.Bearings
	Agents   []fleet.Agent
}

// Source is everything the view reads. The view calls it only from
// background commands, never while rendering.
type Source interface {
	Fleet() (*Fleet, error)
	Task(a fleet.Agent) *fleet.Detail
	PR(url string) (*fleet.PR, error)
	Focus(session, pane string) error
}

// BearingsCmd is the snapshot command. Decisions are uncapped so a captain
// decision is never dropped from the view by the default display bound.
func BearingsCmd(home, cacheDir string) Cmd {
	env := map[string]string{"FM_HOME": home, "FM_BEARINGS_DECISIONS": "1000"}
	if cacheDir != "" {
		env["FM_SNAPSHOT_CACHE_DIR"] = cacheDir
	}
	return Cmd{
		Name: filepath.Join(home, "bin", "fm-bearings-snapshot.sh"),
		Args: []string{"--json", "--all-in-flight"},
		Dir:  home,
		Env:  env,
	}
}

// FocusCmd focuses a herdr pane. herdr routes reliably only when the session
// is named both in HERDR_SESSION and as a trailing --session flag.
func FocusCmd(session, pane string) Cmd {
	if session == "" {
		return Cmd{Name: "herdr", Args: []string{"agent", "focus", pane}}
	}
	return Cmd{
		Name: "herdr",
		Args: []string{"agent", "focus", pane, "--session", session},
		Env:  map[string]string{"HERDR_SESSION": session},
	}
}

// FleetSource is the Source backed by real commands and files.
type FleetSource struct {
	cfg    Config
	run    Runner
	now    func() time.Time
	local  chan struct{}
	remote chan struct{}
}

func NewFleetSource(cfg Config, run Runner, now func() time.Time) *FleetSource {
	return &FleetSource{
		cfg:    cfg,
		run:    run,
		now:    now,
		local:  make(chan struct{}, max(cfg.Concurrency, 1)),
		remote: make(chan struct{}, max(cfg.PRConcurrency, 1)),
	}
}

// limited runs one command while holding a slot of sem.
func (s *FleetSource) limited(sem chan struct{}, c Cmd, timeout time.Duration) Result {
	sem <- struct{}{}
	defer func() { <-sem }()
	return s.run(c, timeout)
}

func (s *FleetSource) Fleet() (*Fleet, error) {
	if s.cfg.CacheDir != "" {
		if err := os.MkdirAll(filepath.Dir(s.cfg.CacheDir), 0o700); err != nil {
			return nil, err
		}
	}
	r := s.run(BearingsCmd(s.cfg.Home, s.cfg.CacheDir), s.cfg.FleetTimeout)
	b, err := fleet.ParseBearings(r.Stdout)
	if err != nil {
		if r.Error != "" {
			return nil, errors.New(r.Error)
		}
		return nil, err
	}
	smMeta := map[string]*fleet.Meta{}
	owners := map[string]bool{}
	for _, sm := range b.Secondmates {
		owners[sm.ID] = true
	}
	for _, f := range b.InFlight {
		if owner, _, ok := strings.Cut(f.ID, "/"); ok {
			owners[owner] = true
		}
	}
	for id := range owners {
		if text, err := os.ReadFile(filepath.Join(s.cfg.Home, "state", id+".meta")); err == nil {
			smMeta[id] = fleet.ParseMeta(string(text))
		}
	}
	return &Fleet{Bearings: b, Agents: fleet.BuildRoster(b, s.cfg.Home, smMeta)}, nil
}

// Task reads one agent's meta, status log, busy state, crew state, and
// no-mistakes run.
func (s *FleetSource) Task(a fleet.Agent) *fleet.Detail {
	d := &fleet.Detail{FetchedAt: s.now()}
	if a.Absent || a.Home == "" {
		return d
	}
	state := filepath.Join(a.Home, "state")
	if text, err := os.ReadFile(filepath.Join(state, a.TaskID+".meta")); err != nil {
		d.MetaError = err.Error()
	} else {
		d.Meta = fleet.ParseMeta(string(text))
	}
	if text, modified, err := ReadTail(filepath.Join(state, a.TaskID+".status"), 64*1024); err == nil {
		d.Status = fleet.ParseStatusLog(text)
		d.StatusModified = modified
	} else if !errors.Is(err, os.ErrNotExist) {
		d.StatusError = err.Error()
	}
	if text, err := os.ReadFile(filepath.Join(state, a.TaskID+".busy-state")); err == nil {
		// An unknown record version reads as no busy state.
		d.Busy, _ = fleet.ParseBusy(string(text))
	}
	if d.Meta != nil && d.Meta.RemoteHost != "" {
		return d
	}

	crew := s.limited(s.local, Cmd{
		Name: filepath.Join(a.Home, "bin", "fm-crew-state.sh"),
		Args: []string{a.TaskID},
		Dir:  a.Home,
		Env:  map[string]string{"FM_HOME": a.Home},
	}, s.cfg.TaskTimeout)
	if c, err := fleet.ParseCrewState(crew.Stdout); err != nil {
		d.CrewError = crew.Error
		if d.CrewError == "" {
			d.CrewError = err.Error()
		}
	} else {
		d.Crew = c
	}

	runID := ""
	if d.Crew != nil {
		runID = d.Crew.RunID
	}
	if runID == "" && (d.Meta == nil || d.Meta.Mode != "no-mistakes") {
		return d
	}
	if p, err := s.pipeline(a, d.Meta, runID); err != nil {
		d.PipelineError = err.Error()
	} else {
		d.Pipeline = p
	}
	return d
}

func (s *FleetSource) pipeline(a fleet.Agent, meta *fleet.Meta, runID string) (*fleet.Pipeline, error) {
	dir := a.Home
	if meta != nil && isDir(meta.Worktree) {
		dir = meta.Worktree
	} else if runID == "" {
		return fleet.NoRun("worktree gone", ""), nil
	}
	args := []string{"axi", "status"}
	if runID != "" {
		args = append(args, "--run", runID)
	}
	r := s.limited(s.local, Cmd{Name: "no-mistakes", Args: args, Dir: dir}, s.cfg.TaskTimeout)
	p, err := fleet.ParsePipeline(r.Stdout)
	if err != nil {
		if r.Error != "" {
			return nil, errors.New(r.Error)
		}
		return nil, err
	}
	// Without a run id from crew-state, the worktree's latest run counts only
	// when it is on the task's own branch.
	if runID == "" && !p.NoRun && meta.Branch != "" && p.Branch != meta.Branch {
		return fleet.NoRun("latest run is on "+p.Branch+", not this task's branch", meta.Branch), nil
	}
	return p, nil
}

// PR reads one pull request and its checks.
func (s *FleetSource) PR(url string) (*fleet.PR, error) {
	r := s.limited(s.remote, Cmd{Name: "gh", Args: []string{"pr", "view", url, "--json", fleet.PRFields}}, s.cfg.PRTimeout)
	if r.Error != "" {
		return nil, errors.New(r.Error)
	}
	return fleet.ParsePR(r.Stdout)
}

func (s *FleetSource) Focus(session, pane string) error {
	if r := s.run(FocusCmd(session, pane), s.cfg.FocusTimeout); r.Error != "" {
		return errors.New(r.Error)
	}
	return nil
}

// ReadTail returns at most limit trailing bytes of a file, starting at a
// whole line, and the file's modification time.
func ReadTail(file string, limit int64) (string, time.Time, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", time.Time{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", time.Time{}, err
	}
	offset := max(info.Size()-limit, 0)
	buf := make([]byte, info.Size()-offset)
	if _, err := f.ReadAt(buf, offset); err != nil && err != io.EOF {
		return "", time.Time{}, err
	}
	text := string(buf)
	if offset > 0 {
		if _, rest, ok := strings.Cut(text, "\n"); ok {
			text = rest
		} else {
			text = ""
		}
	}
	return text, info.ModTime(), nil
}

func isDir(p string) bool {
	if p == "" {
		return false
	}
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
