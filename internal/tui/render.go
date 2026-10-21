package tui

// Pure text rendering of the model: header, list, detail pane, and footer as
// styled lines. View lays these out; tests read them directly.

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"github.com/davidrydberg/fleetwatch/internal/fleet"
)

const (
	statusTail = 6
	flashFor   = 5 * time.Second
	ellipsis   = "…"
)

type style = lipgloss.Style

var (
	dimStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	boldStyle     = lipgloss.NewStyle().Bold(true)
	accentStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("12"))
	greenStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	warnStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	errorStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	decisionStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("13"))
	headerStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("8"))
	cursorStyle   = lipgloss.NewStyle().Reverse(true)
)

func dim(s string) string    { return dimStyle.Render(s) }
func bold(s string) string   { return boldStyle.Render(s) }
func warn(s string) string   { return warnStyle.Render(s) }
func fail(s string) string   { return errorStyle.Render(s) }
func accent(s string) string { return accentStyle.Render(s) }

func stateStyle(state string) style {
	switch state {
	case "working":
		return greenStyle
	case "parked", "paused":
		return warnStyle
	case "blocked", "failed":
		return errorStyle
	}
	return dimStyle
}

func stateIcon(state string, hasDecision bool) string {
	if hasDecision {
		return "⚑"
	}
	switch state {
	case "working":
		return "●"
	case "parked", "paused":
		return "◐"
	case "blocked", "failed":
		return "✗"
	case "done":
		return "✓"
	case "absent":
		return "○"
	}
	return "?"
}

// age renders a duration compactly: 42s, 7m, 3h12m, 2d4h.
func age(d time.Duration) string {
	s := max(int(d/time.Second), 0)
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	m := s / 60
	if m < 60 {
		return fmt.Sprintf("%dm", m)
	}
	h := m / 60
	if h < 24 {
		return fmt.Sprintf("%dh%02dm", h, m-60*h)
	}
	days := h / 24
	return fmt.Sprintf("%dd%dh", days, h-24*days)
}

// since renders "<age> ago", or "never" for no time.
func since(now, t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	return age(now.Sub(t)) + " ago"
}

func truncate(s string, width int) string {
	return ansi.Truncate(s, max(width, 0), ellipsis)
}

