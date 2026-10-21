# fleetwatch

Live terminal board of firstmate's no-mistakes runs.

![fleetwatch --demo: the board, Enter on a run, Esc back to the board](assets/demo.gif)

fleetwatch is meant to run in its own Ghostty window or herdr pane next to the fleet.
It opens on a kanban board: one column per no-mistakes pipeline step, one card per task with a run.
Enter opens the selected run in no-mistakes' own view, where you follow it and make its decisions.
Inside herdr that view opens in a popup over the board, and Esc closes it while the run keeps going.

The recording above is `fleetwatch --demo`, made from [assets/demo.tape](assets/demo.tape) with [vhs](https://github.com/charmbracelet/vhs).
vhs records a plain terminal rather than herdr, so there the run opens full screen instead of in a popup.

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
| `no-mistakes` | Pipeline steps, the active step, gates, and findings; its own view of a run on Enter |
| herdr, optional | A popup over the board for that view, once `fleetwatch herdr-setup` has linked fleetwatch's plugin |

Without `no-mistakes`, cards land in the **no run** column as unreadable, and Enter reports the missing tool.

## Usage

```sh
fleetwatch --home ~/firstmate    # watch the firstmate home at ~/firstmate
FM_HOME=~/firstmate fleetwatch   # the same, from the environment
fleetwatch --demo                # watch a built-in synthetic fleet
fleetwatch herdr-setup           # let Enter open runs in a herdr popup
```

fleetwatch has no default home: `--home` wins over `$FM_HOME`, and with neither it exits with an error.
`--demo` needs neither: it shows a built-in fleet of made-up projects, tasks, and runs.
Enter on a demo card opens a synthetic stand-in for no-mistakes' view, so the demo never reads or starts a no-mistakes daemon.

## Keys

| Key | Action |
| --- | --- |
| `←` `→` or `h` `l` | Move to the next column with cards |
| `↑` `↓` or `k` `j` | Select a card in the column |
| Enter | Open the selected run in no-mistakes: in a herdr popup inside herdr, else full screen |
| Esc, in a run's popup | Close the popup and return to the board; the run keeps going |
| `/` | Filter by id, project, state, status as the card shows it, or text; Enter keeps it, Esc clears it |
| Esc | Clear the filter |
| `r` | Refresh everything now |
| `q` or Ctrl+C | Quit |

## The board

The board has one column per no-mistakes pipeline step, in pipeline order: intent, rebase, review, test, document, lint, push, pr, and ci.
A run that reports other steps adds them in its own order.
A leading **no run** column holds tasks whose worktree has no run yet, and tasks whose run could not be read.
A final **finished** column holds runs that reached their outcome, such as passed or cancelled.

Each card is one task with a no-mistakes run, in the column of the step its run stands at:

- the step parked at a gate, awaiting approval or fix review;
- else the step that is running or fixing;
- else, for a failed run, the step that failed;
- else the first step that has not completed.

A card shows the task, the step status as no-mistakes names it, the project, and how long the run has been at that step.
That time is what no-mistakes reports for a running step or a parked gate; other cards show no time.
Cards waiting on a person (awaiting approval, fix review, or failed) lead their column and are drawn in the decision colour, and ⚑ marks a task with an open captain decision.

An empty column shrinks to its name so the busy ones get the room.
When the columns still do not fit, the board scrolls sideways to follow the selection, and the bottom line counts the columns off either side.
The bottom line also names the selected task, its run, and any error.

The header shows how old the fleet snapshot is.
A failed read keeps the last good data on screen, says so, and flags it stale once it is well past its interval.

## Opening a run

Enter on a card runs `no-mistakes attach --run <run id>` in the task's worktree, or in its firstmate home once the worktree is gone.
Everything you see and decide in there is no-mistakes' own screen and behaviour.

Inside herdr, the view opens in a popup over the board, and the board keeps refreshing underneath.
Esc closes the popup and returns to the board without stopping, aborting, or otherwise changing the run.
The footer says so: `enter open run (esc closes it)`.

Esc works by leaving no-mistakes' view the way no-mistakes itself offers.
The popup runs no-mistakes on a terminal of its own and turns a lone Esc into Ctrl+C, which no-mistakes treats as detach in every screen, including its editors; the pipeline keeps running in its daemon.
`q` detaches too, as in no-mistakes.
Inside the popup, Esc therefore no longer closes no-mistakes' own help, diff, or editors: `?` and `d` toggle help and diff, and Esc leaves an editor along with the view.
Aborting a run is still only no-mistakes' own `x`, pressed twice.

Outside herdr, fleetwatch hands its whole terminal to no-mistakes until you leave its view with `q`, then redraws the board and re-reads that task.
The same happens inside herdr when the plugin is not linked, and the footer then says why.
If no-mistakes is missing or the attach fails, the board comes back with the reason in its footer.

## The herdr popup

herdr opens popups only for plugin panes, so fleetwatch ships a minimal herdr plugin in `herdr-plugin/`.
It declares one popup pane that runs fleetwatch's run view, and nothing else: no actions, startup or event hooks, or keybindings.
Link it once:

```sh
fleetwatch herdr-setup
```

That runs `herdr plugin link` on the plugin directory inside the installed package.
It changes no herdr configuration; herdr records the link in its plugin registry, for every herdr session of your user.
Undo it with `herdr plugin unlink fleetwatch`.
If fleetwatch moves, such as after a reinstall under another Node version, unlink and run `fleetwatch herdr-setup` again.
The popup needs herdr 0.7.4 or newer.

## Where the data comes from

fleetwatch only reads.
It never writes to firstmate state, steers an agent, merges, or tears anything down.
Every command runs in the background under a timeout, so a slow command never blocks the view.
The one exception is opening a run outside a herdr popup, which hands the terminal to no-mistakes until you leave it.

| Source | Command or file | Cadence |
| --- | --- | --- |
| Fleet snapshot | `bin/fm-bearings-snapshot.sh --json --all-in-flight` | Every 15s |
| Current task state | `bin/fm-crew-state.sh <task>` | Every 5s |
| Meta and status log | `state/<task>.meta`, `.status` | Every 5s |
| Pipeline | `no-mistakes axi status --run <id>`, else `no-mistakes axi status` in the worktree | Every 5s |
| Run view | `no-mistakes attach --run <id>` in the worktree, in a herdr popup or full screen | On Enter |

Done and unknown agents are re-read every 30s instead of every 5s.
Absent agents, such as remote secondmate homes, are not read at all.
At most four local commands run at once.

The snapshot's parent-side cache of remote secondmate summaries goes to the user cache directory (`~/Library/Caches/fleetwatch` on macOS, `$XDG_CACHE_HOME/fleetwatch` or `~/.cache/fleetwatch` elsewhere) instead of the home's `state/`.
The pipeline read uses the run id crew-state names; without one, the worktree's latest run counts only when it is on the task's own branch.

fleetwatch does not read remote secondmate homes over ssh, so their children's runs are not on the board.
A local secondmate's children are read from that secondmate's own home.

## Development

```sh
npm install
npm run typecheck # type-check the sources and tests
npm test          # type-check, then run the tests with the Node test runner
npm run build     # compile src/ to dist/, the files the package publishes
node dist/cli.js  # run the local build
```

Tests cover every parser, the board's column placement and navigation, the model's update logic, the attach command, and the app's wiring of keys, background reads, and the run view.
They also cover the choice between the herdr popup and the full-screen view, the popup request herdr receives, Esc turning into a detach, and the demo fleet.
They use synthetic fixtures under `test/fixtures`, written in the exact shapes of the real command output and state files, and need no live firstmate home, herdr, or no-mistakes daemon.

To re-record the demo GIF after a visible change, install [vhs](https://github.com/charmbracelet/vhs) and run `npm run build && vhs assets/demo.tape`.

CI runs the type-check, the tests, and the build on Node 22 and 24.

## License

MIT, see [LICENSE](LICENSE).
