# fleetwatch

Live terminal view of firstmate's agents: no-mistakes stage, PRs, status, and captain decisions.

fleetwatch is meant to run in its own Ghostty window or herdr pane next to the fleet.
It lists every agent on the left, grouped by project, and shows the selected agent in detail on the right.
Enter jumps to that agent's pane in herdr.

## Install

fleetwatch needs Node.js 22 or newer.

```sh
npm i -g fleetwatch
```

From a clone:

```sh
npm install
npm run build
npm i -g .
```

Either puts a `fleetwatch` command on your `PATH`.

At run time fleetwatch shells out to tools the fleet already uses:

| Tool | Used for |
| --- | --- |
| A firstmate home (`bin/`, `state/`) | The fleet snapshot, per-task state, meta, and status logs |
| `no-mistakes` | Pipeline steps, the active step, gates, and findings |
| `gh`, authenticated | PR state and checks |
| `herdr` | Focusing an agent's pane on Enter |

A missing tool only blanks the part of the view that depends on it.

## Usage

```sh
fleetwatch --home ~/firstmate    # watch the firstmate home at ~/firstmate
FM_HOME=~/firstmate fleetwatch   # the same, from the environment
```

fleetwatch has no default home: `--home` wins over `$FM_HOME`, and with neither it exits with an error.
`--home` is its only flag.

## Keys

| Key | Action |
| --- | --- |
| `↑` `↓` or `k` `j` | Select an agent |
| `g` `G` or Home End | First or last agent |
| Enter | Focus the selected agent's pane in herdr |
| `/` | Filter by id, project, state, or text; Enter keeps it, Esc clears it |
| Esc | Clear the filter |
| `d` | Hide or show inactive (done, unknown, absent) agents |
| PgUp PgDn | Scroll the detail pane |
| `r` | Refresh everything now, including merged PRs |
| `q` or Ctrl+C | Quit |

## What it shows

The list pins agents with something waiting on the captain at the top, then groups the rest by project.
Within a group, working agents come first and inactive ones last, dimmed.
Each row shows the agent's pipeline stage (or its state when it has no run) and the time since its last activity.

The detail pane shows, for the selected agent:

- **Now**: its current state and what it is doing, with the time since its last status line or harness event.
- **Waiting on the captain**: open captain holds for the task, `needs-decision` status lines no `resolved` line closed, and `ask-user` findings parked at a no-mistakes gate.
- **Pipeline**: the no-mistakes run, each step's status, the active step and how long it has run, gate findings, and any failure.
- **Pull request**: state, draft, checks, merge state, and review decision.
- **Status log**: the latest status lines.
- **Endpoint**: the herdr pane, worktree, and branch, plus how old this agent's data is.

The header shows how old the fleet snapshot and PR reads are.
A failed read keeps the last good data on screen, says so, and flags it stale once it is well past its interval.

## Where the data comes from

fleetwatch only reads.
It never writes to firstmate state, steers an agent, merges, or tears anything down.
Every command runs in the background under a timeout, so a slow command never blocks the view.

| Source | Command or file | Cadence |
| --- | --- | --- |
| Fleet snapshot | `bin/fm-bearings-snapshot.sh --json --all-in-flight` | Every 15s |
| Current task state | `bin/fm-crew-state.sh <task>` | Every 5s |
| Meta, status log, busy state | `state/<task>.meta`, `.status`, `.busy-state` | Every 5s |
| Pipeline | `no-mistakes axi status --run <id>`, else `no-mistakes axi status` in the worktree | Every 5s |
| PR and checks | `gh pr view <url> --json ...` | Every 90s |
| Focus | `herdr agent focus <pane> --session <session>` | On Enter |

Done and unknown agents are re-read every 30s instead of every 5s.
Absent agents, such as remote secondmate homes, are not read at all.
Merged and closed PRs are read once and then only on `r`.
At most four local commands and two GitHub reads run at once.

The snapshot's parent-side cache of remote secondmate summaries goes to the user cache directory (`~/Library/Caches/fleetwatch` on macOS, `$XDG_CACHE_HOME/fleetwatch` or `~/.cache/fleetwatch` elsewhere) instead of the home's `state/`.
The pipeline read uses the run id crew-state names; without one, the worktree's latest run counts only when it is on the task's own branch.

Remote secondmate homes are shown as absent: fleetwatch v1 does not read homes over ssh, and does not list their children.
A local secondmate's children are read from that secondmate's own home.

## Development

```sh
npm install
npm run typecheck # type-check the sources and tests
npm test          # type-check, then run the tests with the Node test runner
npm run build     # compile src/ to dist/, the files the package publishes
node dist/cli.js  # run the local build
```

Tests cover every parser, the model's update logic, and the app's wiring of keys and background reads.
They use synthetic fixtures under `test/fixtures`, written in the exact shapes of the real command output and state files, and need no live firstmate home, herdr, GitHub, or no-mistakes daemon.

CI runs the type-check, the tests, and the build on Node 22 and 24.

## License

MIT, see [LICENSE](LICENSE).
