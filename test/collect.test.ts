import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {attachCmd, bearingsCmd, FleetSource, focusCmd, readTail, type Config} from '../src/collect/collect.js';
import {execHandover, execRunner, type Cmd, type Handover, type Runner} from '../src/collect/run.js';
import type {Agent} from '../src/fleet/agent.js';
import {PR_FIELDS} from '../src/fleet/pr.js';
import {fixture} from './helpers.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'fleetwatch-test-'));

// fakeRunner answers commands from canned output keyed by command basename.
function fakeRunner(out: Record<string, string>, errors: Record<string, string> = {}): Runner & {cmds: Cmd[]} {
	const cmds: Cmd[] = [];
	const run = async (cmd: Cmd) => {
		cmds.push(cmd);
		const key = path.basename(cmd.name);
		return {stdout: out[key] ?? '', error: errors[key]};
	};
	return Object.assign(run, {cmds});
}

// home lays out a firstmate home holding one task's state files.
function home(task: string, files: Record<string, string>): string {
	const dir = tmp();
	mkdirSync(path.join(dir, 'state'));
	for (const [ext, text] of Object.entries(files)) writeFileSync(path.join(dir, 'state', task + ext), text);
	return dir;
}

function config(h: string, cacheDir = ''): Config {
	return {home: h, cacheDir, fleetTimeoutMs: 1000, taskTimeoutMs: 1000, prTimeoutMs: 1000, focusTimeoutMs: 1000, concurrency: 2, prConcurrency: 1};
}

