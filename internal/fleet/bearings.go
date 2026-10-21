package fleet

import (
	"encoding/json"
	"fmt"
)

// BearingsSchema is the output contract fleetwatch reads from
// `bin/fm-bearings-snapshot.sh --json`.
const BearingsSchema = "fm-bearings.v1"

// MainOwner is the decisions_open owner value for the supervising home.
const MainOwner = "(main)"

// InFlight is one underway task. Secondmate children carry "<home>/<task>" ids.
type InFlight struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	State string `json:"state"`
	Repo  string `json:"repo"`
	Name  string `json:"name"`
	Doing string `json:"doing"`
}

type SecondmateRow struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Doing string `json:"doing"`
}

type SecondmateHost struct {
	ID   string `json:"id"`
	Host string `json:"host"`
}

// Decision is an open captain decision. Owner is MainOwner or a secondmate id.
type Decision struct {
	ID      string `json:"id"`
	Key     string `json:"key"`
	Verb    string `json:"verb"`
	Summary string `json:"summary"`
	Owner   string `json:"owner"`
}

type RecordedPR struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// Bearings is the part of the bearings snapshot fleetwatch shows.
type Bearings struct {
	Schema      string           `json:"schema"`
	Home        string           `json:"home"`
	Generated   string           `json:"generated"`
	InFlight    []InFlight       `json:"in_flight"`
	Secondmates []SecondmateRow  `json:"secondmates"`
	Reconcile   []SecondmateHost `json:"secondmate_reconcile"`
	Decisions   []Decision       `json:"decisions_open"`
	RecordedPRs []RecordedPR     `json:"recorded_prs"`
}

// ParseBearings decodes the bearings JSON projection and checks its schema.
func ParseBearings(text string) (*Bearings, error) {
	var head struct {
		Schema any `json:"schema"`
	}
	if err := json.Unmarshal([]byte(text), &head); err != nil {
		return nil, fmt.Errorf("bearings: %w", err)
	}
	if head.Schema != BearingsSchema {
		return nil, fmt.Errorf("bearings: schema %v, want %q", head.Schema, BearingsSchema)
	}
	var b Bearings
	if err := json.Unmarshal([]byte(text), &b); err != nil {
		return nil, fmt.Errorf("bearings: %w", err)
	}
	return &b, nil
}

// RecordedPR returns the PR URL bearings recorded for a task, if any.
func (b *Bearings) RecordedPR(id string) string {
	for _, r := range b.RecordedPRs {
		if r.ID == id {
			return r.URL
		}
	}
	return ""
}

// SecondmateHost returns the host a secondmate home lives on, if recorded.
func (b *Bearings) SecondmateHost(id string) string {
	for _, r := range b.Reconcile {
		if r.ID == id {
			return r.Host
		}
	}
	return ""
}
