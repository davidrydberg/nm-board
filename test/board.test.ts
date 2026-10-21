import assert from 'node:assert/strict';
import {test} from 'node:test';

import {buildRoster, type Detail} from '../src/fleet/agent.js';
import {parseBearings} from '../src/fleet/bearings.js';
import {parsePipeline} from '../src/fleet/pipeline.js';
import {buildBoard, columnWidths, FINISHED, mergeSteps, NO_RUN, place, visibleEnd, type Column} from '../src/tui/board.js';
import {deriveInfo} from '../src/tui/rows.js';
import {fixture} from './helpers.js';

const bearings = parseBearings(fixture('bearings.json'));
const agents = buildRoster(bearings, '/fm', new Map());

const run = (file: string): Detail => ({status: [], fetchedAt: 0, pipeline: parsePipeline(fixture(file))});

// board lays the fixture agents out with the given reads and returns each
// column's cards as "<task> <status> <spent>".
function board(details: Record<string, Detail>, filter = ''): Record<string, string[]> {
	const d = new Map(Object.entries(details));
	const infos = new Map(agents.map((a) => [a.id, deriveInfo(a, d.get(a.id), bearings)]));
	const cols = buildBoard(agents, d, infos, filter);
	return Object.fromEntries(cols.map((c) => [c.name, c.cards.map((card) => `${agents[card.agent]!.id} ${card.status} ${card.spent}`.trim())]));
}

const reads = {
	'pack-option-api': run('nm-gate.toon'),
	'pack-option-web': run('nm-ci-running.toon'),
	'mailer-send-limits': run('nm-failed-pr.toon'),
	'api-catalog-scope': run('nm-passed.toon'),
	'web-admin-console': run('nm-cancelled.toon'),
	'cli-status-view': run('nm-no-runs.toon'),
	'blog-explainer': {status: [], fetchedAt: 0, pipelineError: 'no-mistakes: daemon unreachable'},
	'dev-inventory': {status: [], fetchedAt: 0},
};

test('each run sits in its step column, in pipeline order, between no run and finished', () => {
	assert.deepEqual(board(reads), {
		[NO_RUN]: ['blog-explainer unreadable', 'cli-status-view no run'],
		intent: [],
		rebase: [],
		review: ['pack-option-api awaiting_approval 1d9h'],
		test: [],
		document: [],
		lint: [],
		push: [],
		pr: ['mailer-send-limits failed'],
		ci: ['pack-option-web running 1d9h'],
		[FINISHED]: ['api-catalog-scope passed', 'web-admin-console cancelled'],
	});
});

test('tasks without a pipeline read and secondmates stay off the board', () => {
	assert.equal(place({status: [], fetchedAt: 0}), undefined);
	assert.equal(place(undefined), undefined);
	const cards = Object.values(board(reads)).flat();
	assert.ok(!cards.some((c) => c.startsWith('dev-inventory') || c.startsWith('spare')));
});

test('cards waiting on a person lead their column', () => {
	const fixReview = parsePipeline(fixture('nm-gate.toon'));
	fixReview.gate = {...fixReview.gate!, status: 'fix_review'};
	const b = board({...reads, 'pack-option-web': {status: [], fetchedAt: 0, pipeline: fixReview}});
	assert.deepEqual(b['review'], ['pack-option-api awaiting_approval 1d9h', 'pack-option-web fix_review 1d9h']);
	const d = new Map(Object.entries(reads));
	const infos = new Map(agents.map((a) => [a.id, deriveInfo(a, d.get(a.id), bearings)]));
	const finished = buildBoard(agents, d, infos, '').at(-1)!;
	assert.deepEqual(finished.cards.map((c) => c.human), [false, false]);
});

test('the filter matches task, project, and status', () => {
	const shown = (filter: string) =>
		Object.values(board(reads, filter))
			.flat()
			.map((c) => c.split(' ')[0]);
	assert.deepEqual(shown('shop-web'), ['pack-option-web', 'web-admin-console']);
	assert.deepEqual(shown('awaiting'), ['pack-option-api']);
	assert.deepEqual(shown('mailer'), ['mailer-send-limits']);
	assert.equal(Object.keys(board(reads, 'nothing-matches')).length, 11, 'columns stay while their cards are filtered out');
});

test('a run with its own steps adds them in its order', () => {
	assert.deepEqual(mergeSteps(['intent', 'review', 'ci'], ['intent', 'review', 'audit', 'ci', 'deploy']), ['intent', 'review', 'audit', 'ci', 'deploy']);
	assert.deepEqual(mergeSteps(['review'], ['setup', 'review']), ['setup', 'review']);
	const custom = parsePipeline(fixture('nm-ci-running.toon'));
	custom.steps.splice(9, 0, {name: 'deploy', status: 'pending', findings: 0, durationMs: 0});
	assert.deepEqual(Object.keys(board({'pack-option-web': {status: [], fetchedAt: 0, pipeline: custom}})).slice(-3), ['ci', 'deploy', FINISHED]);
});

test('empty columns shrink to their name and the rest share the width', () => {
	const cols: Column[] = ['no run', 'review', 'test', 'ci'].map((name, i) => ({name, cards: i % 2 ? [{agent: 0, status: '', spent: '', human: false}] : []}));
	assert.deepEqual(columnWidths(cols, 100), [7, 36, 5, 36]);
	assert.deepEqual(columnWidths(cols, 60), [7, 22, 5, 22]);
	const widths = columnWidths(cols, 60);
	assert.equal(visibleEnd(widths, 0, 60), 4);
	assert.equal(visibleEnd(widths, 0, 40), 3);
	assert.equal(visibleEnd(widths, 3, 10), 4, 'one column always shows');
});
