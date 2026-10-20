import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {parseBearings, recordedPr, secondmateHost} from '../src/fleet/bearings.js';
import {askUser, parsePipeline, stage} from '../src/fleet/pipeline.js';
import {checksSummary, isTerminal, parsePr} from '../src/fleet/pr.js';
import {parseToon, toonObject, toonString, toonTable} from '../src/fleet/toon.js';
import {lastStamped, openDecisions, parseBusy, parseCrewState, parseMeta, parseStatusLog} from '../src/fleet/task.js';
import {fixture} from './helpers.js';

describe('parseToon', () => {
	test('decodes scalars, nested objects, tables, and inline arrays', () => {
		const doc = parseToon(fixture('nm-gate.toon'));
		const run = toonObject(doc, 'run');
		assert.equal(toonString(run, 'id'), '01JXB56R3S8P2RMK6RQF9R4EN9');
		const pipeline = toonObject(toonObject(doc, 'branch_sync'), 'pipeline');
		assert.equal(toonString(pipeline, 'phase'), 'pre_push');
		assert.equal(toonString(pipeline, 'pushed_head'), '');
		const steps = toonTable(run, 'steps');
		assert.equal(steps.length, 9);
		assert.equal(steps[2]!['status'], 'awaiting_approval');
		const help = doc['help'] as string[];
		assert.equal(help.length, 6);
		assert.match(help[4]!, /background it if your harness needs to, but/);
		const findings = toonTable(toonObject(doc, 'gate'), 'findings');
		assert.equal(findings.length, 2);
		assert.match(findings[0]!['description']!, /^resolvePackingMode\(\) now ignores/);
	});

	test('rejects an orphan indented line', () => {
		assert.throws(() => parseToon('a: 1\n    b: 2\n'), /unexpected indentation/);
	});
});

describe('parsePipeline', () => {
	test('a run parked at a review gate', () => {
		const p = parsePipeline(fixture('nm-gate.toon'));
		assert.equal(p.status, 'running');
		assert.equal(stage(p), 'review gate');
		assert.equal(p.gate?.step, 'review');
		assert.deepEqual(p.gate?.findings[1], {
			id: 'invoice-fee-row-unverified',
			severity: 'warning',
			file: 'src/Billing/InvoiceExporter.php',
			action: 'ask-user',
			description: p.gate?.findings[1]?.description,
		});
		assert.equal(askUser(p).length, 2);
		assert.equal(p.awaitingAgent, 'parked 1d9h');
		assert.equal(p.findings, '2 awaiting');
		assert.deepEqual(p.steps[2], {name: 'review', status: 'awaiting_approval', findings: 2, durationMs: 102680});
	});

	test('a ci step monitoring a PR', () => {
		const p = parsePipeline(fixture('nm-ci-running.toon'));
		assert.equal(stage(p), 'ci running');
		assert.deepEqual(p.active, [
			{
				step: 'ci',
				status: 'running',
				activeFor: '1d9h',
				lastActivity: '1m29s ago: log: no CI checks reported yet, waiting for checks to register...',
				round: 'starting',
			},
		]);
		assert.equal(p.pr, 'https://github.com/example-org/shop-web/pull/87');
		assert.equal(p.gate, undefined);
	});

	test('terminal runs', () => {
		const failed = parsePipeline(fixture('nm-failed-pr.toon'));
		assert.equal(failed.outcome, 'failed');
		assert.equal(stage(failed), 'failed at pr');
		assert.match(failed.error, /^step pr failed: gh pr create/);

		const passed = parsePipeline(fixture('nm-passed.toon'));
		assert.equal(passed.status, 'completed');
		assert.equal(stage(passed), 'passed');

		const cancelled = parsePipeline(fixture('nm-cancelled.toon'));
		assert.equal(stage(cancelled), 'cancelled at ci');
		assert.equal(cancelled.branch, 'fm/web-admin-dev-sync');
		assert.equal(cancelled.error, 'cancelled: aborted by user');
		for (const p of [failed, passed, cancelled]) assert.equal(p.steps.length, 9);
	});

	test('output without a run', () => {
		for (const [file, branch, note] of [
			['nm-no-runs.toon', 'fm/cli-status-view', '0 runs yet in this repository'],
			['nm-detached.toon', 'unknown', '0 runs yet in this repository'],
			['nm-runs-list.toon', 'unknown', 'no run attributed to this worktree (10 of 150 total runs listed)'],
		] as const) {
			const p = parsePipeline(fixture(file));
			assert.equal(p.noRun, true, file);
			assert.equal(p.branch, branch, file);
			assert.equal(p.note, note, file);
			assert.equal(stage(p), 'no run');
		}
		assert.throws(() => parsePipeline('error: daemon unreachable\n'), /neither a run nor a current branch/);
	});
});

