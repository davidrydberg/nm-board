import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {render} from 'ink-testing-library';

import type {Fleet, Source} from '../src/collect/collect.js';
import {buildRoster, type Agent, type Detail} from '../src/fleet/agent.js';
import {parseBearings} from '../src/fleet/bearings.js';
import {parsePipeline} from '../src/fleet/pipeline.js';
import {parseCrewState, parseStatusLog} from '../src/fleet/task.js';
import {DEMO_TASKS} from '../src/demo/fleet.js';
import {DemoView} from '../src/demo/view.js';
import {App} from '../src/tui/app.js';
import {Model} from '../src/tui/model.js';
import {fixture} from './helpers.js';

// The app wires the model to a source: reads run in the background and their
// results reach the screen; keys reach the model; enter hands a run to
// no-mistakes.
test('the app renders fleet data from its source and reacts to keys', async () => {
	const b = parseBearings(fixture('bearings.json'));
	const calls: string[] = [];
	const attached: string[] = [];
	const source: Source = {
		fleet: async (): Promise<Fleet> => ({bearings: b, agents: buildRoster(b, '/fm', new Map())}),
		task: async (a: Agent): Promise<Detail> => {
			calls.push(a.id);
			if (a.id !== 'pack-option-api') return {status: [], fetchedAt: Date.now()};
			return {
				status: parseStatusLog(fixture('api.status')),
				crew: parseCrewState(fixture('crew-pack-option-api.txt')),
				pipeline: parsePipeline(fixture('nm-gate.toon')),
				fetchedAt: Date.now(),
			};
		},
		popup: async () => false,
		attach: async (a: Agent, worktree: string, runId: string) => {
			attached.push(`${a.id}:${worktree}:${runId}`);
		},
	};
	const model = new Model({intervalMs: 60_000, inactiveIntervalMs: 60_000, fleetIntervalMs: 60_000});
	const app = render(<App model={model} source={source} />);
	try {
		for (let i = 0; i < 50 && !model.infos.get('pack-option-api')?.decisions.length; i++) await sleep(20);
		await sleep(50);
		const board = app.lastFrame() ?? '';
		assert.match(board, /REVIEW 1/);
		assert.match(board, /pack-option-api/);
		assert.match(board, /awaiting approval/);
		assert.match(board, /shop-api +1d9h/);
		assert.match(board, /fleet \d+s ago/, 'freshness survives a narrow header');
		assert.ok(calls.includes('cli-status-view'));

		app.stdin.write('\r');
		for (let i = 0; i < 50 && attached.length === 0; i++) await sleep(20);
		assert.deepEqual(attached, ['pack-option-api::01JXB56R3S8P2RMK6RQF9R4EN9']);
	} finally {
		app.unmount();
	}
});

// popupSource serves one card with a run and answers popup with popup.
function popupSource(popup: () => Promise<boolean>) {
	const b = parseBearings(fixture('bearings.json'));
	const attached: string[] = [];
	const source: Source = {
		fleet: async (): Promise<Fleet> => ({bearings: b, agents: buildRoster(b, '/fm', new Map())}),
		task: async (a: Agent): Promise<Detail> =>
			a.id === 'pack-option-api' ? {status: [], pipeline: parsePipeline(fixture('nm-gate.toon')), fetchedAt: Date.now()} : {status: [], fetchedAt: Date.now()},
		popup,
		attach: async (a: Agent) => {
			attached.push(a.id);
		},
	};
	return {source, attached};
}

async function pressEnter(source: Source, popup: boolean) {
	const model = new Model({intervalMs: 60_000, inactiveIntervalMs: 60_000, fleetIntervalMs: 60_000, popup});
	const app = render(<App model={model} source={source} />);
	for (let i = 0; i < 50 && !model.selectedCardAgent(); i++) await sleep(20);
	app.stdin.write('\r');
	await sleep(100);
	return {model, app};
}

test('inside herdr, enter opens the run in a popup and leaves the board running', async () => {
	let popups = 0;
	const {source, attached} = popupSource(async () => ++popups > 0);
	const {app} = await pressEnter(source, true);
	try {
		assert.equal(popups, 1);
		assert.deepEqual(attached, [], 'a popup never takes over the terminal');
		assert.match(app.lastFrame() ?? '', /enter open run \(esc closes it\)/);
	} finally {
		app.unmount();
	}
});

test('outside herdr, or without the plugin, enter falls back to the full-screen view', async () => {
	const outside = popupSource(async () => false);
	const a = await pressEnter(outside.source, false);
	try {
		assert.deepEqual(outside.attached, ['pack-option-api']);
		assert.doesNotMatch(a.app.lastFrame() ?? '', /esc closes/);
	} finally {
		a.app.unmount();
	}

	const unlinked = popupSource(async () => {
		throw new Error('herdr: plugin fleetwatch is not installed');
	});
	const b = await pressEnter(unlinked.source, true);
	try {
		assert.deepEqual(unlinked.attached, ['pack-option-api']);
		assert.equal(b.model.flash, 'no herdr popup (herdr: plugin fleetwatch is not installed); fleetwatch herdr-setup links it');
	} finally {
		b.app.unmount();
	}
});

test('the demo view shows a synthetic run and how to close it', () => {
	const index = DEMO_TASKS.findIndex((t) => t.id === 'checkout-retry');
	const view = render(<DemoView index={index} start={Date.now()} />);
	try {
		const frame = view.lastFrame() ?? '';
		assert.match(frame, /fm\/checkout-retry · billing-api/);
		assert.match(frame, /Review +awaiting approval · 2 findings · parked 14m/);
		assert.match(frame, /src\/payments\/retry\.ts ask-user/);
		assert.match(frame, /esc close · the run keeps going/);
		assert.match(frame, /demo: a synthetic run/);
	} finally {
		view.unmount();
	}
});
