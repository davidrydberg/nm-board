package tui

import (
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/davidrydberg/fleetwatch/internal/collect"
	"github.com/davidrydberg/fleetwatch/internal/fixtures"
	"github.com/davidrydberg/fleetwatch/internal/fleet"
)

var config = Config{Interval: 5 * time.Second, InactiveInterval: 30 * time.Second, FleetInterval: 15 * time.Second, PRInterval: 90 * time.Second}

const (
	apiPR    = "https://github.com/example-org/shop-api/pull/188"
	clientPR = "https://github.com/example-org/shop-web/pull/87"
	adminPR  = "https://github.com/example-org/shop-web/pull/71"
)

var (
	liveTasks     = tasks("cli-status-view", "dev-inventory", "mailer-send-limits", "pack-option-api", "pack-option-web")
	inactiveTasks = tasks("web-admin-console", "wiki-db-claims-check", "blog-explainer", "api-catalog-scope")
	allPRs        = []string{"pr:" + adminPR, "pr:" + apiPR, "pr:" + clientPR}
)

func tasks(ids ...string) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = "task:" + id
	}
	return out
}

func sorted(lists ...[]string) []string {
	out := slices.Concat(lists...)
	slices.Sort(out)
	return out
}

func eq[T any](t *testing.T, got, want T, what string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %#v, want %#v", what, got, want)
	}
}

// must unwraps a fixture parse, which never fails on a good fixture.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// fakeSource serves the fixtures and records every read.
type fakeSource struct {
	calls      []string
	fleetErr   error
	focusErr   error
	fleet      *collect.Fleet
	details    map[string]*fleet.Detail
	prs        map[string]*fleet.PR
	fetchedNow func() time.Time
}

func newFakeSource(t *testing.T) *fakeSource {
	b := must(fleet.ParseBearings(fixtures.Read(t, "bearings.json")))
	remote := fleet.ParseMeta(fixtures.Read(t, "remote-secondmate.meta"))
	apiMeta := fleet.ParseMeta("kind=ship\nmode=no-mistakes\nbranch=fm/pack-option-api\nherdr_session=default\nherdr_pane_id=w27:p1B\n")
	crew := func(f string) *fleet.CrewState { return must(fleet.ParseCrewState(fixtures.Read(t, f))) }
	pipeline := func(f string) *fleet.Pipeline { return must(fleet.ParsePipeline(fixtures.Read(t, f))) }
	status := func(f string) []fleet.StatusEntry { return fleet.ParseStatusLog(fixtures.Read(t, f)) }
	pr := func(f string) *fleet.PR { return must(fleet.ParsePR(fixtures.Read(t, f))) }
	return &fakeSource{
		fleet: &collect.Fleet{Bearings: b, Agents: fleet.BuildRoster(b, "/fm", map[string]*fleet.Meta{"spare": remote})},
		details: map[string]*fleet.Detail{
			"pack-option-api": {Meta: apiMeta, Crew: crew("crew-pack-option-api.txt"), Status: status("api.status"), Pipeline: pipeline("nm-gate.toon")},
			"pack-option-web": {
				Meta:     fleet.ParseMeta(fixtures.Read(t, "web.meta")),
				Crew:     crew("crew-pack-option-web.txt"),
				Status:   status("web.status"),
				Pipeline: pipeline("nm-ci-running.toon"),
			},
			"dev-inventory":        {Meta: fleet.ParseMeta(fixtures.Read(t, "scout.meta")), Crew: crew("crew-dev-inventory.txt"), Status: status("scout.status")},
			"mailer-send-limits":   {Crew: crew("crew-mailer-send-limits.txt")},
			"wiki-db-claims-check": {Crew: crew("crew-wiki-db-claims-check.txt")},
			"cli-status-view":      {Crew: crew("crew-cli-status-view.txt")},
		},
		prs: map[string]*fleet.PR{apiPR: pr("gh-open-green.json"), clientPR: pr("gh-no-checks.json"), adminPR: pr("gh-merged.json")},
	}
}

func (s *fakeSource) Fleet() (*collect.Fleet, error) {
	s.calls = append(s.calls, "fleet")
	if s.fleetErr != nil {
		return nil, s.fleetErr
	}
	return s.fleet, nil
}

func (s *fakeSource) Task(a fleet.Agent) *fleet.Detail {
	s.calls = append(s.calls, "task:"+a.ID)
	d := fleet.Detail{}
	if known := s.details[a.ID]; known != nil {
		d = *known
	}
	d.FetchedAt = s.fetchedNow()
	return &d
}

