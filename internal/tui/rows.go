package tui

import (
	"cmp"
	"slices"

	"github.com/davidrydberg/fleetwatch/internal/fleet"
)

// info is what the list and detail pane derive for one agent from all sources.
type info struct {
	state     string
	doing     string
	decisions []fleet.PendingDecision
	inactive  bool
	prURL     string
}

func deriveInfo(a fleet.Agent, d *fleet.Detail, b *fleet.Bearings) info {
	state := fleet.CurrentState(a, d)
	return info{
		state:     state,
		doing:     fleet.CurrentDoing(a, d),
		decisions: fleet.CaptainDecisions(a, d, b.Decisions),
		inactive:  fleet.IsInactive(state),
		prURL:     fleet.PRURL(a, d, b),
	}
}

// row is one list line: a group header, or an agent (an index into agents).
type row struct {
	header string // "" for an agent row
	count  int
	agent  int
}

func (r row) isHeader() bool { return r.header != "" }

const (
	decisionsGroup = "captain decisions"
	noProjectGroup = "(no project)"
)

// buildRows groups agents for the list: agents with an open captain decision
// pinned first, then one group per project, secondmate homes last. Within a
// group, live states sort before inactive ones.
func buildRows(agents []fleet.Agent, infos map[string]info) []row {
	groups := map[string][]int{}
	for i, a := range agents {
		inf, ok := infos[a.ID]
		if !ok {
			continue
		}
		g := groupOf(a, inf)
		groups[g] = append(groups[g], i)
	}
	names := make([]string, 0, len(groups))
	for g := range groups {
		names = append(names, g)
	}
	slices.SortFunc(names, func(x, y string) int {
		return cmp.Or(cmp.Compare(groupRank(x), groupRank(y)), cmp.Compare(x, y))
	})
	var rows []row
	for _, g := range names {
		members := groups[g]
		slices.SortFunc(members, func(i, j int) int {
			ai, aj := agents[i], agents[j]
			return cmp.Or(cmp.Compare(stateRank(infos[ai.ID].state), stateRank(infos[aj.ID].state)), cmp.Compare(ai.ID, aj.ID))
		})
		rows = append(rows, row{header: g, count: len(members)})
		for _, i := range members {
			rows = append(rows, row{agent: i})
		}
	}
	return rows
}

func groupOf(a fleet.Agent, inf info) string {
	if len(inf.decisions) > 0 {
		return decisionsGroup
	}
	if a.Repo == "" {
		return noProjectGroup
	}
	return a.Repo
}

func groupRank(g string) int {
	switch g {
	case decisionsGroup:
		return 0
	case fleet.SecondmateGroup:
		return 2
	case noProjectGroup:
		return 3
	}
	return 1
}

func stateRank(state string) int {
	switch state {
	case "working":
		return 0
	case "parked", "paused":
		return 1
	case "blocked", "failed":
		return 2
	case "done":
		return 4
	case "absent":
		return 6
	}
	if fleet.IsInactive(state) {
		return 5
	}
	return 3
}
