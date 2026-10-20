import assert from 'node:assert/strict';
import {test} from 'node:test';

import type {Fleet} from '../src/collect/collect.js';
import {buildRoster, type Detail} from '../src/fleet/agent.js';
import {parseBearings} from '../src/fleet/bearings.js';
import {parsePipeline} from '../src/fleet/pipeline.js';
import {parsePr, type PR} from '../src/fleet/pr.js';
import {parseCrewState, parseMeta, parseStatusLog} from '../src/fleet/task.js';
import {Model, type Config, type Effect, type Event, type Key} from '../src/tui/model.js';
import {detailLines, footer, freshness, listLines} from '../src/tui/render.js';
import {isHeader} from '../src/tui/rows.js';
import {fixture} from './helpers.js';

const config: Config = {intervalMs: 5000, inactiveIntervalMs: 30_000, fleetIntervalMs: 15_000, prIntervalMs: 90_000};

const apiPR = 'https://github.com/example-org/shop-api/pull/188';
const clientPR = 'https://github.com/example-org/shop-web/pull/87';
const adminPR = 'https://github.com/example-org/shop-web/pull/71';

const liveTasks = ['cli-status-view', 'dev-inventory', 'mailer-send-limits', 'pack-option-api', 'pack-option-web'].map((id) => `task:${id}`);
const inactiveTasks = ['web-admin-console', 'wiki-db-claims-check', 'blog-explainer', 'api-catalog-scope'].map((id) => `task:${id}`);
const sorted = (...lists: string[][]) => lists.flat().sort();

// FakeSource serves the fixtures and records every read.
class FakeSource {
	calls: string[] = [];
	fleetError?: string;
	focusError?: string;
	fleet: Fleet;
	details: Record<string, Detail>;
	prs: Record<string, PR>;

	constructor() {
		const b = parseBearings(fixture('bearings.json'));
		const remote = parseMeta(fixture('remote-secondmate.meta'));
		this.fleet = {bearings: b, agents: buildRoster(b, '/fm', new Map([['spare', remote]]))};
		const apiMeta = {...parseMeta(''), kind: 'ship', mode: 'no-mistakes', branch: 'fm/pack-option-api', herdrSession: 'default', herdrPane: 'w27:p1B'};
		const crew = (f: string) => parseCrewState(fixture(f));
		const d = (x: Partial<Detail>): Detail => ({status: [], fetchedAt: 0, ...x});
		this.details = {
			'pack-option-api': d({
				meta: apiMeta,
				crew: crew('crew-pack-option-api.txt'),
				status: parseStatusLog(fixture('api.status')),
				pipeline: parsePipeline(fixture('nm-gate.toon')),
			}),
			'pack-option-web': d({
				meta: parseMeta(fixture('web.meta')),
				crew: crew('crew-pack-option-web.txt'),
				status: parseStatusLog(fixture('web.status')),
				pipeline: parsePipeline(fixture('nm-ci-running.toon')),
			}),
			'dev-inventory': d({meta: parseMeta(fixture('scout.meta')), crew: crew('crew-dev-inventory.txt'), status: parseStatusLog(fixture('scout.status'))}),
			'mailer-send-limits': d({crew: crew('crew-mailer-send-limits.txt')}),
			'wiki-db-claims-check': d({crew: crew('crew-wiki-db-claims-check.txt')}),
			'cli-status-view': d({crew: crew('crew-cli-status-view.txt')}),
		};
		this.prs = {
			[apiPR]: parsePr(fixture('gh-open-green.json')),
			[clientPR]: parsePr(fixture('gh-no-checks.json')),
			[adminPR]: parsePr(fixture('gh-merged.json')),
		};
	}

	// answer runs one effect and returns the event its result produces.
	answer(e: Effect, now: number): Event | undefined {
		switch (e.kind) {
			case 'fleet':
				this.calls.push('fleet');
				return this.fleetError ? {type: 'fleetError', error: this.fleetError} : {type: 'fleet', fleet: this.fleet};
			case 'task':
				this.calls.push(`task:${e.agent.id}`);
				return {type: 'task', id: e.agent.id, detail: {...(this.details[e.agent.id] ?? {status: []}), fetchedAt: now}};
			case 'pr': {
				this.calls.push(`pr:${e.url}`);
				const pr = this.prs[e.url];
				return pr ? {type: 'pr', url: e.url, pr} : {type: 'prError', url: e.url, error: 'gh: not found'};
			}
			case 'focus':
				this.calls.push(`focus:${e.session}:${e.pane}`);
				return this.focusError ? {type: 'focusError', id: e.id, error: this.focusError} : {type: 'focused', id: e.id};
			case 'quit':
				this.calls.push('quit');
				return undefined;
		}
	}

