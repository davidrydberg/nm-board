package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// PRFields is the --json field list fleetwatch requests from `gh pr view`.
const PRFields = "number,title,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,url,headRefName"

// Checks summarises statusCheckRollup. FailedNames and PendingNames name the
// checks behind those counts.
type Checks struct {
	Total        int
	Passed       int
	Failed       int
	Pending      int
	Skipped      int
	FailedNames  []string
	PendingNames []string
}

// PR is a pull request and its check rollup as `gh pr view --json` reports it.
type PR struct {
	Number         int
	Title          string
	URL            string
	State          string // OPEN, MERGED, CLOSED
	Draft          bool
	ReviewDecision string
	MergeState     string
	HeadRef        string
	Checks         Checks
}

// rollupEntry is either a CheckRun (status, conclusion, name) or a commit
// StatusContext (state, context).
type rollupEntry struct {
	Typename   string `json:"__typename"`
	Name       string `json:"name"`
	Context    string `json:"context"`
	Status     string `json:"status"`
	State      string `json:"state"`
	Conclusion string `json:"conclusion"`
}

func ParsePR(text string) (*PR, error) {
	var raw struct {
		Number            int           `json:"number"`
		Title             string        `json:"title"`
		URL               string        `json:"url"`
		State             string        `json:"state"`
		IsDraft           bool          `json:"isDraft"`
		ReviewDecision    string        `json:"reviewDecision"`
		MergeStateStatus  string        `json:"mergeStateStatus"`
		HeadRefName       string        `json:"headRefName"`
		StatusCheckRollup []rollupEntry `json:"statusCheckRollup"`
	}
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return nil, fmt.Errorf("gh pr view: %w", err)
	}
	if raw.Number == 0 {
		return nil, errors.New("gh pr view: no pull request number in output")
	}
	pr := &PR{
		Number:         raw.Number,
		Title:          raw.Title,
		URL:            raw.URL,
		State:          raw.State,
		Draft:          raw.IsDraft,
		ReviewDecision: raw.ReviewDecision,
		MergeState:     raw.MergeStateStatus,
		HeadRef:        raw.HeadRefName,
	}
	for _, g := range raw.StatusCheckRollup {
		pr.Checks.add(g)
	}
	return pr, nil
}

func (c *Checks) add(g rollupEntry) {
	name := g.Name
	if name == "" {
		name = g.Context
	}
	var outcome string
	if g.Typename == "StatusContext" || (g.Status == "" && g.State != "") {
		switch g.State {
		case "SUCCESS":
			outcome = "pass"
		case "PENDING", "EXPECTED":
			outcome = "pending"
		default:
			outcome = "fail"
		}
	} else {
		switch {
		case g.Status != "COMPLETED":
			outcome = "pending"
		case g.Conclusion == "SUCCESS":
			outcome = "pass"
		case g.Conclusion == "NEUTRAL" || g.Conclusion == "SKIPPED":
			outcome = "skip"
		default:
			outcome = "fail"
		}
	}
	c.Total++
	switch outcome {
	case "pass":
		c.Passed++
	case "skip":
		c.Skipped++
	case "pending":
		c.Pending++
		c.PendingNames = append(c.PendingNames, name)
	default:
		c.Failed++
		c.FailedNames = append(c.FailedNames, name)
	}
}

// Summary is a short human reading of the rollup.
func (c Checks) Summary() string {
	switch {
	case c.Total == 0:
		return "no checks"
	case c.Failed > 0:
		return fmt.Sprintf("%d failing: %s", c.Failed, strings.Join(c.FailedNames, ", "))
	case c.Pending > 0:
		return fmt.Sprintf("%d pending: %s", c.Pending, strings.Join(c.PendingNames, ", "))
	}
	return fmt.Sprintf("%d/%d passing", c.Passed, c.Total-c.Skipped)
}

// Terminal reports whether the PR can no longer change state.
func (pr *PR) Terminal() bool {
	return pr.State == "MERGED" || pr.State == "CLOSED"
}