describe('parseBearings', () => {
	test('decodes the snapshot', () => {
		const b = parseBearings(fixture('bearings.json'));
		assert.equal(b.home, 'code/firstmate');
		assert.equal(b.generated, '2026-10-20T21:54:15Z');
		assert.equal(b.inFlight.length, 9);
		assert.equal(b.decisions.length, 4);
		assert.equal(b.secondmates.length, 1);
		const {doing: _doing, ...row} = b.inFlight[7]!;
		assert.deepEqual(row, {id: 'pack-option-api', kind: 'ship', state: 'parked', repo: 'shop-api', name: 'API side of the packing option at checkout.'});
		assert.deepEqual(b.decisions[2], {
			id: 'spare/runbook-docs',
			key: 'runbook-docs',
			verb: 'captain-hold',
			summary: b.decisions[2]!.summary,
			owner: 'spare',
		});
		assert.equal(recordedPr(b, 'api-catalog-scope'), 'https://github.com/example-org/shop-api/pull/188');
		assert.equal(secondmateHost(b, 'spare'), 'buildbox');
		assert.equal(recordedPr(b, 'nope'), '');
		assert.equal(secondmateHost(b, 'nope'), '');
	});

	test('rejects other schemas and bad JSON', () => {
		assert.throws(() => parseBearings('{"schema":"fm-bearings.v2"}'), /schema/);
		assert.throws(() => parseBearings('not json'), /bearings:/);
	});
});

describe('parseCrewState', () => {
	test('crew-state lines', () => {
		const cases = {
			'crew-pack-option-api.txt': {
				state: 'parked',
				source: 'run-step',
				detail: 'parked at review: 2 finding(s) · ask-user: authority decision · run: 01JXB56R3S8P2RMK6RQF9R4EN9',
				runId: '01JXB56R3S8P2RMK6RQF9R4EN9',
			},
			'crew-pack-option-web.txt': {
				state: 'working',
				source: 'run-step',
				detail: 'validating (running) · run: 01JXHQQMXAAMQFC2392B359VRQ',
				runId: '01JXHQQMXAAMQFC2392B359VRQ',
			},
			'crew-mailer-send-limits.txt': {
				state: 'failed',
				source: 'run-step',
				detail: 'run failed · status-log superseded (run failed) · run: 01JXFHFAZBQ6EPNQXJJX41RA0F',
				runId: '01JXFHFAZBQ6EPNQXJJX41RA0F',
			},
			'crew-cli-status-view.txt': {state: 'working', source: 'pane', detail: 'harness busy (claude-hook)', runId: ''},
			'crew-wiki-db-claims-check.txt': {state: 'unknown', source: 'none', detail: 'worktree gone (torn down?)', runId: ''},
		};
		for (const [file, want] of Object.entries(cases)) assert.deepEqual(parseCrewState(fixture(file)), want, file);
		const scout = parseCrewState(fixture('crew-dev-inventory.txt'));
		assert.equal(scout.state, 'parked');
		assert.equal(scout.source, 'status-log');
		assert.equal(scout.runId, '');
	});

	test('rejects other output', () => {
		for (const bad of ['', 'usage: fm-crew-state.sh <id>', 'state: working']) assert.throws(() => parseCrewState(bad), /crew-state:/, bad);
	});
});

test('parseMeta', () => {
	const m = parseMeta(fixture('web.meta'));
	assert.equal(m.worktree, '/home/dev/.treehouse/shop-web-3f2a1c/4/shop-web');
	assert.equal(m.kind, 'ship');
	assert.equal(m.mode, 'no-mistakes');
	assert.equal(m.model, 'opus');
	assert.equal(m.effort, 'high');
	assert.equal(m.branch, 'fm/pack-option-web');
	assert.equal(m.herdrSession, 'default');
	assert.equal(m.herdrPane, 'wBR:p2');
	assert.equal(m.pr, 'https://github.com/example-org/shop-web/pull/87');
	assert.equal(m.remoteHost, '');

	const scout = parseMeta(fixture('scout.meta'));
	assert.deepEqual(scout.decisionKeys, ['release-picks']);
	assert.equal(scout.mode, '');

	const remote = parseMeta(fixture('remote-secondmate.meta'));
	assert.equal(remote.kind, 'secondmate');
	assert.equal(remote.remoteHost, 'buildbox');
	assert.equal(remote.home, '/home/dev/firstmate-spare');
	assert.equal(remote.window, 'remote:spare');
});