	take(): string[] {
		const c = this.calls.sort();
		this.calls = [];
		return c;
	}
}

// Harness drives the model like the app does, against a fake clock, running
// each effect at once.
class Harness {
	clock = 1792540000_000;
	src = new FakeSource();
	m = new Model(config, () => this.clock);

	constructor({columns = 140, rows = 40, start = true} = {}) {
		this.send({type: 'resize', columns, rows});
		if (start) this.run(this.m.start());
	}

	send(ev: Event): void {
		this.run(this.m.dispatch(ev));
	}

	run(effects: Effect[]): void {
		for (const e of effects) {
			const ev = this.src.answer(e, this.clock);
			if (ev) this.send(ev);
		}
	}

	advance(ms: number): void {
		this.clock += ms;
		this.send({type: 'tick'});
	}

	key(input: string, key: Key = {}): void {
		this.send({type: 'key', input, key});
	}

	rowIds(): string[] {
		return this.m.rows.map((r) => (isHeader(r) ? `#${r.header}` : this.m.agents[r.agent]!.id));
	}

	select(id: string): void {
		this.key('g');
		for (let i = 0; i < this.m.rows.length && this.m.selected !== id; i++) this.key('', {downArrow: true});
		assert.equal(this.m.selected, id, `could not select ${id}`);
	}
}

const allRows = [
	'#captain decisions',
	'dev-inventory',
	'pack-option-api',
	'#firstmate',
	'blog-explainer',
	'#fleetwatch',
	'cli-status-view',
	'#mailer',
	'mailer-send-limits',
	'#shop-api',
	'api-catalog-scope',
	'#shop-web',
	'pack-option-web',
	'web-admin-console',
	'#shop-wiki',
	'wiki-db-claims-check',
	'#secondmates',
	'spare',
];

test('startup reads the fleet, then each agent and PR once', () => {
	const h = new Harness();
	assert.deepEqual(h.src.take(), sorted(['fleet', `pr:${adminPR}`, `pr:${apiPR}`, `pr:${clientPR}`], liveTasks, inactiveTasks));
	assert.equal(h.m.loaded, true);
	assert.equal(h.m.agents.length, 10);
	for (const e of h.m.prs.values()) {
		assert.ok(e.pr);
		assert.equal(e.pending, false);
	}
});

test('no source is read twice at once', () => {
	const h = new Harness({start: false});
	const first = h.m.start();
	// While the first fleet read is in flight, a tick starts nothing.
	h.clock += 60_000;
	assert.deepEqual(h.m.dispatch({type: 'tick'}), []);

	const reads = h.m.dispatch(h.src.answer(first[0]!, h.clock)!);
	assert.deepEqual(h.src.take(), ['fleet']);
	assert.deepEqual(reads.map((e) => (e.kind === 'task' ? `task:${e.agent.id}` : e.kind === 'pr' ? `pr:${e.url}` : e.kind)).sort(), sorted([`pr:${adminPR}`, `pr:${apiPR}`, `pr:${clientPR}`], liveTasks, inactiveTasks));

	// Agent and PR reads are in flight and due again, but nothing restarts.
	h.clock += 10_000;
	assert.deepEqual(h.m.dispatch({type: 'tick'}), []);
});

test('refresh cadence: live agents, inactive agents, the fleet, and PRs', () => {
	const h = new Harness();
	h.src.take();
	h.advance(3000);
	assert.deepEqual(h.src.take(), [], 'nothing due at 3s');
	h.advance(2000);
	assert.deepEqual(h.src.take(), sorted(liveTasks), 'live agents due at 5s');
	h.advance(10_000);
	assert.deepEqual(h.src.take(), sorted(['fleet'], liveTasks), 'fleet and live agents due at 15s');
	h.advance(15_000);
	assert.deepEqual(h.src.take(), sorted(['fleet'], liveTasks, inactiveTasks), 'inactive agents due at 30s');
	h.advance(60_000);
	const got = h.src.take();
	assert.ok(got.includes(`pr:${apiPR}`) && got.includes(`pr:${clientPR}`), 'open PRs re-read at 90s');
	assert.ok(!got.includes(`pr:${adminPR}`), 'a merged PR is not re-read on the timer');
});

