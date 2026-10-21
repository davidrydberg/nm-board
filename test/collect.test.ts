import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {attachCmd, bearingsCmd, FleetSource, readTail, type Config} from '../src/collect/collect.js';
import {execHandover, execRunner, type Cmd, type Handover, type Runner} from '../src/collect/run.js';
import type {Agent} from '../src/fleet/agent.js';
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
	return {home: h, cacheDir, fleetTimeoutMs: 1000, taskTimeoutMs: 1000, concurrency: 2};
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
		'.meta': `worktree=${worktree}\nkind=ship\nmode=no-mistakes\nbranch=fm/pack-option-api\n`,
		'.status': fixture('api.status'),
	});
	const run = fakeRunner({'fm-crew-state.sh': fixture('crew-pack-option-api.txt'), 'no-mistakes': fixture('nm-gate.toon')});
	const d = await new FleetSource(config(h), run).task(agent('pack-option-api', h));
	assert.equal(d.meta?.worktree, worktree);
	assert.equal(d.status.length, 5);
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

// ptyDriver runs a command on a new pty. It answers each "WAIT text" line by
// waiting for the text in the output and each "TYPE keys" line by typing the
// keys one at a time, then prints all the output.
const ptyDriver = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out = b''
def wait(text):
    global out
    end = time.time() + 5
    while text not in out and time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                out += os.read(fd, 4096)
            except OSError:
                return
for line in sys.stdin.read().splitlines():
    verb, arg = line.split(' ', 1)
    if verb == 'WAIT':
        wait(arg.encode())
    for key in arg.encode() if verb == 'TYPE' else b'':
        os.write(fd, bytes([key]))
        time.sleep(0.05)
try:
    os.kill(pid, 9)
except OSError:
    pass
sys.stdout.write(out.decode(errors='replace'))
`;

const hasPython = (() => {
	try {
		execFileSync('python3', ['-c', 'import pty']);
		return true;
	} catch {
		return false;
	}
})();

test('execHandover gives the command every key typed while it runs', {skip: !hasPython && 'needs python3 for a pty'}, () => {
	// The app reads its terminal the way Ink does. On e it stops listening and
	// hands the terminal over from inside its read loop, as Ink's
	// suspendTerminal does, so the loop's last read asks Node to read ahead.
	const app = path.join(tmp(), 'app.mjs');
	writeFileSync(
		app,
		`import {execHandover} from ${JSON.stringify(new URL('../src/collect/run.js', import.meta.url).href)};
const stdin = process.stdin;
stdin.setEncoding('utf8');
stdin.setRawMode(true);
const onReadable = () => {
	let key;
	while ((key = stdin.read()) !== null) {
		process.stdout.write('[app ' + key + ']');
		if (key === 'z') process.exit(0);
		if (key !== 'e') continue;
		stdin.removeListener('readable', onReadable);
		stdin.setRawMode(false);
		execHandover({name: 'sh', args: ['-c', 'stty raw -echo; echo "[command ready]"; echo "[command $(dd bs=1 count=4 2>/dev/null)]"; stty sane']}).then(() => {
			stdin.setRawMode(true);
			stdin.on('readable', onReadable);
			process.stdout.write('[app back]');
		});
	}
};
stdin.on('readable', onReadable);
process.stdout.write('[app ready]');
`,
	);
	const out = execFileSync('python3', ['-c', ptyDriver, process.execPath, app], {
		input: ['WAIT [app ready]', 'TYPE e', 'WAIT [command ready]', 'TYPE abcd', 'WAIT [app back]', 'TYPE z', 'WAIT [app z]'].join('\n'),
		encoding: 'utf8',
	});
	assert.match(out, /\[command abcd\]/, out);
	assert.deepEqual(out.match(/\[app [a-z]\]/g), ['[app e]', '[app z]'], out);
});

test('readTail starts at a whole line', async () => {
	const file = path.join(tmp(), 'log');
	writeFileSync(file, 'first line\nsecond line\nthird\n');
	assert.equal(await readTail(file, 14), 'third\n');
	assert.equal(await readTail(file, 1024), 'first line\nsecond line\nthird\n');
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
