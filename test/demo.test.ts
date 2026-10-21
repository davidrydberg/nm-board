import assert from 'node:assert/strict';
import os from 'node:os';
import {test} from 'node:test';

import {VIEW_SCRIPT} from '../src/collect/herdr.js';
import type {Cmd} from '../src/collect/run.js';
import {DEMO_TASKS, DemoSource, demoPipeline} from '../src/demo/fleet.js';
import type {Detail} from '../src/fleet/agent.js';
import {parseCrewState} from '../src/fleet/task.js';
import {buildBoard} from '../src/tui/board.js';
import {deriveInfo} from '../src/tui/rows.js';
import {fakeHerdr} from './helpers.js';

const START = Date.UTC(2026, 0, 1);

async function demoFleet() {
	const src = new DemoSource(undefined, undefined, () => START);
	const fleet = await src.fleet();
	const details = new Map<string, Detail>();
	for (const a of fleet.agents) details.set(a.id, await src.task(a));
	return {src, fleet, details};
}

test('the demo fleet fills the board across the pipeline', async () => {
	const {fleet, details} = await demoFleet();
	const infos = new Map(fleet.agents.map((a) => [a.id, deriveInfo(a, details.get(a.id), fleet.bearings)]));
	const board = buildBoard(fleet.agents, details, infos, '');
	const placed = Object.fromEntries(
		board.filter((c) => c.cards.length > 0).map((c) => [c.name, c.cards.map((card) => `${fleet.agents[card.agent]!.id} ${card.status}`)]),
	);
	assert.deepEqual(placed, {
		'no run': ['color-output no run'],
		review: ['checkout-retry awaiting_approval', 'dark-mode fixing'],
		test: ['rate-limit-flags failed', 'search-typos running'],
		document: ['offline-cart running'],
		pr: ['image-cdn running'],
		ci: ['docs-quickstart running'],
		finished: ['invoice-pdf passed'],
	});
	assert.deepEqual(
		infos.get('checkout-retry')!.decisions.map((d) => d.source),
		['captain-hold', 'ask-user', 'ask-user'],
	);
});

test('demo runs have run ids in the real shape, and their times move on', async () => {
	const {details} = await demoFleet();
	const ids = [...details.values()].map((d) => d.pipeline?.runId ?? '').filter((id) => id !== '');
	assert.equal(new Set(ids).size, DEMO_TASKS.length - 1, 'every task but the one without a run has its own run');
	for (const id of ids) assert.equal(parseCrewState(`state: working · source: demo · run: ${id}`).runId, id);
	const at = DEMO_TASKS.findIndex((t) => t.id === 'search-typos');
	assert.equal(demoPipeline(at, START, START).active[0]!.activeFor, '6m');
	assert.equal(demoPipeline(at, START, START + 90_000).active[0]!.activeFor, '7m');
});

test('the demo fleet carries no data from the machine it runs on', async () => {
	const {fleet, details} = await demoFleet();
	const text = JSON.stringify({fleet, details: [...details.values()]});
	for (const own of [os.homedir(), os.hostname(), os.userInfo().username]) {
		assert.ok(!text.includes(own), `demo data mentions ${own}`);
	}
	assert.doesNotMatch(text, /[\w.-]+@[\w-]+\.[\w.]+/, 'an email address');
	assert.doesNotMatch(text, /https?:\/\//, 'a URL');
});

test('a demo run opens the synthetic view, never no-mistakes', async () => {
	const cmds: Cmd[] = [];
	const handover = async (cmd: Cmd) => {
		cmds.push(cmd);
		return {stdout: ''};
	};
	const {fleet} = await demoFleet();
	const a = fleet.agents[0]!;
	const offline = new DemoSource(undefined, handover);
	assert.equal(await offline.popup(a, '', 'RUN'), false);
	await offline.attach(a, '', 'RUN');
	assert.deepEqual(cmds, [
		{name: process.execPath, args: [VIEW_SCRIPT], env: {NM_WATCH_RUN: 'RUN', NM_WATCH_CWD: '', NM_WATCH_NODE: process.execPath, NM_WATCH_DEMO: '1'}},
	]);

	const herdr = await fakeHerdr({result: {type: 'ok'}});
	try {
		assert.equal(await new DemoSource(herdr.socket, handover).popup(a, '', 'RUN'), true);
		assert.equal((herdr.requests[0]!['params'] as {env: Record<string, string>}).env['NM_WATCH_DEMO'], '1');
	} finally {
		await herdr.close();
	}
});
