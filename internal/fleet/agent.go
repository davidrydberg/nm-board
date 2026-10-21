package fleet

import (
	"slices"
	"strings"
	"time"
)

// SecondmateGroup is the project group secondmate homes are listed under.
const SecondmateGroup = "secondmates"

// Agent is one row fleetwatch shows: an underway task or a secondmate home.
type Agent struct {
	// ID is the bearings id; secondmate children read "<secondmate>/<task>".
	ID string
	// TaskID is the id inside the home that owns the task's state files.
	TaskID string
	// Home is the firstmate home whose state/ and bin/ serve this agent.
	Home  string
	Owner string // MainOwner or the owning secondmate id
	Kind  string
	Repo  string
	Name  string
	// State and Doing are the bearings snapshot's reading.
	State      string
	Doing      string
	Secondmate bool
	// Absent marks an agent fleetwatch does not read, such as a remote
	// secondmate home reachable only over ssh.
	Absent       bool
	AbsentReason string
}

// Detail is everything read for one agent in a local refresh.
type Detail struct {
	Meta           *Meta
	MetaError      string
	Status         []StatusEntry
	StatusError    string
	StatusModified time.Time
	Busy           *Busy
	Crew           *CrewState
	CrewError      string
	Pipeline       *Pipeline
	PipelineError  string
	FetchedAt      time.Time
}

// repoLabel names a project. Bearings falls back to the task's project path
// when the backlog records no repo, so a path is reduced to its last element.
func repoLabel(repo string) string {
	if i := strings.LastIndex(repo, "/"); i >= 0 && i < len(repo)-1 {
		return repo[i+1:]
	}
	return repo
}

// BuildRoster turns a bearings snapshot into the agents to show. smMeta holds
// state/<id>.meta of each secondmate in the main home. Children of a remote
// secondmate are not listed: the home itself shows as absent.
func BuildRoster(b *Bearings, home string, smMeta map[string]*Meta) []Agent {
	remote := func(id string) (bool, string) {
		m := smMeta[id]
		host := b.SecondmateHost(id)
		if m != nil && m.RemoteHost != "" {
			host = m.RemoteHost
		}
		if host != "" {
			return true, host
		}
		return m == nil || m.Home == "", ""
	}
	var agents []Agent
	for _, r := range b.InFlight {
		a := Agent{
			ID:     r.ID,
			TaskID: r.ID,
			Home:   home,
			Owner:  MainOwner,
			Kind:   r.Kind,
			Repo:   repoLabel(r.Repo),
			Name:   r.Name,
			State:  r.State,
			Doing:  r.Doing,
		}
		if owner, task, ok := strings.Cut(r.ID, "/"); ok {
			if isRemote, _ := remote(owner); isRemote {
				continue
			}
			a.Owner = owner
			a.TaskID = task
			a.Home = smMeta[owner].Home
		}
		agents = append(agents, a)
	}
	for _, s := range b.Secondmates {
		isRemote, host := remote(s.ID)
		reason := ""
		switch {
		case isRemote && host != "":
			reason = "remote home on " + host + " is not read by fleetwatch v1"
		case isRemote:
			reason = "secondmate home is not readable from this host"
		}
		agents = append(agents, Agent{
			ID:           s.ID,
			TaskID:       s.ID,
			Home:         home,
			Owner:        MainOwner,
			Kind:         "secondmate",
			Repo:         SecondmateGroup,
			State:        s.State,
			Doing:        s.Doing,
			Secondmate:   true,
			Absent:       isRemote,
			AbsentReason: reason,
		})
	}
	return agents
}

// CurrentState is the per-task crew-state read when one succeeded, else the
// bearings reading.
func CurrentState(a Agent, d *Detail) string {
	if a.Absent {
		return "absent"
	}
	if d != nil && d.Crew != nil {
		return d.Crew.State
	}
	return a.State
}

// CurrentDoing is the latest one-line description of what the agent is doing.
func CurrentDoing(a Agent, d *Detail) string {
	if a.Absent {
		return a.AbsentReason
	}
	if d != nil && d.Crew != nil && d.Crew.Detail != "" {
		return d.Crew.Detail
	}
	return a.Doing
}

// IsInactive states are shown dimmed and sorted last.
func IsInactive(state string) bool {
	return state == "done" || state == "unknown" || state == "absent"
}

// PendingDecision is something waiting on the captain.
type PendingDecision struct {
	Source string // captain-hold, needs-decision, ask-user
	Key    string
	Text   string
	At     time.Time
}

// CaptainDecisions lists what waits on the captain for this agent: captain
// holds bearings reports for it, needs-decision status entries no resolved
// line closed, and ask-user findings parked at a pipeline gate.
func CaptainDecisions(a Agent, d *Detail, open []Decision) []PendingDecision {
	if a.Absent {
		return nil
	}
	var keys []string
	if d != nil && d.Meta != nil {
		keys = d.Meta.DecisionKeys
	}
	var out []PendingDecision
	for _, dec := range open {
		if dec.ID == a.ID || (dec.Owner == a.Owner && slices.Contains(keys, dec.Key)) {
			out = append(out, PendingDecision{Source: dec.Verb, Key: dec.Key, Text: dec.Summary})
		}
	}
	if d == nil {
		return out
	}
	for _, e := range OpenDecisions(d.Status) {
		out = append(out, PendingDecision{Source: "needs-decision", Key: e.Key, Text: e.Text, At: e.At})
	}
	if d.Pipeline != nil {
		for _, f := range d.Pipeline.AskUser() {
			out = append(out, PendingDecision{Source: "ask-user", Key: f.ID, Text: f.Description})
		}
	}
	return out
}

// LastActivity is the newest evidence of the agent doing something: its last
// stamped status entry, its status log's last write (legacy entries carry no
// stamp), or its harness's last busy/idle event.
func LastActivity(d *Detail) time.Time {
	if d == nil {
		return time.Time{}
	}
	t := LastStamped(d.Status)
	if d.StatusModified.After(t) {
		t = d.StatusModified
	}
	if d.Busy != nil && d.Busy.At.After(t) {
		t = d.Busy.At
	}
	return t
}

// PRURL picks the agent's pull request: the one recorded in its meta, else the
// one bearings recorded, else the one its pipeline run opened.
func PRURL(a Agent, d *Detail, b *Bearings) string {
	if d != nil && d.Meta != nil && d.Meta.PR != "" {
		return d.Meta.PR
	}
	if url := b.RecordedPR(a.ID); url != "" {
		return url
	}
	if d != nil && d.Pipeline != nil {
		return d.Pipeline.PR
	}
	return ""
}
