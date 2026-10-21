package fleet

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type Step struct {
	Name       string
	Status     string
	Findings   int
	DurationMs int
}

type ActiveStep struct {
	Step         string
	Status       string
	ActiveFor    string
	LastActivity string
	Round        string
}

type Finding struct {
	ID          string
	Severity    string
	File        string
	Action      string
	Description string
}

type Gate struct {
	Step     string
	Status   string
	Risk     string
	Findings []Finding
}

// Pipeline is one no-mistakes run as `no-mistakes axi status` reports it.
// NoRun is set when the command answered but had no run to attribute, such as
// a branch without runs or a detached worktree.
type Pipeline struct {
	RunID         string
	Branch        string
	Status        string
	Outcome       string
	Error         string
	PR            string
	Findings      string
	AwaitingAgent string
	Head          string
	Steps         []Step
	Active        []ActiveStep
	Gate          *Gate
	NoRun         bool
	Note          string
}

func NoRun(note, branch string) *Pipeline {
	return &Pipeline{NoRun: true, Note: note, Branch: branch}
}

func ParsePipeline(out string) (*Pipeline, error) {
	doc, err := ParseToon(out)
	if err != nil {
		return nil, err
	}
	run := doc.Object("run")
	if run == nil {
		if _, ok := doc["current_branch"]; !ok {
			return nil, errors.New("no-mistakes status: neither a run nor a current branch in output")
		}
		note := ""
		if runs, ok := doc["runs"].(string); ok {
			note = runs
		} else if count := doc.String("count"); count != "" {
			note = fmt.Sprintf("no run attributed to this worktree (%s runs listed)", count)
		}
		return NoRun(note, doc.String("current_branch")), nil
	}
	p := &Pipeline{
		RunID:         run.String("id"),
		Branch:        run.String("branch"),
		Status:        run.String("status"),
		PR:            run.String("pr"),
		Findings:      run.String("findings"),
		AwaitingAgent: run.String("awaiting_agent"),
		Head:          run.String("head"),
		Outcome:       doc.String("outcome"),
		Error:         doc.String("error"),
	}
	for _, r := range run.Table("steps") {
		findings, _ := strconv.Atoi(r["findings"])
		duration, _ := strconv.Atoi(r["duration_ms"])
		p.Steps = append(p.Steps, Step{Name: r["step"], Status: r["status"], Findings: findings, DurationMs: duration})
	}
	for _, r := range run.Table("active_steps") {
		p.Active = append(p.Active, ActiveStep{
			Step:         r["step"],
			Status:       r["status"],
			ActiveFor:    r["active_for"],
			LastActivity: r["last_activity"],
			Round:        r["round"],
		})
	}
	if g := doc.Object("gate"); g != nil {
		p.Gate = &Gate{Step: g.String("step"), Status: g.String("status"), Risk: g.String("risk")}
		for _, r := range g.Table("findings") {
			p.Gate.Findings = append(p.Gate.Findings, Finding{
				ID:          r["id"],
				Severity:    r["severity"],
				File:        r["file"],
				Action:      r["action"],
				Description: r["description"],
			})
		}
	}
	return p, nil
}

// Stage is a short label for where the run stands, for list rows.
func (p *Pipeline) Stage() string {
	if p.NoRun {
		return "no run"
	}
	if p.Gate != nil {
		return p.Gate.Step + " gate"
	}
	if p.Outcome != "" {
		for _, s := range p.Steps {
			if s.Status == "failed" {
				if p.Outcome != "passed" {
					return p.Outcome + " at " + s.Name
				}
				break
			}
		}
		return p.Outcome
	}
	if len(p.Active) > 0 {
		return p.Active[0].Step + " " + p.Active[0].Status
	}
	for _, s := range p.Steps {
		if s.Status != "completed" && s.Status != "skipped" {
			return s.Name + " " + s.Status
		}
	}
	return p.Status
}

// AskUser lists gate findings that wait on a human authority decision.
func (p *Pipeline) AskUser() []Finding {
	if p.Gate == nil {
		return nil
	}
	var out []Finding
	for _, f := range p.Gate.Findings {
		if strings.ToLower(f.Action) == "ask-user" {
			out = append(out, f)
		}
	}
	return out
}