test('r re-reads everything, merged PRs included', () => {
	const h = new Harness();
	h.src.take();
	h.advance(1000);
	h.key('r');
	assert.deepEqual(h.src.take(), sorted(['fleet', `pr:${adminPR}`, `pr:${apiPR}`, `pr:${clientPR}`], liveTasks, inactiveTasks));
	assert.equal(h.m.flash, 'refreshing');
});

test('agents with a captain decision are pinned, the rest grouped by project', () => {
	const h = new Harness();
	assert.deepEqual(h.rowIds(), allRows);
	assert.equal(h.m.selected, 'dev-inventory', 'the top agent is selected until the user moves');
	assert.equal(h.m.cursor, 1);
	assert.equal(h.m.infos.get('pack-option-api')!.decisions.length, 3);
});

test('d hides inactive agents but never a pending decision', () => {
	const h = new Harness();
	h.key('d');
	assert.deepEqual(h.rowIds(), [
		'#captain decisions',
		'dev-inventory',
		'pack-option-api',
		'#fleetwatch',
		'cli-status-view',
		'#mailer',
		'mailer-send-limits',
		'#shop-web',
		'pack-option-web',
	]);
	const client = h.m.rows.find((r) => isHeader(r) && r.header === 'shop-web');
	assert.deepEqual(client, {header: 'shop-web', count: 1, hidden: 1});
	assert.equal(h.m.hidden, 5);
	assert.match(footer(h.m), /d show 5 inactive/);
	h.key('d');
	assert.deepEqual(h.rowIds(), allRows);
});

test('/ filters as you type; enter keeps it, esc clears it', () => {
	const h = new Harness();
	h.key('/');
	assert.equal(h.m.filtering, true);
	for (const ch of 'mailer') h.key(ch);
	assert.deepEqual(h.rowIds(), ['#mailer', 'mailer-send-limits']);
	assert.equal(h.m.selected, 'mailer-send-limits');
	h.key('q');
	assert.deepEqual(h.rowIds(), [], 'q is typed into the filter, not quit');
	assert.deepEqual(h.src.take().filter((c) => c === 'quit'), []);
	h.key('', {backspace: true});
	h.key('', {return: true});
	assert.equal(h.m.filtering, false);
	assert.equal(h.m.filter, 'mailer');
	assert.match(footer(h.m), /filter: mailer/);
	h.key('', {escape: true});
	assert.equal(h.m.filter, '');
	assert.deepEqual(h.rowIds(), allRows);
	h.key('/');
	h.key('parked');
	h.key('', {escape: true});
	assert.equal(h.m.filtering, false);
	assert.equal(h.m.filter, '');
});

test('navigation skips headers and stops at the ends', () => {
	const h = new Harness();
	h.key('', {upArrow: true});
	assert.equal(h.m.selected, 'dev-inventory');
	h.key('j');
	h.key('j');
	assert.equal(h.m.selected, 'blog-explainer', 'down skips the group header');
	h.key('G');
	assert.equal(h.m.selected, 'spare');
	h.key('', {downArrow: true});
	assert.equal(h.m.selected, 'spare');
	h.key('k');
	assert.equal(h.m.selected, 'wiki-db-claims-check');
	h.key('', {home: true});
	assert.equal(h.m.selected, 'dev-inventory');
});

test('the selection follows its agent when it regroups', () => {
	const h = new Harness();
	h.select('mailer-send-limits');
	const d = {...h.src.details['mailer-send-limits']!, status: parseStatusLog('needs-decision [at=1792540000] [key=push-route]: grant write access or fork\n')};
	h.send({type: 'task', id: 'mailer-send-limits', detail: d});
	assert.equal(h.m.selected, 'mailer-send-limits');
	assert.equal(h.rowIds()[h.m.cursor], 'mailer-send-limits');
	assert.ok(h.rowIds().slice(0, 4).includes('mailer-send-limits'), 'now pinned');
});

test('enter focuses the selected agent pane in herdr', () => {
	const h = new Harness();
	h.src.take();
	h.select('pack-option-api');
	h.key('', {return: true});
	assert.deepEqual(h.src.take(), ['focus:default:w27:p1B']);
	assert.equal(h.m.flash, 'focused pack-option-api in herdr');

	h.src.focusError = 'herdr: pane not found';
	h.key('', {return: true});
	assert.equal(h.m.flash, 'focus pack-option-api failed: herdr: pane not found');

	h.src.take();
	h.select('mailer-send-limits');
	h.key('', {return: true});
	assert.deepEqual(h.src.take(), [], 'no pane, no focus call');
	assert.equal(h.m.flash, 'mailer-send-limits has no recorded herdr pane');
});

