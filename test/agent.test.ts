import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
	buildRoster,
	captainDecisions,
	currentDoing,
	currentState,
	isInactive,
	lastActivity,
	prUrl,
	SECONDMATE_GROUP,
	type Agent,
	type Detail,
} from '../src/fleet/agent.js';
import {MAIN_OWNER, parseBearings, type Bearings} from '../src/fleet/bearings.js';
import {parsePipeline} from '../src/fleet/pipeline.js';
import {parseBusy, parseCrewState, parseMeta, parseStatusLog} from '../src/fleet/task.js';
import {fixture} from './helpers.js';

const bearings = () => parseBearings(fixture('bearings.json'));
const remoteMeta = () => new Map([['spare', parseMeta(fixture('remote-secondmate.meta'))]]);
const detail = (d: Partial<Detail>): Detail => ({status: [], fetchedAt: 0, ...d});

test('a remote secondmate is one absent row and its children are not listed', () => {
	const b = bearings();
	b.inFlight.push({id: 'spare/bulk-order-design', kind: 'ship', state: 'working', repo: 'shop-api', name: '', doing: ''});
	const agents = buildRoster(b, '/fm', remoteMeta());
	assert.equal(agents.length, 10, '9 tasks and 1 secondmate');
	assert.ok(!agents.some((a) => a.id === 'spare/bulk-order-design'));
	const sm = agents[9]!;
	assert.equal(sm.id, 'spare');
	assert.equal(sm.absent, true);
	assert.equal(sm.secondmate, true);
	assert.equal(sm.repo, SECONDMATE_GROUP);
	assert.equal(sm.absentReason, 'remote home on buildbox is not read by fleetwatch v1');
	assert.equal(currentState(sm), 'absent');
	assert.deepEqual(captainDecisions(sm, undefined, b.decisions), []);
	const a = agents[0]!;
	assert.deepEqual(
		[a.id, a.taskId, a.home, a.owner, a.repo],
		['web-admin-console', 'web-admin-console', '/fm', MAIN_OWNER, 'shop-web'],
	);
});

test('without its meta, a secondmate is remote by the snapshot reconcile host', () => {
	const agents = buildRoster(bearings(), '/fm', new Map());
	const sm = agents.at(-1)!;
	assert.equal(sm.absent, true);
	assert.equal(sm.absentReason, 'remote home on buildbox is not read by fleetwatch v1');
});

test('a local secondmate child is read from that secondmate home', () => {
	const b: Bearings = {
		...bearings(),
		inFlight: [{id: 'sm1/fix-login', kind: 'ship', state: 'working', repo: '/home/dev/firstmate/projects/webapp', name: '', doing: ''}],
		secondmates: [{id: 'sm1', state: 'active_child_work', doing: ''}],
		reconcile: [],
	};
	const agents = buildRoster(b, '/fm', new Map([['sm1', {...parseMeta('kind=secondmate'), home: '/fm-sm1'}]]));
	assert.equal(agents.length, 2);
	const child = agents[0]!;
	assert.deepEqual([child.owner, child.taskId, child.home, child.repo], ['sm1', 'fix-login', '/fm-sm1', 'webapp']);
	assert.equal(agents[1]!.absent, false);
	assert.equal(agents[1]!.home, '/fm');
});

test('captain decisions come from holds, open needs-decision lines, and ask-user findings', () => {
	const b = bearings();
	const byId = new Map(buildRoster(b, '/fm', remoteMeta()).map((a) => [a.id, a]));

	const scout = detail({meta: parseMeta(fixture('scout.meta')), status: parseStatusLog(fixture('scout.status'))});
	const got = captainDecisions(byId.get('dev-inventory')!, scout, b.decisions);
	assert.deepEqual(
		got.map((d) => [d.source, d.key]),
		[
			['captain-hold', 'release-picks'],
			['needs-decision', 'board-review'],
		],
	);

	const api = detail({status: parseStatusLog(fixture('api.status')), pipeline: parsePipeline(fixture('nm-gate.toon'))});
	assert.deepEqual(
		captainDecisions(byId.get('pack-option-api')!, api, b.decisions).map((d) => [d.source, d.key]),
		[
			['needs-decision', 'nm-01JXB56R3S8P2RMK6RQF9R4EN9-review'],
			['ask-user', 'admin-toggle-overridden'],
			['ask-user', 'invoice-fee-row-unverified'],
		],
	);

	const client = detail({status: parseStatusLog(fixture('web.status'))});
	assert.deepEqual(captainDecisions(byId.get('pack-option-web')!, client, b.decisions), []);
});

test('crew-state wins over the bearings reading once read', () => {
	const a = {state: 'working', doing: 'harness busy (claude-hook)', absent: false} as Agent;
	assert.equal(currentState(a), 'working');
	assert.equal(currentDoing(a, detail({})), 'harness busy (claude-hook)');
	const crew = parseCrewState(fixture('crew-mailer-send-limits.txt'));
	assert.equal(currentState(a, detail({crew})), 'failed');
	assert.equal(currentDoing(a, detail({crew})), crew.detail);
	assert.deepEqual(
		['done', 'unknown', 'absent', 'parked', 'failed'].map(isInactive),
		[true, true, true, false, false],
	);
});

test('last activity is the newest of status stamps, status log writes, and busy events', () => {
	const d = detail({status: parseStatusLog(fixture('api.status')), busy: parseBusy(fixture('idle.busy-state'))});
	assert.equal(lastActivity(d), 1792522585_000);
	d.busy = undefined;
	assert.equal(lastActivity(d), 1792418228_000);
	d.statusModified = 1792500000_000;
	assert.equal(lastActivity(d), 1792500000_000);
	assert.equal(lastActivity(undefined), undefined);
});

test('the PR comes from meta, then bearings, then the pipeline run', () => {
	const b = bearings();
	const a = {id: 'api-catalog-scope'} as Agent;
	const pipeline = {...parsePipeline(fixture('nm-passed.toon')), pr: 'https://github.com/o/r/pull/3'};
	assert.equal(prUrl(a, detail({pipeline}), b), 'https://github.com/example-org/shop-api/pull/188');
	const meta = {...parseMeta(''), pr: 'https://github.com/o/r/pull/9'};
	assert.equal(prUrl(a, detail({meta, pipeline}), b), meta.pr);
	assert.equal(prUrl({id: 'other'} as Agent, detail({pipeline}), b), pipeline.pr);
});
