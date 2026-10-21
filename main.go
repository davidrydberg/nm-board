// fleetwatch is a live terminal view of firstmate's agents.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/davidrydberg/fleetwatch/internal/collect"
	"github.com/davidrydberg/fleetwatch/internal/tui"
)

const usage = `usage: fleetwatch [--home <dir>]

  --home      firstmate home to watch (default $FM_HOME; one of the two is required)
  -h, --help  show this help`

const interval = 5 * time.Second

func fail(msg string) {
	fmt.Fprintf(os.Stderr, "fleetwatch: %s\n", msg)
	os.Exit(2)
}

func main() {
	flags := flag.NewFlagSet("fleetwatch", flag.ContinueOnError)
	flags.Usage = func() { fmt.Fprintln(flags.Output(), usage) }
	home := flags.String("home", os.Getenv("FM_HOME"), "")
	if err := flags.Parse(os.Args[1:]); err != nil {
		if err == flag.ErrHelp {
			os.Exit(0)
		}
		os.Exit(2)
	}
	if flags.NArg() > 0 {
		fail(fmt.Sprintf("unexpected argument %q\n\n%s", flags.Arg(0), usage))
	}
	if *home == "" {
		fail("no firstmate home: pass --home <dir> or set FM_HOME\n\n" + usage)
	}
	dir, err := filepath.Abs(*home)
	if err != nil {
		fail(err.Error())
	}
	if info, err := os.Stat(filepath.Join(dir, "bin", "fm-bearings-snapshot.sh")); err != nil || !info.Mode().IsRegular() {
		fail(dir + " does not look like a firstmate home (no bin/fm-bearings-snapshot.sh); pass --home or set FM_HOME")
	}
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		fail(err.Error())
	}

	source := collect.NewFleetSource(collect.Config{
		Home:          dir,
		CacheDir:      filepath.Join(cacheDir, "fleetwatch", "secondmate-summary-cache"),
		FleetTimeout:  60 * time.Second,
		TaskTimeout:   15 * time.Second,
		PRTimeout:     20 * time.Second,
		FocusTimeout:  5 * time.Second,
		Concurrency:   4,
		PRConcurrency: 2,
	}, collect.ExecRunner, time.Now)
	model := tui.New(tui.Config{
		Interval:         interval,
		InactiveInterval: 6 * interval,
		FleetInterval:    15 * time.Second,
		PRInterval:       90 * time.Second,
	}, source, time.Now)
	if _, err := tea.NewProgram(model, tea.WithAltScreen()).Run(); err != nil {
		fail(err.Error())
	}
}