describe('parseStatusLog', () => {
	test('stamped entries with tags in either order', () => {
		const entries = parseStatusLog(fixture('web.status'));
		assert.equal(entries.length, 11);
		const e = entries[2]!;
		assert.equal(e.state, 'resolved');
		assert.equal(e.key, 'pack-signed-amount');
		assert.equal(e.at, 1792411614_000);
		assert.match(e.text, /^answered: Decision for pack-signed-amount/);
		assert.equal(lastStamped(entries), 1792414994_000);
		assert.deepEqual(openDecisions(entries), [], 'every decision was resolved');
	});

	test('open decisions', () => {
		const api = openDecisions(parseStatusLog(fixture('api.status')));
		assert.deepEqual(
			api.map((e) => e.key),
			['nm-01JXB56R3S8P2RMK6RQF9R4EN9-review'],
		);
		const scout = openDecisions(parseStatusLog(fixture('scout.status')));
		assert.equal(scout.length, 1);
		assert.equal(scout[0]!.key, 'board-review');
		assert.equal(scout[0]!.at, 1792154370_000);
	});

	test('legacy and continuation lines', () => {
		// Legacy shapes: no stamp, an entry spanning lines, a keyless decision.
		const log =
			'working: setup done, studying design + phase 1 code\n' +
			'needs-decision: two captain calls\n' +
			'DECISION 1: may that one-line pre-existing-dev-bug fix ride on PR 155?\n' +
			'done [corr=bNdaNdfNeNaN] [at=1792000000]: report written\n';
		const entries = parseStatusLog(log);
		assert.equal(entries.length, 3);
		assert.equal(entries[0]!.at, undefined);
		assert.equal(entries[1]!.text, 'two captain calls\nDECISION 1: may that one-line pre-existing-dev-bug fix ride on PR 155?');
		assert.equal(entries[2]!.at, 1792000000_000);
		assert.equal(entries[2]!.key, '');
		assert.equal(openDecisions(entries).length, 1, 'keyless decision stays open');
		assert.equal(openDecisions(parseStatusLog(log + 'resolved [at=1792000100]: answered\n')).length, 0, 'keyless resolved closes it');
	});
});

test('parseBusy', () => {
	assert.deepEqual(parseBusy(fixture('busy.busy-state')), {state: 'busy', source: 'claude-hook', event: 'user-prompt-submit', at: 1792533201_000});
	const idle = parseBusy(fixture('idle.busy-state'));
	assert.equal(idle.state, 'idle');
	assert.equal(idle.event, 'session-end');
	assert.throws(() => parseBusy('v2 state=busy'), /unsupported record/);
});

describe('parsePr', () => {
	test('gh pr view output', () => {
		const open = parsePr(fixture('gh-open-green.json'));
		assert.equal(open.number, 188);
		assert.equal(open.state, 'OPEN');
		assert.equal(open.draft, false);
		assert.equal(open.mergeState, 'CLEAN');
		assert.equal(isTerminal(open), false);
		assert.equal(open.checks.total, 2);
		assert.equal(open.checks.passed, 2);
		assert.equal(checksSummary(open.checks), '2/2 passing');

		assert.equal(checksSummary(parsePr(fixture('gh-no-checks.json')).checks), 'no checks');
		const merged = parsePr(fixture('gh-merged.json'));
		assert.equal(merged.state, 'MERGED');
		assert.equal(isTerminal(merged), true);
		assert.throws(() => parsePr('{}'), /no pull request number/);
	});

	test('a rollup mixing CheckRun and StatusContext entries', () => {
		const pr = parsePr(
			JSON.stringify({
				number: 3,
				state: 'OPEN',
				statusCheckRollup: [
					{__typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE'},
					{__typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: ''},
					{__typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED'},
					{__typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING'},
					{__typename: 'StatusContext', context: 'deploy', state: 'SUCCESS'},
				],
			}),
		);
		const c = pr.checks;
		assert.deepEqual([c.total, c.failed, c.pending, c.skipped, c.passed], [5, 1, 2, 1, 1]);
		assert.equal(checksSummary(c), '1 failing: test');
		assert.equal(checksSummary({...c, failed: 0, failedNames: []}), '2 pending: lint, ci/legacy');
	});
});
