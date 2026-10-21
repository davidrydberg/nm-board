// Package tui is the fleetwatch Bubble Tea program. The update logic never
// runs a command: dispatch returns effects, Update turns them into background
// commands against a Source, and their results come back as messages. That
// keeps every read off the render path and the update logic testable without
// a terminal.
package tui

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/davidrydberg/fleetwatch/internal/collect"
	"github.com/davidrydberg/fleetwatch/internal/fleet"
)

const tickEvery = time.Second

// Config is how often each source is re-read.
type Config struct {
	// Interval is how often each live agent's local state is re-read.
	Interval time.Duration
	// InactiveInterval is the same for done, unknown, and absent agents.
	InactiveInterval time.Duration
	// FleetInterval is how often the bearings snapshot is re-read.
	FleetInterval time.Duration
	// PRInterval is how often an open PR and its checks are re-read.
	PRInterval time.Duration
}

type effectKind int

const (
	readFleet effectKind = iota
	readTask
	readPR
	focusPane
	quit
)

type effect struct {
	kind    effectKind
	agent   fleet.Agent
	url     string
	session string
	pane    string
}

type (
	tickMsg  struct{}
	fleetMsg struct {
		fleet *collect.Fleet
		err   error
	}
	taskMsg struct {
		id     string
		detail *fleet.Detail
	}
	prMsg struct {
		url string
		pr  *fleet.PR
		err error
	}
	focusMsg struct {
		id  string
		err error
	}
)

type prEntry struct {
	pr      *fleet.PR
	err     string
	at      time.Time // last successful read
	done    time.Time // last attempt finished
	pending bool
}

// Model is the fleetwatch view state.
type Model struct {
	cfg Config
	src collect.Source
	now func() time.Time

	bearings  *fleet.Bearings
	agents    []fleet.Agent
	loaded    bool
	fleetAt   time.Time
	fleetDone time.Time
	fleetErr  string
	// The first fleet read starts with the program, so the model begins with
	// it in flight.
	fleetBusy bool

	details     map[string]*fleet.Detail
	taskDone    map[string]time.Time
	taskPending map[string]bool
	prs         map[string]*prEntry

	infos    map[string]info
	rows     []row
	cursor   int // index into rows; always an agent row when any exist
	selected string
	chosen   bool // the user has moved the selection
	listTop  int

	columns int
	height  int
	flash   string
	flashAt time.Time
}

func New(cfg Config, src collect.Source, now func() time.Time) *Model {
	return &Model{
		cfg:         cfg,
		src:         src,
		now:         now,
		bearings:    &fleet.Bearings{},
		fleetBusy:   true,
		details:     map[string]*fleet.Detail{},
		taskDone:    map[string]time.Time{},
		taskPending: map[string]bool{},
		prs:         map[string]*prEntry{},
		infos:       map[string]info{},
	}
}

func tick() tea.Cmd {
	return tea.Tick(tickEvery, func(time.Time) tea.Msg { return tickMsg{} })
}

// Init starts the first fleet read and the refresh clock.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.cmd(effect{kind: readFleet}), tick())
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	cmds := []tea.Cmd{}
	for _, e := range m.dispatch(msg) {
		cmds = append(cmds, m.cmd(e))
	}
	if _, ok := msg.(tickMsg); ok {
		cmds = append(cmds, tick())
	}
	return m, tea.Batch(cmds...)
}

// cmd runs one effect through the source in the background.
func (m *Model) cmd(e effect) tea.Cmd {
	switch e.kind {
	case readFleet:
		return func() tea.Msg {
			f, err := m.src.Fleet()
			return fleetMsg{fleet: f, err: err}
		}
	case readTask:
		return func() tea.Msg { return taskMsg{id: e.agent.ID, detail: m.src.Task(e.agent)} }
	case readPR:
		return func() tea.Msg {
			pr, err := m.src.PR(e.url)
			return prMsg{url: e.url, pr: pr, err: err}
		}
	case focusPane:
		return func() tea.Msg { return focusMsg{id: e.agent.ID, err: m.src.Focus(e.session, e.pane)} }
	}
	return tea.Quit
}

func (m *Model) dispatch(msg tea.Msg) []effect {
	var effects []effect
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.columns = msg.Width
		m.height = msg.Height
	case tickMsg:
		effects = m.schedule()
	case fleetMsg:
		m.fleetBusy = false
		m.fleetDone = m.now()
		if msg.err != nil {
			m.fleetErr = msg.err.Error()
		} else {
			m.fleetErr = ""
			m.fleetAt = m.fleetDone
			m.loaded = true
			m.bearings = msg.fleet.Bearings
			m.agents = msg.fleet.Agents
			m.pruneGone()
			m.derive()
		}
		effects = m.schedule()
	case taskMsg:
		delete(m.taskPending, msg.id)
		if !m.inRoster(msg.id) {
			break
		}
		m.taskDone[msg.id] = m.now()
		m.details[msg.id] = msg.detail
		m.derive()
		effects = m.schedule()
	case prMsg:
		e := m.prs[msg.url]
		if e == nil {
			break
		}
		e.pending = false
		e.done = m.now()
		if msg.err != nil {
			e.err = msg.err.Error()
		} else {
			e.pr = msg.pr
			e.err = ""
			e.at = e.done
		}
	case focusMsg:
		if msg.err != nil {
			m.setFlash("focus " + msg.id + " failed: " + msg.err.Error())
		} else {
			m.setFlash("focused " + msg.id + " in herdr")
		}
	case tea.KeyMsg:
		effects = m.key(msg)
	}
	m.layout()
	return effects
}