func (s *fakeSource) PR(url string) (*fleet.PR, error) {
	s.calls = append(s.calls, "pr:"+url)
	if pr := s.prs[url]; pr != nil {
		return pr, nil
	}
	return nil, errors.New("gh: not found")
}

func (s *fakeSource) Focus(session, pane string) error {
	s.calls = append(s.calls, "focus:"+session+":"+pane)
	return s.focusErr
}

func (s *fakeSource) take() []string {
	c := s.calls
	slices.Sort(c)
	s.calls = nil
	return c
}

// harness drives the model like the program does, against a fake clock: each
// effect runs at once through the same command Update would start, and its
// message goes straight back in.
type harness struct {
	t     *testing.T
	clock time.Time
	src   *fakeSource
	m     *Model
	quits int
}

func newHarness(t *testing.T, columns, rows int, start bool) *harness {
	h := &harness{t: t, clock: time.Unix(1792540000, 0), src: newFakeSource(t)}
	h.src.fetchedNow = func() time.Time { return h.clock }
	h.m = New(config, h.src, func() time.Time { return h.clock })
	h.send(tea.WindowSizeMsg{Width: columns, Height: rows})
	if start {
		h.run([]effect{{kind: readFleet}})
	}
	return h
}

func (h *harness) send(msg tea.Msg) {
	h.run(h.m.dispatch(msg))
}

func (h *harness) run(effects []effect) {
	for _, e := range effects {
		msg := h.m.cmd(e)()
		if _, ok := msg.(tea.QuitMsg); ok {
			h.quits++
			continue
		}
		h.send(msg)
	}
}

func (h *harness) advance(d time.Duration) {
	h.clock = h.clock.Add(d)
	h.send(tickMsg{})
}

func (h *harness) key(k tea.KeyType) {
	h.send(tea.KeyMsg{Type: k})
}

func (h *harness) rowIDs() []string {
	var ids []string
	for _, r := range h.m.rows {
		if r.isHeader() {
			ids = append(ids, "#"+r.header)
		} else {
			ids = append(ids, h.m.agents[r.agent].ID)
		}
	}
	return ids
}

func (h *harness) selectAgent(id string) {
	h.t.Helper()
	for range h.m.rows {
		h.key(tea.KeyUp)
	}
	for i := 0; i < len(h.m.rows) && h.m.selected != id; i++ {
		h.key(tea.KeyDown)
	}
	if h.m.selected != id {
		h.t.Fatalf("could not select %s", id)
	}
}

func (h *harness) detail() string {
	a, ok := h.m.selectedAgent()
	if !ok {
		h.t.Fatal("no agent selected")
	}
	return strings.Join(h.m.detailLines(a, 80), "\n")
}

var allRows = []string{
	"#captain decisions",
	"dev-inventory",
	"pack-option-api",
	"#firstmate",
	"blog-explainer",
	"#fleetwatch",
	"cli-status-view",
	"#mailer",
	"mailer-send-limits",
	"#shop-api",
	"api-catalog-scope",
	"#shop-web",
	"pack-option-web",
	"web-admin-console",
	"#shop-wiki",
	"wiki-db-claims-check",
	"#secondmates",
	"spare",
}

func TestStartupReadsTheFleetThenEachAgentAndPROnce(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	eq(t, h.src.take(), sorted([]string{"fleet"}, allPRs, liveTasks, inactiveTasks), "reads")
	eq(t, h.m.loaded, true, "loaded")
	eq(t, len(h.m.agents), 10, "agents")
	for url, e := range h.m.prs {
		if e.pr == nil || e.pending {
			t.Errorf("%s: pr %v pending %v", url, e.pr, e.pending)
		}
	}
}

func TestNoSourceIsReadTwiceAtOnce(t *testing.T) {
	h := newHarness(t, 140, 40, false)
	// While the first fleet read is in flight, a tick starts nothing.
	h.clock = h.clock.Add(time.Minute)
	eq(t, len(h.m.dispatch(tickMsg{})), 0, "effects while the fleet read is in flight")

	reads := h.m.dispatch(h.m.cmd(effect{kind: readFleet})())
	eq(t, h.src.take(), []string{"fleet"}, "reads")
	var names []string
	for _, e := range reads {
		switch e.kind {
		case readTask:
			names = append(names, "task:"+e.agent.ID)
		case readPR:
			names = append(names, "pr:"+e.url)
		}
	}
	eq(t, sorted(names), sorted(allPRs, liveTasks, inactiveTasks), "started reads")

	// Agent and PR reads are in flight and due again, but nothing restarts.
	h.clock = h.clock.Add(10 * time.Second)
	eq(t, len(h.m.dispatch(tickMsg{})), 0, "effects while reads are in flight")
}

