import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {render} from 'ink-testing-library';

import type {Fleet, Source} from '../src/collect/collect.js';
import {buildRoster, type Agent, type Detail} from '../src/fleet/agent.js';
import {parseBearings} from '../src/fleet/bearings.js';
import {parsePipeline} from '../src/fleet/pipeline.js';
import type {PR} from '../src/fleet/pr.js';
import {parseCrewState, parseStatusLog} from '../src/fleet/task.js';
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
		pr: async (): Promise<PR> => {
			throw new Error('gh: offline');
		},
		focus: async () => {},
		attach: async (a: Agent, worktree: string, runId: string) => {
			attached.push(`${a.id}:${worktree}:${runId}`);
		},
	};
	const model = new Model({intervalMs: 60_000, inactiveIntervalMs: 60_000, fleetIntervalMs: 60_000, prIntervalMs: 60_000});
	const app = render(<App model={model} source={source} />);
	try {
		for (let i = 0; i < 50 && !model.infos.get('pack-option-api')?.decisions.length; i++) await sleep(20);
		await sleep(50);
		const board = app.lastFrame() ?? '';
		assert.match(board, /REVIEW 1/);
		assert.match(board, /pack-option-api/);
		assert.match(board, /awaiting approval/);
		assert.match(board, /shop-api +1d9h/);
		assert.match(board, /PRs never \(\d+ unreadable\)/, 'freshness survives a narrow header');
		assert.ok(calls.includes('cli-status-view'));

		app.stdin.write('\r');
		for (let i = 0; i < 50 && attached.length === 0; i++) await sleep(20);
		assert.deepEqual(attached, ['pack-option-api::01JXB56R3S8P2RMK6RQF9R4EN9']);

		app.stdin.write('\t');
		await sleep(50);
		assert.match(app.lastFrame() ?? '', /CAPTAIN DECISIONS/);
		app.stdin.write('d');
		await sleep(50);
		assert.match(app.lastFrame() ?? '', /d show \d+ inactive/);
	} finally {
		app.unmount();
	}
});
