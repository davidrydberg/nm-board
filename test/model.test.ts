import assert from 'node:assert/strict';
import {test} from 'node:test';
import stringWidth from 'string-width';

import type {Fleet} from '../src/collect/collect.js';
import {buildRoster, type Detail} from '../src/fleet/agent.js';
import {parseBearings} from '../src/fleet/bearings.js';
import {parsePipeline} from '../src/fleet/pipeline.js';
import {parseCrewState, parseMeta, parseStatusLog} from '../src/fleet/task.js';
import {Model, type Config, type Effect, type Event, type Key} from '../src/tui/model.js';
import {boardLines, footer, freshness} from '../src/tui/render.js';
import {fixture} from './helpers.js';

const config: Config = {intervalMs: 5000, inactiveIntervalMs: 30_000, fleetIntervalMs: 15_000};

const liveTasks = ['cli-status-view', 'dev-inventory', 'mailer-send-limits', 'pack-option-api', 'pack-option-web'].map((id) => `task:${id}`);
const inactiveTasks = ['web-admin-console', 'wiki-db-claims-check', 'blog-explainer', 'api-catalog-scope'].map((id) => `task:${id}`);
const sorted = (...lists: string[][]) => lists.flat().sort();

// FakeSource serves the fixtures and records every read.
class FakeSource {
	calls: string[] = [];
	fleetError?: string;
	attachError?: string;
	fleet: Fleet;
	details: Record<string, Detail>;