func TestRefreshCadence(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.src.take()
	h.advance(3 * time.Second)
	eq(t, h.src.take(), []string(nil), "nothing due at 3s")
	h.advance(2 * time.Second)
	eq(t, h.src.take(), sorted(liveTasks), "live agents due at 5s")
	h.advance(10 * time.Second)
	eq(t, h.src.take(), sorted([]string{"fleet"}, liveTasks), "fleet and live agents due at 15s")
	h.advance(15 * time.Second)
	eq(t, h.src.take(), sorted([]string{"fleet"}, liveTasks, inactiveTasks), "inactive agents due at 30s")
	h.advance(60 * time.Second)
	got := h.src.take()
	if !slices.Contains(got, "pr:"+apiPR) || !slices.Contains(got, "pr:"+clientPR) {
		t.Error("open PRs are not re-read at 90s")
	}
	if slices.Contains(got, "pr:"+adminPR) {
		t.Error("a merged PR is re-read on the timer")
	}
}

func TestDecisionsArePinnedAndTheRestGroupedByProject(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	eq(t, h.rowIDs(), allRows, "rows")
	eq(t, h.m.selected, "dev-inventory", "the top agent is selected until the user moves")
	eq(t, h.m.cursor, 1, "cursor")
	eq(t, len(h.m.infos["pack-option-api"].decisions), 3, "decisions")
}

func TestNavigationSkipsHeadersAndStopsAtTheEnds(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.key(tea.KeyUp)
	eq(t, h.m.selected, "dev-inventory", "up at the top")
	h.key(tea.KeyDown)
	h.key(tea.KeyDown)
	eq(t, h.m.selected, "blog-explainer", "down skips the group header")
	for range h.m.rows {
		h.key(tea.KeyDown)
	}
	eq(t, h.m.selected, "spare", "down at the bottom")
	h.key(tea.KeyUp)
	eq(t, h.m.selected, "wiki-db-claims-check", "up skips the group header")
}

