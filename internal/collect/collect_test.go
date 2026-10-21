package collect

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/davidrydberg/fleetwatch/internal/fixtures"
	"github.com/davidrydberg/fleetwatch/internal/fleet"
)

func eq[T any](t *testing.T, got, want T, what string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %#v, want %#v", what, got, want)
	}
}

// fakeRunner answers commands from canned output keyed by command basename.
type fakeRunner struct {
	mu     sync.Mutex
	out    map[string]string
	errors map[string]string
	cmds   []Cmd
}

func (f *fakeRunner) run(c Cmd, _ time.Duration) Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, c)
	key := filepath.Base(c.Name)
	return Result{Stdout: f.out[key], Error: f.errors[key]}
}

// home lays out a firstmate home holding one task's state files.
func home(t *testing.T, task string, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "state"), 0o755); err != nil {
		t.Fatal(err)
	}
	for ext, text := range files {
		if err := os.WriteFile(filepath.Join(dir, "state", task+ext), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func source(h, cacheDir string, f *fakeRunner) *FleetSource {
	return NewFleetSource(Config{
		Home: h, CacheDir: cacheDir, FleetTimeout: time.Second, TaskTimeout: time.Second,
		PRTimeout: time.Second, FocusTimeout: time.Second, Concurrency: 2, PRConcurrency: 1,
	}, f.run, time.Now)
}

func agent(id, h string) fleet.Agent {
	return fleet.Agent{ID: id, TaskID: id, Home: h, Owner: fleet.MainOwner, Kind: "ship"}
}

func TestBearingsCmd(t *testing.T) {
	c := BearingsCmd("/fm", "/cache/fleetwatch/summary")
	eq(t, c, Cmd{
		Name: "/fm/bin/fm-bearings-snapshot.sh",
		Args: []string{"--json", "--all-in-flight"},
		Dir:  "/fm",
		Env:  map[string]string{"FM_HOME": "/fm", "FM_BEARINGS_DECISIONS": "1000", "FM_SNAPSHOT_CACHE_DIR": "/cache/fleetwatch/summary"},
	}, "bearings cmd")
}

func TestFleetReadsSecondmateMetaAndPreparesCacheParent(t *testing.T) {
	h := home(t, "spare", map[string]string{".meta": fixtures.Read(t, "remote-secondmate.meta")})
	cacheDir := filepath.Join(t.TempDir(), "fleetwatch", "summary")
	f, err := source(h, cacheDir, &fakeRunner{out: map[string]string{"fm-bearings-snapshot.sh": fixtures.Read(t, "bearings.json")}}).Fleet()
	if err != nil {
		t.Fatal(err)
	}
	sm := f.Agents[len(f.Agents)-1]
	eq(t, []any{sm.ID, sm.Absent}, []any{"spare", true}, "secondmate")
	if info, err := os.Stat(filepath.Dir(cacheDir)); err != nil || !info.IsDir() {
		t.Errorf("cache parent not created: %v", err)
	}
}

func TestFleetSurfacesCommandAndSchemaErrors(t *testing.T) {
	_, err := source(t.TempDir(), "", &fakeRunner{errors: map[string]string{"fm-bearings-snapshot.sh": "fm-bearings-snapshot.sh: away window active"}}).Fleet()
	if err == nil || !strings.Contains(err.Error(), "away window active") {
		t.Errorf("error %v", err)
	}
	_, err = source(t.TempDir(), "", &fakeRunner{out: map[string]string{"fm-bearings-snapshot.sh": `{"schema":"other"}`}}).Fleet()
	if err == nil || !strings.Contains(err.Error(), "schema") {
		t.Errorf("error %v", err)
	}
}

func TestTaskReadsFilesThenCrewStateThenItsRun(t *testing.T) {
	worktree := t.TempDir()
	h := home(t, "pack-option-api", map[string]string{
		".meta":       "worktree=" + worktree + "\nkind=ship\nmode=no-mistakes\nbranch=fm/pack-option-api\nherdr_session=default\nherdr_pane_id=w27:p1B\n",
		".status":     fixtures.Read(t, "api.status"),
		".busy-state": fixtures.Read(t, "idle.busy-state"),
	})
	run := &fakeRunner{out: map[string]string{
		"fm-crew-state.sh": fixtures.Read(t, "crew-pack-option-api.txt"),
		"no-mistakes":      fixtures.Read(t, "nm-gate.toon"),
	}}
	d := source(h, "", run).Task(agent("pack-option-api", h))
	eq(t, d.Meta.HerdrPane, "w27:p1B", "pane")
	eq(t, len(d.Status), 5, "status entries")
	eq(t, d.Busy.State, "idle", "busy")
	eq(t, d.StatusModified.IsZero(), false, "status modified")
	eq(t, d.Crew.State, "parked", "crew")
	eq(t, d.Pipeline.Gate.Step, "review", "gate")
	eq(t, len(run.cmds), 2, "commands")
	eq(t, run.cmds[0], Cmd{Name: filepath.Join(h, "bin", "fm-crew-state.sh"), Args: []string{"pack-option-api"}, Dir: h, Env: map[string]string{"FM_HOME": h}}, "crew cmd")
	eq(t, run.cmds[1].Dir, worktree, "no-mistakes dir")
	eq(t, run.cmds[1].Args, []string{"axi", "status", "--run", "01JXB56R3S8P2RMK6RQF9R4EN9"}, "no-mistakes args")
}

func TestRunOnAnotherBranchIsNotTheTasks(t *testing.T) {
	worktree := t.TempDir()
	h := home(t, "web-admin-console", map[string]string{".meta": "worktree=" + worktree + "\nkind=ship\nmode=no-mistakes\nbranch=fm/web-admin-console\n"})
	run := &fakeRunner{out: map[string]string{
		"fm-crew-state.sh": "state: working · source: pane · harness busy (claude-hook)\n",
		"no-mistakes":      fixtures.Read(t, "nm-cancelled.toon"),
	}}
	d := source(h, "", run).Task(agent("web-admin-console", h))
	eq(t, d.Pipeline.NoRun, true, "no run")
	eq(t, d.Pipeline.Note, "latest run is on fm/web-admin-dev-sync, not this task's branch", "note")
	eq(t, run.cmds[1].Args, []string{"axi", "status"}, "args")
}

func TestScoutWithoutRunIDHasNoPipelineRead(t *testing.T) {
	h := home(t, "dev-inventory", map[string]string{".meta": fixtures.Read(t, "scout.meta"), ".status": fixtures.Read(t, "scout.status")})
	run := &fakeRunner{errors: map[string]string{"fm-crew-state.sh": "fm-crew-state.sh: timed out"}}
	d := source(h, "", run).Task(agent("dev-inventory", h))
	eq(t, d.Crew == nil, true, "no crew state")
	eq(t, d.CrewError, "fm-crew-state.sh: timed out", "crew error")
	eq(t, d.Pipeline == nil, true, "no pipeline")
	eq(t, len(run.cmds), 1, "commands")
}

func TestAbsentAgentsAndRemoteMetasRunNoCommands(t *testing.T) {
	run := &fakeRunner{}
	absent := agent("spare", "/fm")
	absent.Absent = true
	eq(t, source("/fm", "", run).Task(absent).Meta == nil, true, "absent meta")
	h := home(t, "spare", map[string]string{".meta": fixtures.Read(t, "remote-secondmate.meta")})
	d := source(h, "", run).Task(agent("spare", h))
	eq(t, d.Meta.RemoteHost, "buildbox", "remote host")
	eq(t, len(run.cmds), 0, "commands")
}

func TestPR(t *testing.T) {
	run := &fakeRunner{out: map[string]string{"gh": fixtures.Read(t, "gh-open-green.json")}}
	url := "https://github.com/example-org/shop-api/pull/188"
	pr, err := source("/fm", "", run).PR(url)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, pr.Number, 188, "number")
	eq(t, run.cmds[0].Args, []string{"pr", "view", url, "--json", fleet.PRFields}, "args")
	_, err = source("/fm", "", &fakeRunner{errors: map[string]string{"gh": "gh: HTTP 404"}}).PR(url)
	if err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Errorf("error %v", err)
	}
}