	constructor() {
		const b = parseBearings(fixture('bearings.json'));
		const remote = parseMeta(fixture('remote-secondmate.meta'));
		this.fleet = {bearings: b, agents: buildRoster(b, '/fm', new Map([['spare', remote]]))};
		const apiMeta = {...parseMeta(''), kind: 'ship', mode: 'no-mistakes', branch: 'fm/pack-option-api'};
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
			case 'attach':
				this.calls.push(`attach:${e.agent.id}:${e.worktree}:${e.runId}`);
				return this.attachError ? {type: 'attachError', id: e.agent.id, error: this.attachError} : {type: 'attached', id: e.agent.id};
			case 'quit':
				this.calls.push('quit');
				return undefined;
		}
	}

	// addRuns gives more fixture agents a no-mistakes run, so the board fills
	// every kind of column.
	addRuns(): void {
		const run = (id: string, file: string) => {
			this.details[id] = {...(this.details[id] ?? {status: [], fetchedAt: 0}), pipeline: parsePipeline(fixture(file))};
		};
		run('mailer-send-limits', 'nm-failed-pr.toon');
		run('api-catalog-scope', 'nm-passed.toon');
		run('web-admin-console', 'nm-cancelled.toon');
		run('cli-status-view', 'nm-no-runs.toon');
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

	constructor({columns = 140, rows = 40, start = true, runs = false} = {}) {
		if (runs) this.src.addRuns();
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

	// cards lists the board's cards by column, as "<column>: <task> ...".
	cards(): string[] {
		return this.m.board.filter((c) => c.cards.length > 0).map((c) => `${c.name}: ${c.cards.map((card) => this.m.agents[card.agent]!.id).join(' ')}`);
	}
}

test('startup reads the fleet, then each agent once', () => {
	const h = new Harness();
	assert.deepEqual(h.src.take(), sorted(['fleet'], liveTasks, inactiveTasks));
	assert.equal(h.m.loaded, true);
	assert.equal(h.m.agents.length, 10);
});

test('no source is read twice at once', () => {
	const h = new Harness({start: false});
	const first = h.m.start();
	// While the first fleet read is in flight, a tick starts nothing.
	h.clock += 60_000;
	assert.deepEqual(h.m.dispatch({type: 'tick'}), []);

	const reads = h.m.dispatch(h.src.answer(first[0]!, h.clock)!);
	assert.deepEqual(h.src.take(), ['fleet']);
	assert.deepEqual(reads.map((e) => (e.kind === 'task' ? `task:${e.agent.id}` : e.kind)).sort(), sorted(liveTasks, inactiveTasks));

	// Agent reads are in flight and due again, but nothing restarts.
	h.clock += 10_000;
	assert.deepEqual(h.m.dispatch({type: 'tick'}), []);
});

test('refresh cadence: live agents, inactive agents, and the fleet', () => {
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
});

test('r re-reads everything', () => {
	const h = new Harness();
	h.src.take();
	h.advance(1000);
	h.key('r');
	assert.deepEqual(h.src.take(), sorted(['fleet'], liveTasks, inactiveTasks));
	assert.equal(h.m.flash, 'refreshing');
});

test('/ filters as you type; enter keeps it, esc clears it', () => {
	const h = new Harness({runs: true, columns: 200});
	h.key('/');
	assert.equal(h.m.filtering, true);
	for (const ch of 'mailer') h.key(ch);
	assert.deepEqual(h.cards(), ['pr: mailer-send-limits']);
	assert.equal(h.m.cardId, 'mailer-send-limits');
	h.key('q');
	assert.deepEqual(h.cards(), [], 'q is typed into the filter, not quit');
	assert.deepEqual(h.src.take().filter((c) => c === 'quit'), []);
	h.key('', {backspace: true});
	h.key('', {return: true});
	assert.equal(h.m.filtering, false);
	assert.equal(h.m.filter, 'mailer');
	assert.match(footer(h.m), /filter: mailer/);
	h.key('', {escape: true});
	assert.equal(h.m.filter, '');
	assert.equal(h.cards().length, 5);
	h.key('/');
	h.key('parked');
	h.key('', {escape: true});
	assert.equal(h.m.filtering, false);
	assert.equal(h.m.filter, '');
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
	assert.match(boardLines(h.m).join('\n'), /the fleet snapshot failed; retrying/);
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
	h.send({type: 'task', id: 'pack-option-api', detail: {status: [], fetchedAt: h.clock}});
	assert.equal(h.m.details.has('pack-option-api'), false);
});

test('arrows move between columns with cards, and between cards', () => {
	const h = new Harness({runs: true, columns: 200});
	assert.deepEqual(h.cards(), [
		'no run: cli-status-view',
		'review: pack-option-api',
		'pr: mailer-send-limits',
		'ci: pack-option-web',
		'finished: api-catalog-scope web-admin-console',
	]);
	assert.equal(h.m.cardId, 'cli-status-view', 'the first card is selected until the user moves');
	assert.match(footer(h.m), /←\/→ column · ↑\/↓ card · enter open run/);
	const path: string[] = [];
	for (let i = 0; i < 5; i++) {
		h.key('', {rightArrow: true});
		path.push(h.m.cardId);
	}
	assert.deepEqual(path, ['pack-option-api', 'mailer-send-limits', 'pack-option-web', 'api-catalog-scope', 'api-catalog-scope']);
	h.key('', {downArrow: true});
	assert.equal(h.m.cardId, 'web-admin-console');
	h.key('j');
	assert.equal(h.m.cardId, 'web-admin-console', 'down stops at the last card');
	h.key('', {leftArrow: true});
	assert.equal(h.m.cardId, 'pack-option-web', 'a shorter column keeps the cursor on its last card');
	h.key('h');
	h.key('k');
	assert.equal(h.m.cardId, 'mailer-send-limits');
});

test('the selection follows its card when the run moves on', () => {
	const h = new Harness({runs: true, columns: 200});
	h.key('', {rightArrow: true});
	assert.equal(h.m.cardId, 'pack-option-api');
	const d = {...h.src.details['pack-option-api']!, pipeline: parsePipeline(fixture('nm-ci-running.toon'))};
	h.send({type: 'task', id: 'pack-option-api', detail: d});
	assert.equal(h.m.cardId, 'pack-option-api');
	assert.equal(h.m.board[h.m.col]!.name, 'ci');
	assert.ok(h.cards().includes('ci: pack-option-api pack-option-web'));
});

test('a card that leaves the board leaves the selection nearby', () => {
	const h = new Harness({runs: true, columns: 200});
	h.key('', {rightArrow: true});
	h.key('', {rightArrow: true});
	assert.equal(h.m.cardId, 'mailer-send-limits');
	h.send({type: 'task', id: 'mailer-send-limits', detail: {status: [], fetchedAt: h.clock}});
	assert.equal(h.m.cardId, 'pack-option-web', 'the nearest column with cards');
});

test('the filter narrows the board', () => {
	const h = new Harness({runs: true, columns: 200});
	h.key('/');
	for (const ch of 'shop-web') h.key(ch);
	h.key('', {return: true});
	assert.deepEqual(h.cards(), ['ci: pack-option-web', 'finished: web-admin-console']);
	assert.equal(h.m.cardId, 'pack-option-web');
	h.key('', {escape: true});
	assert.equal(h.cards().length, 5);
});

test('enter opens the selected run in no-mistakes and re-reads the task after', () => {
	const h = new Harness({runs: true, columns: 200});
	h.src.take();
	h.key('', {return: true});
	assert.deepEqual(h.src.take(), [], 'a task without a run opens nothing');
	assert.equal(h.m.flash, 'cli-status-view has no no-mistakes run to open');

	for (let i = 0; i < 3; i++) h.key('', {rightArrow: true});
	assert.equal(h.m.cardId, 'pack-option-web');
	h.key('', {return: true});
	assert.deepEqual(h.src.take(), [
		'attach:pack-option-web:/home/dev/.treehouse/shop-web-3f2a1c/4/shop-web:01JXHQQMXAAMQFC2392B359VRQ',
		'task:pack-option-web',
	]);

	h.src.attachError = 'no-mistakes is not installed or not on PATH';
	h.key('', {return: true});
	assert.equal(h.m.flash, 'could not open the run of pack-option-web: no-mistakes is not installed or not on PATH');
});

test('cards show task, project, status, and time at the step; people-waiting cards stand out', () => {
	const h = new Harness({runs: true, columns: 200});
	h.clock += 90_000;
	const lines = boardLines(h.m);
	assert.equal(lines.length, h.m.bodyHeight());
	for (const l of lines) assert.ok(stringWidth(l) <= 200, `line wider than the screen: ${l}`);
	const text = lines.join('\n');
	for (const want of ['REVIEW 1', '⚑ pack-option-api', 'PR 1', 'CI 1', 'FINISHED 2', ' intent', 'shop-api'])
		assert.ok(text.includes(want), `board lacks ${want}`);
	for (const want of [/▌ awaiting approval /, /▌ running /, /▌ passed /, /▌ cancelled /, /▌ shop-api +1d9h/, /▌ shop-web +1d9h/])
		assert.match(text, want);
	assert.doesNotMatch(text, /≥/, 'a card shows only the time no-mistakes reports');
	assert.match(lines.at(-1)!, /^cli-status-view · Status view: a live terminal view of running agents · 0 runs yet in this repository/);
	assert.equal(h.m.board.find((c) => c.name === 'pr')!.cards[0]!.human, true);
});

test('columns that do not fit scroll sideways to follow the selection', () => {
	const h = new Harness({runs: true, columns: 100});
	assert.equal(h.m.boardLeft, 0);
	assert.match(boardLines(h.m).at(-1)!, /\d+ more ›$/);
	for (let i = 0; i < 4; i++) h.key('', {rightArrow: true});
	assert.equal(h.m.cardId, 'api-catalog-scope');
	assert.ok(h.m.boardLeft > 0);
	const lines = boardLines(h.m);
	assert.match(lines[0]!, /FINISHED 2/);
	assert.doesNotMatch(lines[0]!, /NO RUN/);
	assert.match(lines.at(-1)!, /‹ \d+ more$/);
	for (const l of lines) assert.ok(stringWidth(l) <= 100);
	for (let i = 0; i < 4; i++) h.key('', {leftArrow: true});
	assert.equal(h.m.boardLeft, 0);
});

test('a long column scrolls down to the selected card', () => {
	const h = new Harness({runs: true, columns: 200, rows: 10});
	const ci = parsePipeline(fixture('nm-ci-running.toon'));
	for (const id of ['mailer-send-limits', 'api-catalog-scope', 'web-admin-console', 'cli-status-view']) h.send({type: 'task', id, detail: {status: [], fetchedAt: h.clock, pipeline: ci}});
	assert.equal(h.m.cardSlots(), 1);
	h.key('', {rightArrow: true});
	h.key('', {rightArrow: true});
	assert.equal(h.m.board[h.m.col]!.name, 'ci');
	for (let i = 0; i < 4; i++) h.key('', {downArrow: true});
	assert.equal(h.m.cardTop, 4);
	assert.match(boardLines(h.m)[1]!, /↑ 4 more/);
});

test('a column with more cards than fit counts the ones below', () => {
	const h = new Harness({runs: true, columns: 200, rows: 24});
	const ci = parsePipeline(fixture('nm-ci-running.toon'));
	for (const id of ['mailer-send-limits', 'api-catalog-scope', 'web-admin-console', 'cli-status-view', 'pack-option-api'])
		h.send({type: 'task', id, detail: {status: [], fetchedAt: h.clock, pipeline: ci}});
	assert.equal(h.m.board.find((c) => c.name === 'ci')!.cards.length, 6);
	const lines = boardLines(h.m);
	assert.equal(lines.length, h.m.bodyHeight());
	assert.ok(lines.some((l) => l.includes(`↓ ${6 - h.m.cardSlots()} more`)), 'the overflow count is on screen');
});
