# Test fixtures

Every fixture here is synthetic.
Each one keeps the exact shape of the real command output or state file it stands in for, with made-up task ids, repositories, paths, URLs, run ids, commit hashes, and text.
`bearings.json` is a cut-down snapshot with fewer rows than a real fleet.

| Fixture | Shape of |
| --- | --- |
| `bearings.json` | `bin/fm-bearings-snapshot.sh --json` |
| `crew-*.txt` | `bin/fm-crew-state.sh <task>` |
| `nm-gate.toon` | `no-mistakes axi status`, run parked at a review gate with ask-user findings |
| `nm-ci-running.toon` | `no-mistakes axi status`, ci step monitoring a PR |
| `nm-failed-pr.toon` | `no-mistakes axi status`, run failed at the pr step |
| `nm-passed.toon` | `no-mistakes axi status`, completed run whose PR merged |
| `nm-cancelled.toon` | `no-mistakes axi status`, cancelled run on another task's branch |
| `nm-no-runs.toon` | `no-mistakes axi status` on a branch without runs |
| `nm-detached.toon` | `no-mistakes axi status` in a detached worktree |
| `nm-runs-list.toon` | `no-mistakes axi status` in a detached worktree of a repo with runs |
| `*.meta` | `state/<task>.meta` of a ship task, a scout, and a remote secondmate |
| `*.status` | `state/<task>.status` |
| `*.busy-state` | `state/<task>.busy-state` |
| `gh-*.json` | `gh pr view <url> --json number,title,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,url,headRefName` |

When a tool's output format changes, update the matching fixture to the new shape with synthetic values, and adjust the expectations in the tests that read it.
Never paste real fleet output here: it carries private task ids, repositories, paths, and text.
