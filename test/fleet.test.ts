import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {parseBearings, secondmateHost} from '../src/fleet/bearings.js';
import {askUser, needsHuman, parsePipeline, position, statusLabel} from '../src/fleet/pipeline.js';
import {parseToon, toonObject, toonString, toonTable} from '../src/fleet/toon.js';
import {openDecisions, parseCrewState, parseMeta, parseStatusLog} from '../src/fleet/task.js';
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
		assert.match(failed.error, /^step pr failed: gh pr create/);

		const passed = parsePipeline(fixture('nm-passed.toon'));
		assert.equal(passed.status, 'completed');

		const cancelled = parsePipeline(fixture('nm-cancelled.toon'));
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
		}
		assert.throws(() => parsePipeline('error: daemon unreachable\n'), /neither a run nor a current branch/);
	});
});

describe('position', () => {
	test('a gate, an active step, and a failed step hold the run where it stands', () => {
		const gate = parsePipeline(fixture('nm-gate.toon'));
		assert.deepEqual(position(gate), {step: 'review', finished: false, status: 'awaiting_approval', spent: '1d9h'});
		const fixReview = {...gate, awaitingAgent: '', gate: {...gate.gate!, status: 'fix_review'}};
		assert.deepEqual(position(fixReview), {step: 'review', finished: false, status: 'fix_review', spent: ''});
		assert.deepEqual(position(parsePipeline(fixture('nm-ci-running.toon'))), {step: 'ci', finished: false, status: 'running', spent: '1d9h'});
		assert.deepEqual(position(parsePipeline(fixture('nm-failed-pr.toon'))), {step: 'pr', finished: false, status: 'failed', spent: ''});
	});

	test('passed and cancelled runs are finished with their outcome', () => {
		assert.deepEqual(position(parsePipeline(fixture('nm-passed.toon'))), {step: '', finished: true, status: 'passed', spent: ''});
		assert.deepEqual(position(parsePipeline(fixture('nm-cancelled.toon'))), {step: '', finished: true, status: 'cancelled', spent: ''});
	});

	test('a run between steps stands at its first open step', () => {
		const gate = parsePipeline(fixture('nm-gate.toon'));
		const between = {...gate, gate: undefined, steps: gate.steps.map((s) => (s.name === 'review' ? {...s, status: 'completed'} : s))};
		assert.deepEqual(position(between), {step: 'test', finished: false, status: 'pending', spent: ''});
	});

	test('statuses waiting on a person, spelled in words', () => {
		assert.deepEqual(['awaiting_approval', 'fix_review', 'failed', 'running', 'fixing', 'passed'].map(needsHuman), [true, true, true, false, false, false]);
		assert.equal(statusLabel('awaiting_approval'), 'awaiting approval');
		assert.equal(statusLabel('fix_review'), 'fix review');
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
		assert.equal(secondmateHost(b, 'spare'), 'buildbox');
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