func pad(s string, width int) string {
	return s + strings.Repeat(" ", max(width-ansi.StringWidth(s), 0))
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

// View lays out the header, the list beside the detail pane, and the footer.
func (m *Model) View() string {
	h := m.bodyHeight()
	list := m.listLines()
	var detail []string
	if a, ok := m.selectedAgent(); ok {
		detail = m.detailLines(a, m.detailWidth())
	} else if m.loaded {
		detail = []string{"Select an agent."}
	} else {
		detail = []string{"Waiting for the first fleet snapshot."}
	}
	lines := []string{m.header()}
	for i := range h {
		l, d := "", ""
		if i < len(list) {
			l = list[i]
		}
		if i < len(detail) {
			d = truncate(detail[i], m.detailWidth())
		}
		lines = append(lines, pad(l, m.listWidth())+dim("│ ")+d)
	}
	lines = append(lines, m.footer())
	return strings.Join(lines, "\n")
}

func (m *Model) header() string {
	working, waiting := 0, 0
	for _, a := range m.agents {
		inf := m.infos[a.ID]
		if inf.state == "working" {
			working++
		}
		if len(inf.decisions) > 0 {
			waiting++
		}
	}
	left := accent("fleetwatch")
	if m.bearings.Home != "" {
		left += dim(" · " + m.bearings.Home)
	}
	if m.loaded {
		left += fmt.Sprintf(" · %d agents · %s working", len(m.agents), greenStyle.Render(fmt.Sprint(working)))
		if waiting > 0 {
			left += " · " + decisionStyle.Render(fmt.Sprintf("%d need the captain", waiting))
		}
		if n := len(m.bearings.Decisions); n > 0 {
			left += dim(fmt.Sprintf(" · %d captain holds open", n))
		}
	}
	// Freshness stays visible on a narrow screen; the counts give way first.
	right := m.freshness(m.now())
	room := m.columns - ansi.StringWidth(right) - 1
	if room < 10 {
		return truncate(right, m.columns)
	}
	shown := truncate(left, room)
	return shown + strings.Repeat(" ", max(m.columns-ansi.StringWidth(shown)-ansi.StringWidth(right), 1)) + right
}

// freshness reports how old the fleet and PR reads are, flagging stale data.
func (m *Model) freshness(now time.Time) string {
	var parts []string
	switch {
	case m.fleetErr != "":
		parts = append(parts, fail("fleet error: "+firstLine(m.fleetErr)))
		if !m.fleetAt.IsZero() {
			parts = append(parts, warn("showing "+since(now, m.fleetAt)))
		}
	case !m.loaded:
		parts = append(parts, dim("reading fleet…"))
	default:
		s := "fleet " + since(now, m.fleetAt)
		if now.Sub(m.fleetAt) > 3*m.cfg.FleetInterval+time.Minute {
			parts = append(parts, warn(s+" (stale)"))
		} else {
			parts = append(parts, dim(s))
		}
	}
	if m.fleetBusy {
		parts = append(parts, dim("↻"))
	}
	if len(m.prs) > 0 {
		var newest time.Time
		pending, failing := 0, 0
		for _, e := range m.prs {
			if e.at.After(newest) {
				newest = e.at
			}
			if e.pending {
				pending++
			}
			if e.err != "" {
				failing++
			}
		}
		s := "PRs " + since(now, newest)
		if failing > 0 {
			parts = append(parts, warn(fmt.Sprintf("%s (%d unreadable)", s, failing)))
		} else {
			parts = append(parts, dim(s))
		}
		if pending > 0 {
			parts = append(parts, dim("↻"))
		}
	}
	return strings.Join(parts, " ")
}

func (m *Model) listLines() []string {
	w := m.listWidth()
	h := m.bodyHeight()
	var lines []string
	if len(m.rows) == 0 {
		switch {
		case !m.loaded && m.fleetErr != "":
			lines = append(lines, fail("the fleet snapshot failed; retrying"))
		case !m.loaded:
			lines = append(lines, dim("reading fleet…"))
		default:
			lines = append(lines, dim("no agents in flight"))
		}
	}
	now := m.now()
	for i := m.listTop; i < len(m.rows) && len(lines) < h; i++ {
		lines = append(lines, m.rowLine(i, w, now))
	}
	for i, l := range lines {
		lines[i] = truncate(l, w)
	}
	return lines
}

func (m *Model) rowLine(i, w int, now time.Time) string {
	r := m.rows[i]
	if r.isHeader() {
		count := dim(fmt.Sprintf(" %d", r.count))
		if r.header == decisionsGroup {
			return decisionStyle.Render("⚑ "+strings.ToUpper(r.header)) + count
		}
		return headerStyle.Render(strings.ToUpper(r.header)) + count
	}
	a := m.agents[r.agent]
	inf := m.infos[a.ID]
	d := m.details[a.ID]
	// The pipeline stage says more than the state, except once the crew is
	// done: a done crew's run may still be monitoring a green PR for merge.
	label := inf.state
	if d != nil && d.Pipeline != nil && !d.Pipeline.NoRun && inf.state != "done" {
		label = d.Pipeline.Stage()
	}
	right := label
	if last := fleet.LastActivity(d); !last.IsZero() {
		right += " " + age(now.Sub(last))
	}
	right = truncate(right, w/2)
	icon := stateIcon(inf.state, len(inf.decisions) > 0)
	id := truncate(a.ID, max(w-4-ansi.StringWidth(right), 4))
	gap := strings.Repeat(" ", max(w-3-ansi.StringWidth(id)-ansi.StringWidth(right), 1))
	if i == m.cursor {
		return cursorStyle.Render(pad(" "+icon+" "+id+gap+right, w))
	}
	if inf.inactive {
		return dim(" " + icon + " " + id + gap + right)
	}
	iconStyle := stateStyle(inf.state)
	if len(inf.decisions) > 0 {
		iconStyle = decisionStyle
	}
	return " " + iconStyle.Render(icon) + " " + id + gap + stateStyle(inf.state).Render(right)
}

func (m *Model) footer() string {
	var parts []string
	if m.flash != "" && m.now().Sub(m.flashAt) < flashFor {
		parts = append(parts, bold(m.flash))
	}
	parts = append(parts, dim("↑/↓ select · enter focus in herdr · q quit"))
	return truncate(strings.Join(parts, "  "), m.columns)
}

// detailLines is the right pane for one agent, wrapped to width.
func (m *Model) detailLines(a fleet.Agent, width int) []string {
	now := m.now()
	inf, hasInfo := m.infos[a.ID]
	d := m.details[a.ID]
	var out []string
	line := func(s string) { out = append(out, strings.Split(ansi.Wrap(s, width, ""), "\n")...) }
	sub := func(s string) {
		for _, l := range strings.Split(ansi.Wrap(s, width-2, ""), "\n") {
			out = append(out, "  "+l)
		}
	}
	section := func(title string) { out = append(out, "", accent(title)) }
	state := a.State
	if hasInfo {
		state = inf.state
	}

	line(bold(a.ID) + "  " + stateStyle(state).Render("["+state+"]"))
	if a.Name != "" && a.Name != a.ID {
		line(a.Name)
	}
	var meta *fleet.Meta
	if d != nil {
		meta = d.Meta
	}
	line(dim(joinNonEmpty(" · ", projectLabel(a), a.Kind, metaLabel(meta))))

	if a.Absent {
		section("ABSENT")
		line(a.AbsentReason)
		if a.Doing != "" {
			line(dim("last reported by bearings: " + a.Doing))
		}
		return out
	}

	section("NOW")
	if inf.doing != "" {
		line(inf.doing)
	}
	from := "bearings snapshot"
	harness := ""
	if d != nil && d.Crew != nil {
		from = "crew-state (" + d.Crew.Source + ")"
	}
	if d != nil && d.Busy != nil {
		harness = " · harness " + d.Busy.State
	}
	line(dim("last activity " + since(now, fleet.LastActivity(d)) + harness + " · from " + from))
	if d != nil && d.CrewError != "" {
		line(fail("crew-state: " + d.CrewError))
	}

	if len(inf.decisions) > 0 {
		section("⚑ WAITING ON THE CAPTAIN")
		for _, dec := range inf.decisions {
			head := dec.Source
			if dec.Key != "" {
				head += " " + dec.Key
			}
			if !dec.At.IsZero() {
				head += " · " + since(now, dec.At)
			}
			line(decisionStyle.Render(head))
			sub(dec.Text)
		}
	}

	if d != nil && (d.Pipeline != nil || d.PipelineError != "") {
		section("PIPELINE")
		pipelineLines(d, line, sub)
	}

	if inf.prURL != "" {
		section("PULL REQUEST")
		m.prLines(inf.prURL, now, line)
	}

	if d != nil && (len(d.Status) > 0 || d.StatusError != "") {
		section("STATUS LOG")
		if d.StatusError != "" {
			line(fail(d.StatusError))
		}
		for i := len(d.Status) - 1; i >= max(len(d.Status)-statusTail, 0); i-- {
			e := d.Status[i]
			when := ""
			if !e.At.IsZero() {
				when = " " + since(now, e.At)
			}
			line(stateStyle(logState(e.State)).Render(e.State) + dim(when) + "  " + firstLine(e.Text))
		}
	}

	section("ENDPOINT")
	switch {
	case meta != nil:
		if meta.HerdrPane != "" {
			line("herdr " + meta.HerdrSession + " " + meta.HerdrPane + dim("  (enter to focus)"))
		} else if meta.Window != "" {
			line(meta.Backend + " " + meta.Window)
		}
		if meta.Worktree != "" {
			line(dim(meta.Worktree))
		}
		if meta.Branch != "" {
			line(dim("branch " + meta.Branch))
		}
	case d != nil && d.MetaError != "":
		line(fail("meta: " + d.MetaError))
	}
	if d == nil {
		if m.taskPending[a.ID] {
			line(dim("reading agent state…"))
		} else {
			line(dim("agent state not read yet"))
		}
	} else {
		every := m.cfg.Interval
		if inf.inactive {
			every = m.cfg.InactiveInterval
		}
		read := "read " + since(now, d.FetchedAt)
		if now.Sub(d.FetchedAt) > 3*every+time.Minute {
			line(warn(read + " (stale)"))
		} else {
			line(dim(read))
		}
	}
	return out
}

func pipelineLines(d *fleet.Detail, line, sub func(string)) {
	if d.PipelineError != "" {
		line(fail("no-mistakes: " + d.PipelineError))
		return
	}
	p := d.Pipeline
	if p.NoRun {
		note := p.Note
		if note == "" {
			note = "no run"
		}
		line(dim(note))
		return
	}
	head := "run " + p.RunID + " · " + p.Status
	if p.Outcome != "" {
		head += " · outcome " + p.Outcome
	}
	line(head)
	if d.Meta != nil && d.Meta.Branch != "" && p.Branch != "" && p.Branch != d.Meta.Branch {
		line(warn("run branch " + p.Branch + " is not this task's branch " + d.Meta.Branch))
	}
	if len(p.Steps) > 0 {
		steps := make([]string, len(p.Steps))
		for i, s := range p.Steps {
			label := stepMark(s.Status) + " " + s.Name
			if s.Findings > 0 {
				label += fmt.Sprintf("(%d)", s.Findings)
			}
			steps[i] = stepStyle(s.Status).Render(label)
		}
		line(strings.Join(steps, "  "))
	}
	for _, act := range p.Active {
		line(act.Step + " " + act.Status + " for " + act.ActiveFor)
		if act.LastActivity != "" {
			sub(dim(act.LastActivity))
		}
	}
	if p.AwaitingAgent != "" {
		line(warn("awaiting agent: " + p.AwaitingAgent))
	}
	if p.Gate != nil {
		line(warn(fmt.Sprintf("gate at %s (%s) · %d finding(s)", p.Gate.Step, p.Gate.Status, len(p.Gate.Findings))))
		for _, f := range p.Gate.Findings {
			sub(f.Action + " " + f.Severity + " " + f.ID + dim(" "+f.File))
		}
	} else if p.Findings != "" && p.Findings != "none" {
		line(dim("findings: " + p.Findings))
	}
	if p.Error != "" {
		line(fail(firstLine(p.Error)))
	}
}

func (m *Model) prLines(url string, now time.Time, line func(string)) {
	e := m.prs[url]
	if e == nil || (e.pr == nil && e.err == "") {
		line(url)
		line(dim("reading from GitHub…"))
		return
	}
	if pr := e.pr; pr != nil {
		c := pr.Checks
		checkStyle := greenStyle
		if c.Failed > 0 {
			checkStyle = errorStyle
		} else if c.Pending > 0 || c.Total == 0 {
			checkStyle = warnStyle
		}
		state := fmt.Sprintf("#%d %s", pr.Number, pr.State)
		if pr.Draft {
			state += " draft"
		}
		parts := []string{state, checkStyle.Render("checks " + c.Summary())}
		if pr.MergeState != "" {
			parts = append(parts, strings.ToLower(pr.MergeState))
		}
		if pr.ReviewDecision != "" {
			parts = append(parts, strings.ReplaceAll(strings.ToLower(pr.ReviewDecision), "_", " "))
		}
		line(strings.Join(parts, " · "))
		line(pr.Title)
	}
	line(dim(url))
	if e.err != "" {
		line(fail("gh: " + e.err))
	}
	line(dim("read " + since(now, e.at)))
}

func stepMark(status string) string {
	switch status {
	case "completed":
		return "✓"
	case "running", "fixing":
		return "▶"
	case "awaiting_approval", "fix_review":
		return "⏸"
	case "failed":
		return "✗"
	case "skipped":
		return "↷"
	}
	return "·"
}

func stepStyle(status string) style {
	switch status {
	case "completed":
		return greenStyle
	case "running", "fixing":
		return boldStyle
	case "awaiting_approval", "fix_review":
		return warnStyle
	case "failed":
		return errorStyle
	}
	return dimStyle
}

func logState(s string) string {
	switch s {
	case "needs-decision":
		return "paused"
	case "resolved":
		return "done"
	}
	return s
}

func projectLabel(a fleet.Agent) string {
	if a.Owner == fleet.MainOwner {
		return a.Repo
	}
	return a.Repo + " via " + a.Owner
}

func metaLabel(meta *fleet.Meta) string {
	if meta == nil {
		return ""
	}
	model := meta.Model
	if meta.Effort != "" {
		model += "/" + meta.Effort
	}
	return joinNonEmpty(" · ", meta.Mode, meta.Harness, model)
}

func joinNonEmpty(sep string, parts ...string) string {
	var kept []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, sep)
}