// schedule starts every read that is due and not already running, so no
// command ever blocks the view and no source is read twice at once.
func (m *Model) schedule() []effect {
	now := m.now()
	var effects []effect
	if !m.fleetBusy && (m.fleetDone.IsZero() || now.Sub(m.fleetDone) >= m.cfg.FleetInterval) {
		m.fleetBusy = true
		effects = append(effects, effect{kind: readFleet})
	}
	for _, a := range m.agents {
		if a.Absent || m.taskPending[a.ID] {
			continue
		}
		every := m.cfg.Interval
		if m.infos[a.ID].inactive {
			every = m.cfg.InactiveInterval
		}
		if done, ok := m.taskDone[a.ID]; ok && now.Sub(done) < every {
			continue
		}
		m.taskPending[a.ID] = true
		effects = append(effects, effect{kind: readTask, agent: a})
	}
	for url, e := range m.prs {
		if e.pending {
			continue
		}
		if !e.done.IsZero() && (now.Sub(e.done) < m.cfg.PRInterval || (e.pr != nil && e.pr.Terminal())) {
			continue
		}
		e.pending = true
		effects = append(effects, effect{kind: readPR, url: url})
	}
	return effects
}

func (m *Model) key(msg tea.KeyMsg) []effect {
	switch msg.String() {
	case "ctrl+c", "q":
		return []effect{{kind: quit}}
	case "up":
		m.move(-1)
	case "down":
		m.move(1)
	case "enter":
		return m.focusSelected()
	}
	return nil
}

func (m *Model) focusSelected() []effect {
	a, ok := m.selectedAgent()
	if !ok {
		return nil
	}
	d := m.details[a.ID]
	if a.Absent || d == nil || d.Meta == nil || d.Meta.HerdrPane == "" {
		m.setFlash(a.ID + " has no recorded herdr pane")
		return nil
	}
	return []effect{{kind: focusPane, agent: a, session: d.Meta.HerdrSession, pane: d.Meta.HerdrPane}}
}

func (m *Model) setFlash(s string) {
	m.flash = s
	m.flashAt = m.now()
}

func (m *Model) inRoster(id string) bool {
	for _, a := range m.agents {
		if a.ID == id {
			return true
		}
	}
	return false
}

// pruneGone drops cached reads for agents no longer in the roster.
func (m *Model) pruneGone() {
	for id := range m.details {
		if !m.inRoster(id) {
			delete(m.details, id)
			delete(m.taskDone, id)
		}
	}
}

// derive recomputes per-agent info, registers PRs to watch, and rebuilds rows.
func (m *Model) derive() {
	m.infos = map[string]info{}
	wanted := map[string]bool{}
	for _, a := range m.agents {
		inf := deriveInfo(a, m.details[a.ID], m.bearings)
		m.infos[a.ID] = inf
		if inf.prURL != "" {
			wanted[inf.prURL] = true
			if m.prs[inf.prURL] == nil {
				m.prs[inf.prURL] = &prEntry{}
			}
		}
	}
	for url, e := range m.prs {
		if !wanted[url] && !e.pending {
			delete(m.prs, url)
		}
	}
	m.rebuild()
}

// rebuild regroups rows and keeps the selection on the same agent. Until the
// user picks one, the selection stays on the top row as groups fill in.
func (m *Model) rebuild() {
	m.rows = buildRows(m.agents, m.infos)
	if m.chosen {
		for i, r := range m.rows {
			if !r.isHeader() && m.agents[r.agent].ID == m.selected {
				m.cursor = i
				return
			}
		}
	} else {
		m.cursor = 0
	}
	m.cursor = max(min(m.cursor, len(m.rows)-1), 0)
	m.settle(1)
}

// move shifts the selection by one agent row, skipping headers.
func (m *Model) move(step int) {
	if len(m.rows) == 0 {
		return
	}
	m.chosen = true
	next := m.cursor + step
	for next >= 0 && next < len(m.rows) && m.rows[next].isHeader() {
		next += step
	}
	if next >= 0 && next < len(m.rows) {
		m.cursor = next
	}
	m.settle(step)
}

// settle moves the cursor off a header and records the selected agent.
func (m *Model) settle(step int) {
	for _, dir := range []int{step, -step} {
		for i := m.cursor; i >= 0 && i < len(m.rows); i += dir {
			if r := m.rows[i]; !r.isHeader() {
				m.cursor = i
				m.selected = m.agents[r.agent].ID
				return
			}
		}
	}
	m.selected = ""
}

func (m *Model) selectedAgent() (fleet.Agent, bool) {
	if m.cursor < len(m.rows) && !m.rows[m.cursor].isHeader() {
		return m.agents[m.rows[m.cursor].agent], true
	}
	return fleet.Agent{}, false
}

func (m *Model) listWidth() int {
	w := min(max(m.columns*2/5, 34), 60)
	return max(min(w, m.columns-20), 10)
}

func (m *Model) detailWidth() int {
	return max(m.columns-m.listWidth()-2, 10)
}

func (m *Model) bodyHeight() int {
	return max(m.height-2, 1)
}

// layout keeps the selected row and its group header on screen.
func (m *Model) layout() {
	h := m.bodyHeight()
	if m.cursor < m.listTop {
		m.listTop = m.cursor
	}
	if m.cursor >= m.listTop+h {
		m.listTop = m.cursor - h + 1
	}
	if m.cursor > 0 && m.rows[m.cursor-1].isHeader() && m.cursor-1 < m.listTop {
		m.listTop = m.cursor - 1
	}
	m.listTop = max(min(m.listTop, len(m.rows)-h), 0)
}