const agent = (id: string, h: string): Agent => ({
	id,
	taskId: id,
	home: h,
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

test('the bearings command uncaps decisions and redirects the snapshot cache', () => {
	const c = bearingsCmd({home: '/fm', cacheDir: '/cache/fleetwatch/summary'});
	assert.equal(c.name, '/fm/bin/fm-bearings-snapshot.sh');
	assert.equal(c.cwd, '/fm');
	assert.deepEqual(c.args, ['--json', '--all-in-flight']);
	assert.deepEqual(c.env, {FM_HOME: '/fm', FM_BEARINGS_DECISIONS: '1000', FM_SNAPSHOT_CACHE_DIR: '/cache/fleetwatch/summary'});
});

test('fleet reads secondmate meta and prepares the cache parent', async () => {
	const h = home('spare', {'.meta': fixture('remote-secondmate.meta')});
	const cacheDir = path.join(tmp(), 'fleetwatch', 'summary');
	const src = new FleetSource(config(h, cacheDir), fakeRunner({'fm-bearings-snapshot.sh': fixture('bearings.json')}));
	const f = await src.fleet();
	const sm = f.agents.at(-1)!;
	assert.equal(sm.id, 'spare');
	assert.equal(sm.absent, true);
	assert.ok(statSync(path.dirname(cacheDir)).isDirectory(), 'the snapshot creates only the cache leaf itself');
});

test('fleet surfaces command and schema errors', async () => {
	const failing = new FleetSource(config(tmp()), fakeRunner({}, {'fm-bearings-snapshot.sh': 'fm-bearings-snapshot.sh: away window active'}));
	await assert.rejects(failing.fleet(), /away window active/);
	const wrong = new FleetSource(config(tmp()), fakeRunner({'fm-bearings-snapshot.sh': '{"schema":"other"}'}));
	await assert.rejects(wrong.fleet(), /schema/);
});

test('task reads files, then crew-state, then the run crew-state names', async () => {
	const worktree = tmp();
	const h = home('pack-option-api', {
		'.meta': `worktree=${worktree}\nkind=ship\nmode=no-mistakes\nbranch=fm/pack-option-api\nherdr_session=default\nherdr_pane_id=w27:p1B\n`,
		'.status': fixture('api.status'),
		'.busy-state': fixture('idle.busy-state'),
	});
	const run = fakeRunner({'fm-crew-state.sh': fixture('crew-pack-option-api.txt'), 'no-mistakes': fixture('nm-gate.toon')});
	const d = await new FleetSource(config(h), run).task(agent('pack-option-api', h));
	assert.equal(d.meta?.herdrPane, 'w27:p1B');
	assert.equal(d.status.length, 5);
	assert.equal(d.busy?.state, 'idle');
	assert.ok(d.statusModified);
	assert.equal(d.crew?.state, 'parked');
	assert.equal(d.pipeline?.gate?.step, 'review');
	const [crew, nm] = run.cmds;
	assert.deepEqual(crew, {name: path.join(h, 'bin', 'fm-crew-state.sh'), args: ['pack-option-api'], cwd: h, env: {FM_HOME: h}});
	assert.equal(nm!.cwd, worktree);
	assert.deepEqual(nm!.args, ['axi', 'status', '--run', '01JXB56R3S8P2RMK6RQF9R4EN9']);
});

test("without a run id, a worktree's run on another branch is not the task's", async () => {
	const worktree = tmp();
	const h = home('web-admin-console', {'.meta': `worktree=${worktree}\nkind=ship\nmode=no-mistakes\nbranch=fm/web-admin-console\n`});
	const run = fakeRunner({'fm-crew-state.sh': 'state: working · source: pane · harness busy (claude-hook)\n', 'no-mistakes': fixture('nm-cancelled.toon')});
	const d = await new FleetSource(config(h), run).task(agent('web-admin-console', h));
	assert.equal(d.pipeline?.noRun, true);
	assert.equal(d.pipeline?.note, "latest run is on fm/web-admin-dev-sync, not this task's branch");
	assert.deepEqual(run.cmds[1]!.args, ['axi', 'status']);
});

test('a scout without a run id has no pipeline read, and crew-state errors are reported', async () => {
	const h = home('dev-inventory', {'.meta': fixture('scout.meta'), '.status': fixture('scout.status')});
	const run = fakeRunner({}, {'fm-crew-state.sh': 'fm-crew-state.sh: timed out'});
	const d = await new FleetSource(config(h), run).task(agent('dev-inventory', h));
	assert.equal(d.crew, undefined);
	assert.equal(d.crewError, 'fm-crew-state.sh: timed out');
	assert.equal(d.pipeline, undefined);
	assert.equal(run.cmds.length, 1);
});

test('absent agents and remote metas run no commands', async () => {
	const run = fakeRunner({});
	const absent = {...agent('spare', '/fm'), absent: true};
	assert.equal((await new FleetSource(config('/fm'), run).task(absent)).meta, undefined);
	const h = home('spare', {'.meta': fixture('remote-secondmate.meta')});
	const d = await new FleetSource(config(h), run).task(agent('spare', h));
	assert.equal(d.meta?.remoteHost, 'buildbox');
	assert.equal(run.cmds.length, 0);
});

test('pr reads one pull request', async () => {
	const run = fakeRunner({gh: fixture('gh-open-green.json')});
	const url = 'https://github.com/example-org/shop-api/pull/188';
	const pr = await new FleetSource(config('/fm'), run).pr(url);
	assert.equal(pr.number, 188);
	assert.deepEqual(run.cmds[0]!.args, ['pr', 'view', url, '--json', PR_FIELDS]);
	await assert.rejects(new FleetSource(config('/fm'), fakeRunner({}, {gh: 'gh: HTTP 404'})).pr(url), /HTTP 404/);
});

test('focus names the herdr session in both places', () => {
	assert.deepEqual(focusCmd('default', 'wBR:p2'), {
		name: 'herdr',
		args: ['agent', 'focus', 'wBR:p2', '--session', 'default'],
		env: {HERDR_SESSION: 'default'},
	});
	assert.deepEqual(focusCmd('', 'wBR:p2'), {name: 'herdr', args: ['agent', 'focus', 'wBR:p2']});
});

// fakeHandover records the commands it is handed and fails with error.
function fakeHandover(error?: string): Handover & {cmds: Cmd[]} {
	const cmds: Cmd[] = [];
	const run = async (cmd: Cmd) => {
		cmds.push(cmd);
		return error === undefined ? {stdout: ''} : {stdout: '', error};
	};
	return Object.assign(run, {cmds});
}

test("attach opens the run in no-mistakes' own view, in the task's worktree", async () => {
	assert.deepEqual(attachCmd('/wt', '01JXB56R3S8P2RMK6RQF9R4EN9'), {name: 'no-mistakes', args: ['attach', '--run', '01JXB56R3S8P2RMK6RQF9R4EN9'], cwd: '/wt'});
	const worktree = tmp();
	const h = tmp();
	const handover = fakeHandover();
	const src = new FleetSource(config(h), fakeRunner({}), handover);
	await src.attach(agent('pack-option-api', h), worktree, '01JXB56R3S8P2RMK6RQF9R4EN9');
	await src.attach(agent('pack-option-api', h), path.join(worktree, 'gone'), '01JXB56R3S8P2RMK6RQF9R4EN9');
	assert.deepEqual(
		handover.cmds.map((c) => c.cwd),
		[worktree, h],
		'a gone worktree falls back to the home',
	);
	const failing = new FleetSource(config(h), fakeRunner({}), fakeHandover('no-mistakes: run not found'));
	await assert.rejects(failing.attach(agent('pack-option-api', h), worktree, 'x'), /run not found/);
});

test('execHandover explains a failed or missing command', async () => {
	assert.deepEqual(await execHandover({name: 'sh', args: ['-c', 'exit 0']}), {stdout: ''});
	assert.deepEqual(await execHandover({name: 'sh', args: ['-c', "echo 'Error: unknown run' >&2; exit 1"]}), {stdout: '', error: 'sh: Error: unknown run'});
	assert.deepEqual(await execHandover({name: 'fleetwatch-no-such-command', args: []}), {
		stdout: '',
		error: 'fleetwatch-no-such-command is not installed or not on PATH',
	});
	assert.equal(process.listenerCount('SIGINT'), 0, 'SIGINT is handed back');
});

test('readTail starts at a whole line', async () => {
	const file = path.join(tmp(), 'log');
	writeFileSync(file, 'first line\nsecond line\nthird\n');
	const tail = await readTail(file, 14);
	assert.equal(tail.text, 'third\n');
	assert.ok(tail.modified > 0);
	assert.equal((await readTail(file, 1024)).text, 'first line\nsecond line\nthird\n');
});

test('execRunner kills the whole process group on timeout', async () => {
	const start = Date.now();
	// The background child keeps stdout open; the bound must still hold.
	const r = await execRunner({name: 'sh', args: ['-c', 'sleep 30 & sleep 30']}, 200);
	assert.equal(r.error, 'sh: timed out');
	assert.ok(Date.now() - start < 5000, 'the run outlived its bound');
});

test('execRunner reports stderr and keeps stdout on failure', async () => {
	const r = await execRunner({name: 'sh', args: ['-c', "echo partial; echo 'boom happened' >&2; exit 3"]}, 5000);
	assert.deepEqual(r, {stdout: 'partial\n', error: 'sh: boom happened'});
	const missing = await execRunner({name: 'fleetwatch-no-such-command', args: []}, 5000);
	assert.match(missing.error ?? '', /^fleetwatch-no-such-command: .*ENOENT/);
});
