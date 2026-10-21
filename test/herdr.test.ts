import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {FleetSource} from '../src/collect/collect.js';
import {herdrSocket, openPopup, PLUGIN_ID, VIEW_ENTRYPOINT} from '../src/collect/herdr.js';
import type {Agent} from '../src/fleet/agent.js';
import {fakeHerdr} from './helpers.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'nm-watch-test-'));

const agent = (home: string): Agent => ({
	id: 'pack-option-api',
	taskId: 'pack-option-api',
	home,
	owner: '(main)',
	kind: 'ship',
	repo: '',
	name: '',
	state: '',
	doing: '',
	secondmate: false,
	absent: false,
	absentReason: '',
});

const RUN = '01JXB56R3S8P2RMK6RQF9R4EN9';

test('runs open in a popup only inside herdr, through the socket herdr gives its panes', () => {
	assert.equal(herdrSocket({HERDR_ENV: '1', HERDR_SOCKET_PATH: '/run/herdr.sock'}), '/run/herdr.sock');
	assert.equal(herdrSocket({}), undefined, 'outside herdr the run takes the whole terminal');
	assert.equal(herdrSocket({HERDR_SOCKET_PATH: '/run/herdr.sock'}), undefined, 'a leftover socket path alone is not herdr');
	assert.equal(herdrSocket({HERDR_ENV: '1'}), undefined);
});

test('openPopup asks herdr for the plugin view in a popup and passes the run in its environment', async () => {
	const herdr = await fakeHerdr({result: {type: 'ok'}});
	try {
		await openPopup(herdr.socket, {runId: RUN, cwd: '/wt'});
		assert.equal(herdr.requests.length, 1);
		const req = herdr.requests[0]!;
		assert.equal(req['method'], 'plugin.pane.open');
		const params = req['params'] as Record<string, unknown>;
		assert.equal(params['plugin_id'], PLUGIN_ID);
		assert.equal(params['entrypoint'], VIEW_ENTRYPOINT);
		assert.equal(params['placement'], 'popup');
		assert.deepEqual(params['env'], {NM_WATCH_RUN: RUN, NM_WATCH_CWD: '/wt', NM_WATCH_NODE: process.execPath});
	} finally {
		await herdr.close();
	}
});

test("openPopup reports herdr's refusal, a hang-up, and a missing server", async () => {
	const refusing = await fakeHerdr({error: {code: 'plugin_not_found', message: 'plugin nm-watch is not installed'}});
	const hanging = await fakeHerdr(null);
	try {
		await assert.rejects(openPopup(refusing.socket, {runId: RUN, cwd: ''}), /^Error: herdr: plugin nm-watch is not installed$/);
		await assert.rejects(openPopup(hanging.socket, {runId: RUN, cwd: ''}), /without answering/);
		await assert.rejects(openPopup(path.join(tmp(), 'none.sock'), {runId: RUN, cwd: ''}), /^Error: herdr: .*ENOENT/);
	} finally {
		await refusing.close();
		await hanging.close();
	}
});

test("FleetSource opens a popup only with herdr's socket, in the task's worktree or else its home", async () => {
	const home = tmp();
	const worktree = tmp();
	const config = {home, cacheDir: '', fleetTimeoutMs: 1000, taskTimeoutMs: 1000, concurrency: 1};
	const noRunner = async () => assert.fail('popup runs no command');
	assert.equal(await new FleetSource(config, noRunner).popup(agent(home), worktree, RUN), false);

	const herdr = await fakeHerdr({result: {type: 'ok'}});
	try {
		const src = new FleetSource({...config, herdrSocket: herdr.socket}, noRunner);
		assert.equal(await src.popup(agent(home), worktree, RUN), true);
		assert.equal(await src.popup(agent(home), path.join(worktree, 'gone'), RUN), true);
		const cwds = herdr.requests.map((r) => ((r['params'] as {env: Record<string, string>}).env['NM_WATCH_CWD']));
		assert.deepEqual(cwds, [worktree, home]);
	} finally {
		await herdr.close();
	}
});

test('the shipped plugin declares the popup view that nm-watch opens', () => {
	const dir = new URL('../../herdr-plugin/', import.meta.url);
	const manifest = readFileSync(new URL('herdr-plugin.toml', dir), 'utf8');
	assert.match(manifest, new RegExp(`^id = "${PLUGIN_ID}"$`, 'm'));
	assert.match(manifest, new RegExp(`^id = "${VIEW_ENTRYPOINT}"$`, 'm'));
	assert.match(manifest, /^placement = "popup"$/m);
	assert.match(manifest, /^command = \["sh", "view.sh"\]$/m);
	assert.doesNotMatch(manifest, /^\[\[(actions|startup|events|link_handlers|build)\]\]$/m, 'the plugin runs nothing on its own');
	assert.match(readFileSync(new URL('view.sh', dir), 'utf8'), /^exec "\$\{NM_WATCH_NODE:-node\}" \.\.\/dist\/view\.js$/m);
});