func TestOtherKeysDoNothing(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.src.take()
	for _, r := range "jkgGdr/" {
		h.send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	for _, k := range []tea.KeyType{tea.KeyPgDown, tea.KeyHome, tea.KeyEnd, tea.KeyEsc} {
		h.key(k)
	}
	eq(t, h.m.selected, "dev-inventory", "selection")
	eq(t, h.rowIDs(), allRows, "rows")
	eq(t, h.src.take(), []string(nil), "reads")
	eq(t, h.quits, 0, "quits")
}

func TestSelectionFollowsItsAgentWhenItRegroups(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.selectAgent("mailer-send-limits")
	d := *h.src.details["mailer-send-limits"]
	d.Status = fleet.ParseStatusLog("needs-decision [at=1792540000] [key=push-route]: grant write access or fork\n")
	h.send(taskMsg{id: "mailer-send-limits", detail: &d})
	eq(t, h.m.selected, "mailer-send-limits", "selected")
	eq(t, h.rowIDs()[h.m.cursor], "mailer-send-limits", "cursor row")
	if !slices.Contains(h.rowIDs()[:4], "mailer-send-limits") {
		t.Error("not pinned")
	}
}

func TestEnterFocusesTheSelectedAgentPane(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.src.take()
	h.selectAgent("pack-option-api")
	h.key(tea.KeyEnter)
	eq(t, h.src.take(), []string{"focus:default:w27:p1B"}, "focus")
	eq(t, h.m.flash, "focused pack-option-api in herdr", "flash")

	h.src.focusErr = errors.New("herdr: pane not found")
	h.key(tea.KeyEnter)
	eq(t, h.m.flash, "focus pack-option-api failed: herdr: pane not found", "failed flash")

	h.src.take()
	h.selectAgent("mailer-send-limits")
	h.key(tea.KeyEnter)
	eq(t, h.src.take(), []string(nil), "no pane, no focus call")
	eq(t, h.m.flash, "mailer-send-limits has no recorded herdr pane", "no pane flash")
}

func TestQAndCtrlCQuit(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	h.key(tea.KeyCtrlC)
	eq(t, h.quits, 2, "quits")
}

func TestFailedFleetReadKeepsTheLastGoodData(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.src.fleetErr = errors.New("fm-bearings-snapshot.sh: timed out")
	h.advance(15 * time.Second)
	eq(t, len(h.m.agents), 10, "agents")
	fresh := h.m.freshness(h.clock)
	for _, want := range []string{"fleet error: fm-bearings-snapshot.sh: timed out", "showing 15s ago"} {
		if !strings.Contains(fresh, want) {
			t.Errorf("freshness %q lacks %q", fresh, want)
		}
	}
	h.src.fleetErr = nil
	h.advance(15 * time.Second)
	eq(t, h.m.fleetErr, "", "fleet error cleared")
	h.clock = h.clock.Add(2 * time.Minute)
	if !strings.Contains(h.m.freshness(h.clock), "(stale)") {
		t.Error("old fleet data is not flagged stale")
	}
}

func TestFailedFirstFleetReadSaysSoAndRetries(t *testing.T) {
	h := newHarness(t, 140, 40, false)
	h.src.fleetErr = errors.New("fm-bearings-snapshot.sh: away window active")
	h.run([]effect{{kind: readFleet}})
	eq(t, h.m.loaded, false, "loaded")
	if !strings.Contains(strings.Join(h.m.listLines(), "\n"), "the fleet snapshot failed; retrying") {
		t.Error("the list does not report the failure")
	}
	h.src.fleetErr = nil
	h.advance(15 * time.Second)
	eq(t, h.m.loaded, true, "loaded after retry")
	eq(t, len(h.m.agents), 10, "agents")
}

func TestAgentsThatLeaveTheRosterDropTheirReads(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.src.fleet = &collect.Fleet{Bearings: h.src.fleet.Bearings, Agents: h.src.fleet.Agents[:1]}
	h.advance(15 * time.Second)
	var ids []string
	for id := range h.m.details {
		ids = append(ids, id)
	}
	eq(t, ids, []string{"web-admin-console"}, "details")
	if _, ok := h.m.prs[apiPR]; ok {
		t.Error("a gone agent's PR is still watched")
	}
	h.send(taskMsg{id: "pack-option-api", detail: &fleet.Detail{FetchedAt: h.clock}})
	if _, ok := h.m.details["pack-option-api"]; ok {
		t.Error("a late result for a gone agent was kept")
	}
}

func TestTheListKeepsTheSelectedRowAndItsHeaderOnScreen(t *testing.T) {
	h := newHarness(t, 140, 8, true)
	for range h.m.rows {
		h.key(tea.KeyDown)
	}
	visible := h.m.listLines()
	eq(t, len(visible), h.m.bodyHeight(), "visible rows")
	joined := strings.Join(visible, "\n")
	if !strings.Contains(joined, "spare") || !strings.Contains(joined, "SECONDMATES") {
		t.Errorf("list %q lacks the selection or its header", joined)
	}
}

func TestTheDetailPane(t *testing.T) {
	h := newHarness(t, 140, 40, true)
	h.selectAgent("pack-option-api")
	api := h.detail()
	for _, want := range []string{"WAITING ON THE CAPTAIN", "ask-user admin-toggle-overridden", "PIPELINE", "gate at review (awaiting_approval) · 2 finding(s)", "herdr default w27:p1B"} {
		if !strings.Contains(api, want) {
			t.Errorf("api detail lacks %q", want)
		}
	}
	h.selectAgent("pack-option-web")
	client := h.detail()
	for _, want := range []string{"PULL REQUEST", "#87 OPEN", "checks no checks", "ci running for 1d9h"} {
		if !strings.Contains(client, want) {
			t.Errorf("client detail lacks %q", want)
		}
	}
	h.selectAgent("spare")
	sm := h.detail()
	for _, want := range []string{"ABSENT", "remote home on buildbox"} {
		if !strings.Contains(sm, want) {
			t.Errorf("secondmate detail lacks %q", want)
		}
	}
}

// The program wiring: Update turns a fleet result into background reads
// through the source, and View shows what they return.
func TestUpdateRunsReadsThroughTheSourceAndViewShowsThem(t *testing.T) {
	src := newFakeSource(t)
	src.fetchedNow = time.Now
	src.prs = nil
	m := New(config, src, time.Now)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	pending := []tea.Cmd{m.cmd(effect{kind: readFleet})}
	for len(pending) > 0 {
		cmd := pending[0]
		pending = pending[1:]
		if cmd == nil {
			continue
		}
		switch msg := cmd().(type) {
		case tea.BatchMsg:
			pending = append(pending, msg...)
		default:
			_, next := m.Update(msg)
			pending = append(pending, next)
		}
	}
	if !slices.Contains(src.calls, "task:cli-status-view") {
		t.Error("agent state was not read")
	}
	view := m.View()
	for _, want := range []string{"CAPTAIN DECISIONS", "pack-option-api", "unreadable)", "↑/↓ select · enter focus in herdr · q quit"} {
		if !strings.Contains(view, want) {
			t.Errorf("view lacks %q:\n%s", want, view)
		}
	}
	eq(t, len(strings.Split(view, "\n")), 30, "view height")
}
