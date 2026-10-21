package fleet

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// CrewState is one `bin/fm-crew-state.sh <task>` line:
//
//	state: <state> · source: <source> · <detail>
type CrewState struct {
	State  string
	Source string
	Detail string
	RunID  string
}

const crewSep = " · "

var runIDPattern = regexp.MustCompile(`\brun: ([0-9A-Z]{26})\b`)

func ParseCrewState(out string) (*CrewState, error) {
	line, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	state, rest, found := strings.Cut(line, crewSep)
	if !found || !strings.HasPrefix(state, "state: ") {
		return nil, fmt.Errorf("crew-state: unrecognised line %q", line)
	}
	source, detail, _ := strings.Cut(rest, crewSep)
	if !strings.HasPrefix(source, "source: ") {
		return nil, fmt.Errorf("crew-state: missing source in %q", line)
	}
	c := &CrewState{
		State:  strings.TrimPrefix(state, "state: "),
		Source: strings.TrimPrefix(source, "source: "),
		Detail: detail,
	}
	if m := runIDPattern.FindStringSubmatch(detail); m != nil {
		c.RunID = m[1]
	}
	return c, nil
}

// Meta is the subset of state/<task>.meta fleetwatch reads.
type Meta struct {
	Worktree     string
	Project      string
	Harness      string
	Kind         string
	Mode         string
	Branch       string
	BaseBranch   string
	Model        string
	Effort       string
	PR           string
	Backend      string
	Window       string
	HerdrSession string
	HerdrPane    string
	Home         string // a secondmate's own firstmate home
	RemoteHost   string // set for a secondmate that lives on another host
	DecisionKeys []string
}

func ParseMeta(text string) *Meta {
	kv := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	m := &Meta{
		Worktree:     kv["worktree"],
		Project:      kv["project"],
		Harness:      kv["harness"],
		Kind:         kv["kind"],
		Mode:         kv["mode"],
		Branch:       kv["branch"],
		BaseBranch:   kv["base_branch"],
		Model:        kv["model"],
		Effort:       kv["effort"],
		PR:           kv["pr"],
		Backend:      kv["backend"],
		Window:       kv["window"],
		HerdrSession: kv["herdr_session"],
		HerdrPane:    kv["herdr_pane_id"],
		Home:         kv["home"],
		RemoteHost:   kv["remote_host"],
	}
	for _, k := range strings.Split(kv["decision_keys"], ",") {
		if k = strings.TrimSpace(k); k != "" {
			m.DecisionKeys = append(m.DecisionKeys, k)
		}
	}
	return m
}

// StatusEntry is one event from the append-only state/<task>.status log:
//
//	<state> [at=<epoch>] [key=<slug>]: <text>
//
// Tags are optional and may come in any order. Lines that do not open an
// entry continue the previous one. At is zero when the line carried no usable
// stamp.
type StatusEntry struct {
	State string
	At    time.Time
	Key   string
	Text  string
}

var (
	statusLine   = regexp.MustCompile(`^([a-z][a-z-]*)((?: \[[a-z]+=[^\]]*\])*): ?(.*)$`)
	statusTag    = regexp.MustCompile(`\[([a-z]+)=([^\]]*)\]`)
	statusStates = map[string]bool{
		"working": true, "needs-decision": true, "blocked": true, "paused": true, "done": true, "failed": true, "resolved": true,
	}
)

func ParseStatusLog(text string) []StatusEntry {
	var entries []StatusEntry
	for _, line := range strings.Split(text, "\n") {
		if m := statusLine.FindStringSubmatch(line); m != nil && statusStates[m[1]] {
			e := StatusEntry{State: m[1], Text: m[3]}
			for _, tag := range statusTag.FindAllStringSubmatch(m[2], -1) {
				switch tag[1] {
				case "at":
					e.At = epoch(tag[2])
				case "key":
					e.Key = tag[2]
				}
			}
			entries = append(entries, e)
			continue
		}
		if strings.TrimSpace(line) != "" && len(entries) > 0 {
			entries[len(entries)-1].Text += "\n" + line
		}
	}
	return entries
}

// epoch reads a decimal epoch-seconds stamp, or zero when it is not one.
func epoch(s string) time.Time {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return time.Time{}
	}
	return time.Unix(n, 0)
}

// OpenDecisions returns needs-decision entries no later resolved line closed.
// A keyed decision closes only on a resolved line with the same key; a keyless
// one closes on a later keyless resolved line.
func OpenDecisions(entries []StatusEntry) []StatusEntry {
	var open []StatusEntry
	for i, e := range entries {
		if e.State != "needs-decision" {
			continue
		}
		closed := false
		for _, later := range entries[i+1:] {
			if later.State == "resolved" && later.Key == e.Key {
				closed = true
				break
			}
		}
		if !closed {
			open = append(open, e)
		}
	}
	return open
}

// LastStamped returns the time of the newest entry that carries a stamp.
func LastStamped(entries []StatusEntry) time.Time {
	var t time.Time
	for _, e := range entries {
		if e.At.After(t) {
			t = e.At
		}
	}
	return t
}

// Busy is state/<task>.busy-state: the harness's last busy/idle event.
//
//	v1 gen=<gen> seq=<n> state=<busy|idle> source=<src> event=<event> ts=<epoch>
type Busy struct {
	State  string
	Source string
	Event  string
	At     time.Time
}

func ParseBusy(text string) (*Busy, error) {
	fields := strings.Fields(text)
	if len(fields) == 0 || fields[0] != "v1" {
		return nil, fmt.Errorf("busy-state: unsupported record %q", strings.TrimSpace(text))
	}
	b := &Busy{}
	for _, f := range fields[1:] {
		k, v, _ := strings.Cut(f, "=")
		switch k {
		case "state":
			b.State = v
		case "source":
			b.Source = v
		case "event":
			b.Event = v
		case "ts":
			b.At = epoch(v)
		}
	}
	return b, nil
}