test('q and ctrl+c quit', () => {
	const h = new Harness();
	assert.deepEqual(h.m.dispatch({type: 'key', input: 'q', key: {}}), [{kind: 'quit'}]);
	assert.deepEqual(h.m.dispatch({type: 'key', input: 'c', key: {ctrl: true}}), [{kind: 'quit'}]);
});

test('a failed fleet read keeps the last good data and shows its age', () => {
	const h = new Harness();
	h.src.fleetError = 'fm-bearings-snapshot.sh: timed out';
	h.advance(15_000);
	assert.equal(h.m.agents.length, 10);
	const fresh = freshness(h.m, h.clock);
	assert.match(fresh, /fleet error: fm-bearings-snapshot.sh: timed out/);
	assert.match(fresh, /showing 15s ago/);
	h.src.fleetError = undefined;
	h.advance(15_000);
	assert.equal(h.m.fleetError, undefined);
	h.clock += 120_000;
	assert.match(freshness(h.m, h.clock), /\(stale\)/);
});

test('a failed first fleet read says so and retries', () => {
	const h = new Harness({start: false});
	h.src.fleetError = 'fm-bearings-snapshot.sh: away window active';
	h.run(h.m.start());
	assert.equal(h.m.loaded, false);
	assert.match(listLines(h.m).join('\n'), /the fleet snapshot failed; retrying/);
	h.src.fleetError = undefined;
	h.advance(15_000);
	assert.equal(h.m.loaded, true);
	assert.equal(h.m.agents.length, 10);
});

test('agents that leave the roster drop their reads, including late results', () => {
	const h = new Harness();
	h.src.fleet = {...h.src.fleet, agents: h.src.fleet.agents.slice(0, 1)};
	h.advance(15_000);
	assert.deepEqual([...h.m.details.keys()], ['web-admin-console']);
	assert.equal(h.m.prs.has(apiPR), false, 'a gone agent PR is no longer watched');
	h.send({type: 'task', id: 'pack-option-api', detail: {status: [], fetchedAt: h.clock}});
	assert.equal(h.m.details.has('pack-option-api'), false);
});

test('pgdown scrolls the detail pane within its length and resets on a new selection', () => {
	const h = new Harness({rows: 12});
	h.select('pack-option-api');
	const lines = detailLines(h.m, h.m.selectedAgent()!, h.m.detailWidth()).length;
	for (let i = 0; i < 50; i++) h.key('', {pageDown: true});
	assert.equal(h.m.detailTop, lines - h.m.bodyHeight());
	h.key('', {pageUp: true});
	assert.ok(h.m.detailTop < lines - h.m.bodyHeight());
	h.key('j');
	assert.equal(h.m.detailTop, 0);
});

test('the list keeps the selected row and its group header on screen', () => {
	const h = new Harness({rows: 8});
	h.key('G');
	const visible = listLines(h.m).join('\n');
	assert.match(visible, /spare/);
	assert.match(visible, /SECONDMATES/);
	assert.equal(listLines(h.m).length, h.m.bodyHeight());
});

test('the detail pane shows decisions, pipeline, PR, and the absent secondmate', () => {
	const h = new Harness();
	h.select('pack-option-api');
	const api = detailLines(h.m, h.m.selectedAgent()!, 80).join('\n');
	for (const want of ['WAITING ON THE CAPTAIN', 'ask-user admin-toggle-overridden', 'PIPELINE', 'gate at review (awaiting_approval) · 2 finding(s)', 'herdr default w27:p1B'])
		assert.ok(api.includes(want), `api detail lacks ${want}`);

	h.select('pack-option-web');
	const client = detailLines(h.m, h.m.selectedAgent()!, 80).join('\n');
	for (const want of ['PULL REQUEST', '#87 OPEN', 'checks no checks', 'ci running for 1d9h']) assert.ok(client.includes(want), `client detail lacks ${want}`);

	h.key('G');
	const sm = detailLines(h.m, h.m.selectedAgent()!, 80).join('\n');
	assert.match(sm, /ABSENT/);
	assert.match(sm, /remote home on buildbox/);
});
