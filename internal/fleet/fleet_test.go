package fleet

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/davidrydberg/fleetwatch/internal/fixtures"
)

func eq[T any](t *testing.T, got, want T, what string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %#v, want %#v", what, got, want)
	}
}

func errContains(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Errorf("error %v, want one containing %q", err, want)
	}
}

func pipeline(t *testing.T, name string) *Pipeline {
	t.Helper()
	p, err := ParsePipeline(fixtures.Read(t, name))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestParseToon(t *testing.T) {
	doc, err := ParseToon(fixtures.Read(t, "nm-gate.toon"))
	if err != nil {
		t.Fatal(err)
	}
	run := doc.Object("run")
	eq(t, run.String("id"), "01JXB56R3S8P2RMK6RQF9R4EN9", "run id")
	sync := doc.Object("branch_sync").Object("pipeline")
	eq(t, sync.String("phase"), "pre_push", "phase")
	eq(t, sync.String("pushed_head"), "", "pushed_head")
	steps := run.Table("steps")
	eq(t, len(steps), 9, "steps")
	eq(t, steps[2]["status"], "awaiting_approval", "step 2 status")
	help := doc.List("help")
	eq(t, len(help), 6, "help")
	if !strings.Contains(help[4], "background it if your harness needs to, but") {
		t.Errorf("help[4] = %q", help[4])
	}
	findings := doc.Object("gate").Table("findings")
	eq(t, len(findings), 2, "findings")
	if !strings.HasPrefix(findings[0]["description"], "resolvePackingMode() now ignores") {
		t.Errorf("finding description = %q", findings[0]["description"])
	}

	_, err = ParseToon("a: 1\n    b: 2\n")
	errContains(t, err, "unexpected indentation")
}

func TestParsePipeline(t *testing.T) {
	t.Run("a run parked at a review gate", func(t *testing.T) {
		p := pipeline(t, "nm-gate.toon")
		eq(t, p.Status, "running", "status")
		eq(t, p.Stage(), "review gate", "stage")
		eq(t, p.Gate.Step, "review", "gate step")
		f := p.Gate.Findings[1]
		eq(t, []string{f.ID, f.Severity, f.File, f.Action}, []string{"invoice-fee-row-unverified", "warning", "src/Billing/InvoiceExporter.php", "ask-user"}, "finding")
		eq(t, len(p.AskUser()), 2, "ask-user")
		eq(t, p.AwaitingAgent, "parked 1d9h", "awaiting agent")
		eq(t, p.Findings, "2 awaiting", "findings")
		eq(t, p.Steps[2], Step{Name: "review", Status: "awaiting_approval", Findings: 2, DurationMs: 102680}, "step")
	})

	t.Run("a ci step monitoring a PR", func(t *testing.T) {
		p := pipeline(t, "nm-ci-running.toon")
		eq(t, p.Stage(), "ci running", "stage")
		eq(t, p.Active, []ActiveStep{{
			Step:         "ci",
			Status:       "running",
			ActiveFor:    "1d9h",
			LastActivity: "1m29s ago: log: no CI checks reported yet, waiting for checks to register...",
			Round:        "starting",
		}}, "active")
		eq(t, p.PR, "https://github.com/example-org/shop-web/pull/87", "pr")
		if p.Gate != nil {
			t.Error("unexpected gate")
		}
	})

	t.Run("terminal runs", func(t *testing.T) {
		failed := pipeline(t, "nm-failed-pr.toon")
		eq(t, failed.Outcome, "failed", "outcome")
		eq(t, failed.Stage(), "failed at pr", "failed stage")
		if !strings.HasPrefix(failed.Error, "step pr failed: gh pr create") {
			t.Errorf("error = %q", failed.Error)
		}
		passed := pipeline(t, "nm-passed.toon")
		eq(t, passed.Status, "completed", "passed status")
		eq(t, passed.Stage(), "passed", "passed stage")
		cancelled := pipeline(t, "nm-cancelled.toon")
		eq(t, cancelled.Stage(), "cancelled at ci", "cancelled stage")
		eq(t, cancelled.Branch, "fm/web-admin-dev-sync", "cancelled branch")
		eq(t, cancelled.Error, "cancelled: aborted by user", "cancelled error")
		for _, p := range []*Pipeline{failed, passed, cancelled} {
			eq(t, len(p.Steps), 9, "steps")
		}
	})

	t.Run("output without a run", func(t *testing.T) {
		for _, c := range []struct{ file, branch, note string }{
			{"nm-no-runs.toon", "fm/cli-status-view", "0 runs yet in this repository"},
			{"nm-detached.toon", "unknown", "0 runs yet in this repository"},
			{"nm-runs-list.toon", "unknown", "no run attributed to this worktree (10 of 150 total runs listed)"},
		} {
			p := pipeline(t, c.file)
			eq(t, []any{p.NoRun, p.Branch, p.Note, p.Stage()}, []any{true, c.branch, c.note, "no run"}, c.file)
		}
		_, err := ParsePipeline("error: daemon unreachable\n")
		errContains(t, err, "neither a run nor a current branch")
	})
}

func TestParseBearings(t *testing.T) {
	b, err := ParseBearings(fixtures.Read(t, "bearings.json"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, b.Home, "code/firstmate", "home")
	eq(t, b.Generated, "2026-10-20T21:54:15Z", "generated")
	eq(t, len(b.InFlight), 9, "in flight")
	eq(t, len(b.Decisions), 4, "decisions")
	eq(t, len(b.Secondmates), 1, "secondmates")
	row := b.InFlight[7]
	row.Doing = ""
	eq(t, row, InFlight{ID: "pack-option-api", Kind: "ship", State: "parked", Repo: "shop-api", Name: "API side of the packing option at checkout."}, "row")
	dec := b.Decisions[2]
	dec.Summary = ""
	eq(t, dec, Decision{ID: "spare/runbook-docs", Key: "runbook-docs", Verb: "captain-hold", Owner: "spare"}, "decision")
	eq(t, b.RecordedPR("api-catalog-scope"), "https://github.com/example-org/shop-api/pull/188", "recorded pr")
	eq(t, b.SecondmateHost("spare"), "buildbox", "host")
	eq(t, b.RecordedPR("nope"), "", "no recorded pr")
	eq(t, b.SecondmateHost("nope"), "", "no host")

	_, err = ParseBearings(`{"schema":"fm-bearings.v2"}`)
	errContains(t, err, "schema")
	_, err = ParseBearings("not json")
	errContains(t, err, "bearings:")
}

func TestParseCrewState(t *testing.T) {
	for file, want := range map[string]CrewState{
		"crew-pack-option-api.txt": {
			State:  "parked",
			Source: "run-step",
			Detail: "parked at review: 2 finding(s) · ask-user: authority decision · run: 01JXB56R3S8P2RMK6RQF9R4EN9",
			RunID:  "01JXB56R3S8P2RMK6RQF9R4EN9",
		},
		"crew-pack-option-web.txt": {
			State:  "working",
			Source: "run-step",
			Detail: "validating (running) · run: 01JXHQQMXAAMQFC2392B359VRQ",
			RunID:  "01JXHQQMXAAMQFC2392B359VRQ",
		},
		"crew-mailer-send-limits.txt": {
			State:  "failed",
			Source: "run-step",
			Detail: "run failed · status-log superseded (run failed) · run: 01JXFHFAZBQ6EPNQXJJX41RA0F",
			RunID:  "01JXFHFAZBQ6EPNQXJJX41RA0F",
		},
		"crew-cli-status-view.txt":      {State: "working", Source: "pane", Detail: "harness busy (claude-hook)"},
		"crew-wiki-db-claims-check.txt": {State: "unknown", Source: "none", Detail: "worktree gone (torn down?)"},
	} {
		got, err := ParseCrewState(fixtures.Read(t, file))
		if err != nil {
			t.Fatal(file, err)
		}
		eq(t, *got, want, file)
	}
	scout, err := ParseCrewState(fixtures.Read(t, "crew-dev-inventory.txt"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, []string{scout.State, scout.Source, scout.RunID}, []string{"parked", "status-log", ""}, "scout")

	for _, bad := range []string{"", "usage: fm-crew-state.sh <id>", "state: working"} {
		_, err := ParseCrewState(bad)
		errContains(t, err, "crew-state:")
	}
}

func TestParseMeta(t *testing.T) {
	m := ParseMeta(fixtures.Read(t, "web.meta"))
	eq(t, m.Worktree, "/home/dev/.treehouse/shop-web-3f2a1c/4/shop-web", "worktree")
	eq(t, []string{m.Kind, m.Mode, m.Model, m.Effort, m.Branch}, []string{"ship", "no-mistakes", "opus", "high", "fm/pack-option-web"}, "fields")
	eq(t, []string{m.HerdrSession, m.HerdrPane}, []string{"default", "wBR:p2"}, "herdr")
	eq(t, m.PR, "https://github.com/example-org/shop-web/pull/87", "pr")
	eq(t, m.RemoteHost, "", "remote host")

	scout := ParseMeta(fixtures.Read(t, "scout.meta"))
	eq(t, scout.DecisionKeys, []string{"release-picks"}, "decision keys")
	eq(t, scout.Mode, "", "scout mode")

	remote := ParseMeta(fixtures.Read(t, "remote-secondmate.meta"))
	eq(t, []string{remote.Kind, remote.RemoteHost, remote.Home, remote.Window}, []string{"secondmate", "buildbox", "/home/dev/firstmate-spare", "remote:spare"}, "remote")
}

func TestParseStatusLog(t *testing.T) {
	t.Run("stamped entries with tags in either order", func(t *testing.T) {
		entries := ParseStatusLog(fixtures.Read(t, "web.status"))
		eq(t, len(entries), 11, "entries")
		e := entries[2]
		eq(t, []string{e.State, e.Key}, []string{"resolved", "pack-signed-amount"}, "entry")
		eq(t, e.At, time.Unix(1792411614, 0), "at")
		if !strings.HasPrefix(e.Text, "answered: Decision for pack-signed-amount") {
			t.Errorf("text = %q", e.Text)
		}
		eq(t, LastStamped(entries), time.Unix(1792414994, 0), "last stamped")
		eq(t, len(OpenDecisions(entries)), 0, "every decision was resolved")
	})

	t.Run("open decisions", func(t *testing.T) {
		api := OpenDecisions(ParseStatusLog(fixtures.Read(t, "api.status")))
		eq(t, len(api), 1, "api")
		eq(t, api[0].Key, "nm-01JXB56R3S8P2RMK6RQF9R4EN9-review", "api key")
		scout := OpenDecisions(ParseStatusLog(fixtures.Read(t, "scout.status")))
		eq(t, len(scout), 1, "scout")
		eq(t, scout[0].Key, "board-review", "scout key")
		eq(t, scout[0].At, time.Unix(1792154370, 0), "scout at")
	})

	t.Run("legacy and continuation lines", func(t *testing.T) {
		// Legacy shapes: no stamp, an entry spanning lines, a keyless decision.
		log := "working: setup done, studying design + phase 1 code\n" +
			"needs-decision: two captain calls\n" +
			"DECISION 1: may that one-line pre-existing-dev-bug fix ride on PR 155?\n" +
			"done [corr=bNdaNdfNeNaN] [at=1792000000]: report written\n"
		entries := ParseStatusLog(log)
		eq(t, len(entries), 3, "entries")
		eq(t, entries[0].At.IsZero(), true, "legacy entry has no stamp")
		eq(t, entries[1].Text, "two captain calls\nDECISION 1: may that one-line pre-existing-dev-bug fix ride on PR 155?", "continuation")
		eq(t, entries[2].At, time.Unix(1792000000, 0), "at")
		eq(t, entries[2].Key, "", "key")
		eq(t, len(OpenDecisions(entries)), 1, "keyless decision stays open")
		eq(t, len(OpenDecisions(ParseStatusLog(log+"resolved [at=1792000100]: answered\n"))), 0, "keyless resolved closes it")
	})
}

func TestParseBusy(t *testing.T) {
	busy, err := ParseBusy(fixtures.Read(t, "busy.busy-state"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, *busy, Busy{State: "busy", Source: "claude-hook", Event: "user-prompt-submit", At: time.Unix(1792533201, 0)}, "busy")
	idle, err := ParseBusy(fixtures.Read(t, "idle.busy-state"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, []string{idle.State, idle.Event}, []string{"idle", "session-end"}, "idle")
	_, err = ParseBusy("v2 state=busy")
	errContains(t, err, "unsupported record")
}

func TestParsePR(t *testing.T) {
	open, err := ParsePR(fixtures.Read(t, "gh-open-green.json"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, []any{open.Number, open.State, open.Draft, open.MergeState, open.Terminal()}, []any{188, "OPEN", false, "CLEAN", false}, "open")
	eq(t, []int{open.Checks.Total, open.Checks.Passed}, []int{2, 2}, "checks")
	eq(t, open.Checks.Summary(), "2/2 passing", "summary")

	noChecks, err := ParsePR(fixtures.Read(t, "gh-no-checks.json"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, noChecks.Checks.Summary(), "no checks", "no checks")
	merged, err := ParsePR(fixtures.Read(t, "gh-merged.json"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, []any{merged.State, merged.Terminal()}, []any{"MERGED", true}, "merged")
	_, err = ParsePR("{}")
	errContains(t, err, "no pull request number")

	mixed, err := ParsePR(`{"number": 3, "state": "OPEN", "statusCheckRollup": [
		{"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE"},
		{"__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": ""},
		{"__typename": "CheckRun", "name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED"},
		{"__typename": "StatusContext", "context": "ci/legacy", "state": "PENDING"},
		{"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	c := mixed.Checks
	eq(t, []int{c.Total, c.Failed, c.Pending, c.Skipped, c.Passed}, []int{5, 1, 2, 1, 1}, "mixed counts")
	eq(t, c.Summary(), "1 failing: test", "mixed summary")
	c.Failed, c.FailedNames = 0, nil
	eq(t, c.Summary(), "2 pending: lint, ci/legacy", "pending summary")
}