func TestFocusNamesTheSessionInBothPlaces(t *testing.T) {
	eq(t, FocusCmd("default", "wBR:p2"), Cmd{
		Name: "herdr",
		Args: []string{"agent", "focus", "wBR:p2", "--session", "default"},
		Env:  map[string]string{"HERDR_SESSION": "default"},
	}, "with session")
	eq(t, FocusCmd("", "wBR:p2"), Cmd{Name: "herdr", Args: []string{"agent", "focus", "wBR:p2"}}, "without session")
}

func TestReadTailStartsAtAWholeLine(t *testing.T) {
	file := filepath.Join(t.TempDir(), "log")
	if err := os.WriteFile(file, []byte("first line\nsecond line\nthird\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	text, modified, err := ReadTail(file, 14)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, text, "third\n", "tail")
	eq(t, modified.IsZero(), false, "modified")
	text, _, _ = ReadTail(file, 1024)
	eq(t, text, "first line\nsecond line\nthird\n", "whole file")
}

func TestExecRunnerKillsTheProcessGroupOnTimeout(t *testing.T) {
	start := time.Now()
	// The background child keeps stdout open; the bound must still hold.
	r := ExecRunner(Cmd{Name: "sh", Args: []string{"-c", "sleep 30 & sleep 30"}}, 200*time.Millisecond)
	eq(t, r.Error, "sh: timed out", "error")
	if time.Since(start) > 5*time.Second {
		t.Error("the run outlived its bound")
	}
}

func TestExecRunnerReportsStderrAndKeepsStdout(t *testing.T) {
	r := ExecRunner(Cmd{Name: "sh", Args: []string{"-c", "echo partial; echo 'boom happened' >&2; exit 3"}}, 5*time.Second)
	eq(t, r, Result{Stdout: "partial\n", Error: "sh: boom happened"}, "result")
	missing := ExecRunner(Cmd{Name: "fleetwatch-no-such-command"}, 5*time.Second)
	if !strings.HasPrefix(missing.Error, "fleetwatch-no-such-command: ") || !strings.Contains(missing.Error, "not found") {
		t.Errorf("error %q", missing.Error)
	}
}
