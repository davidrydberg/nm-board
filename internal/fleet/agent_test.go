package fleet

import (
	"testing"
	"time"

	"github.com/davidrydberg/fleetwatch/internal/fixtures"
)

func bearings(t *testing.T) *Bearings {
	t.Helper()
	b, err := ParseBearings(fixtures.Read(t, "bearings.json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func remoteMeta(t *testing.T) map[string]*Meta {
	return map[string]*Meta{"spare": ParseMeta(fixtures.Read(t, "remote-secondmate.meta"))}
}

func byID(agents []Agent) map[string]Agent {
	m := map[string]Agent{}
	for _, a := range agents {
		m[a.ID] = a
	}
	return m
}

func TestRemoteSecondmateIsOneAbsentRow(t *testing.T) {
	b := bearings(t)
	b.InFlight = append(b.InFlight, InFlight{ID: "spare/bulk-order-design", Kind: "ship", State: "working", Repo: "shop-api"})
	agents := BuildRoster(b, "/fm", remoteMeta(t))
	eq(t, len(agents), 10, "9 tasks and 1 secondmate")
	if _, ok := byID(agents)["spare/bulk-order-design"]; ok {
		t.Error("a remote secondmate's child is listed")
	}
	sm := agents[9]
	eq(t, []any{sm.ID, sm.Absent, sm.Secondmate, sm.Repo}, []any{"spare", true, true, SecondmateGroup}, "secondmate")
	eq(t, sm.AbsentReason, "remote home on buildbox is not read by fleetwatch v1", "reason")
	eq(t, CurrentState(sm, nil), "absent", "state")
	eq(t, len(CaptainDecisions(sm, nil, b.Decisions)), 0, "decisions")
	a := agents[0]
	eq(t, []string{a.ID, a.TaskID, a.Home, a.Owner, a.Repo}, []string{"web-admin-console", "web-admin-console", "/fm", MainOwner, "shop-web"}, "first agent")
}

func TestSecondmateWithoutMetaIsRemoteByReconcileHost(t *testing.T) {
	agents := BuildRoster(bearings(t), "/fm", nil)
	sm := agents[len(agents)-1]
	eq(t, sm.Absent, true, "absent")
	eq(t, sm.AbsentReason, "remote home on buildbox is not read by fleetwatch v1", "reason")
}

func TestLocalSecondmateChildReadsFromItsHome(t *testing.T) {
	b := bearings(t)
	b.InFlight = []InFlight{{ID: "sm1/fix-login", Kind: "ship", State: "working", Repo: "/home/dev/firstmate/projects/webapp"}}
	b.Secondmates = []SecondmateRow{{ID: "sm1", State: "active_child_work"}}
	b.Reconcile = nil
	meta := ParseMeta("kind=secondmate")
	meta.Home = "/fm-sm1"
	agents := BuildRoster(b, "/fm", map[string]*Meta{"sm1": meta})
	eq(t, len(agents), 2, "agents")
	child := agents[0]
	eq(t, []string{child.Owner, child.TaskID, child.Home, child.Repo}, []string{"sm1", "fix-login", "/fm-sm1", "webapp"}, "child")
	eq(t, []any{agents[1].Absent, agents[1].Home}, []any{false, "/fm"}, "secondmate")
}

func TestCaptainDecisions(t *testing.T) {
	b := bearings(t)
	agents := byID(BuildRoster(b, "/fm", remoteMeta(t)))
	keys := func(ds []PendingDecision) [][2]string {
		var out [][2]string
		for _, d := range ds {
			out = append(out, [2]string{d.Source, d.Key})
		}
		return out
	}

	scout := &Detail{Meta: ParseMeta(fixtures.Read(t, "scout.meta")), Status: ParseStatusLog(fixtures.Read(t, "scout.status"))}
	eq(t, keys(CaptainDecisions(agents["dev-inventory"], scout, b.Decisions)), [][2]string{
		{"captain-hold", "release-picks"},
		{"needs-decision", "board-review"},
	}, "scout")

	api := &Detail{Status: ParseStatusLog(fixtures.Read(t, "api.status")), Pipeline: pipeline(t, "nm-gate.toon")}
	eq(t, keys(CaptainDecisions(agents["pack-option-api"], api, b.Decisions)), [][2]string{
		{"needs-decision", "nm-01JXB56R3S8P2RMK6RQF9R4EN9-review"},
		{"ask-user", "admin-toggle-overridden"},
		{"ask-user", "invoice-fee-row-unverified"},
	}, "api")

	web := &Detail{Status: ParseStatusLog(fixtures.Read(t, "web.status"))}
	eq(t, len(CaptainDecisions(agents["pack-option-web"], web, b.Decisions)), 0, "web")
}

func TestCrewStateWinsOverBearings(t *testing.T) {
	a := Agent{State: "working", Doing: "harness busy (claude-hook)"}
	eq(t, CurrentState(a, nil), "working", "state")
	eq(t, CurrentDoing(a, &Detail{}), "harness busy (claude-hook)", "doing")
	crew, err := ParseCrewState(fixtures.Read(t, "crew-mailer-send-limits.txt"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, CurrentState(a, &Detail{Crew: crew}), "failed", "crew state")
	eq(t, CurrentDoing(a, &Detail{Crew: crew}), crew.Detail, "crew doing")
	var inactive []bool
	for _, s := range []string{"done", "unknown", "absent", "parked", "failed"} {
		inactive = append(inactive, IsInactive(s))
	}
	eq(t, inactive, []bool{true, true, true, false, false}, "inactive")
}

func TestLastActivity(t *testing.T) {
	busy, err := ParseBusy(fixtures.Read(t, "idle.busy-state"))
	if err != nil {
		t.Fatal(err)
	}
	d := &Detail{Status: ParseStatusLog(fixtures.Read(t, "api.status")), Busy: busy}
	eq(t, LastActivity(d), time.Unix(1792522585, 0), "busy event")
	d.Busy = nil
	eq(t, LastActivity(d), time.Unix(1792418228, 0), "status stamp")
	d.StatusModified = time.Unix(1792500000, 0)
	eq(t, LastActivity(d), time.Unix(1792500000, 0), "status write")
	eq(t, LastActivity(nil).IsZero(), true, "no detail")
}

func TestPRURL(t *testing.T) {
	b := bearings(t)
	a := Agent{ID: "api-catalog-scope"}
	p := pipeline(t, "nm-passed.toon")
	p.PR = "https://github.com/o/r/pull/3"
	eq(t, PRURL(a, &Detail{Pipeline: p}, b), "https://github.com/example-org/shop-api/pull/188", "bearings over pipeline")
	meta := ParseMeta("pr=https://github.com/o/r/pull/9")
	eq(t, PRURL(a, &Detail{Meta: meta, Pipeline: p}, b), meta.PR, "meta first")
	eq(t, PRURL(Agent{ID: "other"}, &Detail{Pipeline: p}, b), p.PR, "pipeline last")
}
