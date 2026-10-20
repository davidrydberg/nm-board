// Reads fleet state from a firstmate home, no-mistakes, GitHub, and herdr.
// Every read is bounded by a timeout; nothing here writes to firstmate state.

import {mkdir, open, readFile, stat} from 'node:fs/promises';
import path from 'node:path';

import {buildRoster, type Agent, type Detail} from '../fleet/agent.js';
import {parseBearings, type Bearings} from '../fleet/bearings.js';
import {noRun, parsePipeline, type Pipeline} from '../fleet/pipeline.js';
import {parsePr, PR_FIELDS, type PR} from '../fleet/pr.js';
import {parseBusy, parseCrewState, parseMeta, parseStatusLog, type Meta} from '../fleet/task.js';
import type {Cmd, Runner} from './run.js';

export interface Config {
	home: string;
	// cacheDir receives the bearings snapshot's parent-side remote summary
	// cache, so refreshing never writes into the firstmate home's state/.
	cacheDir: string;
	fleetTimeoutMs: number;
	taskTimeoutMs: number;
	prTimeoutMs: number;
	focusTimeoutMs: number;
	concurrency: number; // concurrent local commands
	prConcurrency: number; // concurrent GitHub reads
}

// Fleet is one bearings read and the agents it yields.
export interface Fleet {
	bearings: Bearings;
	agents: Agent[];
}

// Source is everything the view reads; the model calls it only through
// effects, never while rendering.
export interface Source {
	fleet(): Promise<Fleet>;
	task(a: Agent): Promise<Detail>;
	pr(url: string): Promise<PR>;
	focus(session: string, pane: string): Promise<void>;
}

// Limiter runs at most n tasks at once.
class Limiter {
	private active = 0;
	private readonly queue: (() => void)[] = [];
	constructor(private readonly n: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.n) await new Promise<void>((r) => this.queue.push(r));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

// bearingsCmd is the snapshot command. Decisions are uncapped so a captain
// decision is never dropped from the view by the default display bound.
export function bearingsCmd(cfg: Pick<Config, 'home' | 'cacheDir'>): Cmd {
	const env: Record<string, string> = {FM_HOME: cfg.home, FM_BEARINGS_DECISIONS: '1000'};
	if (cfg.cacheDir) env['FM_SNAPSHOT_CACHE_DIR'] = cfg.cacheDir;
	return {
		name: path.join(cfg.home, 'bin', 'fm-bearings-snapshot.sh'),
		args: ['--json', '--all-in-flight'],
		cwd: cfg.home,
		env,
	};
}

// focusCmd focuses a herdr pane. herdr routes reliably only when the session
// is named both in HERDR_SESSION and as a trailing --session flag.
export function focusCmd(session: string, pane: string): Cmd {
	if (!session) return {name: 'herdr', args: ['agent', 'focus', pane]};
	return {name: 'herdr', args: ['agent', 'focus', pane, '--session', session], env: {HERDR_SESSION: session}};
}

export class FleetSource implements Source {
	private readonly local: Limiter;
	private readonly remote: Limiter;

	constructor(
		private readonly cfg: Config,
		private readonly run: Runner,
		private readonly now: () => number = Date.now,
	) {
		this.local = new Limiter(Math.max(cfg.concurrency, 1));
		this.remote = new Limiter(Math.max(cfg.prConcurrency, 1));
	}

	async fleet(): Promise<Fleet> {
		if (this.cfg.cacheDir) await mkdir(path.dirname(this.cfg.cacheDir), {recursive: true, mode: 0o700});
		const r = await this.run(bearingsCmd(this.cfg), this.cfg.fleetTimeoutMs);
		let bearings: Bearings;
		try {
			bearings = parseBearings(r.stdout);
		} catch (error) {
			throw new Error(r.error ?? (error as Error).message);
		}
		const smMeta = new Map<string, Meta>();
		const owners = new Set(bearings.secondmates.map((s) => s.id));
		for (const f of bearings.inFlight) {
			const slash = f.id.indexOf('/');
			if (slash >= 0) owners.add(f.id.slice(0, slash));
		}
		for (const id of owners) {
			const text = await readOptional(path.join(this.cfg.home, 'state', `${id}.meta`));
			if (text !== undefined) smMeta.set(id, parseMeta(text));
		}
		return {bearings, agents: buildRoster(bearings, this.cfg.home, smMeta)};
	}

	// task reads one agent's meta, status log, busy state, crew state, and
	// no-mistakes run.
	async task(a: Agent): Promise<Detail> {
		const d: Detail = {status: [], fetchedAt: this.now()};
		if (a.absent || !a.home) return d;
		const state = path.join(a.home, 'state');
		try {
			d.meta = parseMeta(await readFile(path.join(state, `${a.taskId}.meta`), 'utf8'));
		} catch (error) {
			d.metaError = (error as Error).message;
		}
		try {
			const {text, modified} = await readTail(path.join(state, `${a.taskId}.status`), 64 * 1024);
			d.status = parseStatusLog(text);
			d.statusModified = modified;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') d.statusError = (error as Error).message;
		}
		const busy = await readOptional(path.join(state, `${a.taskId}.busy-state`));
		if (busy !== undefined) {
			try {
				d.busy = parseBusy(busy);
			} catch {
				// An unknown record version reads as no busy state.
			}
		}
		if (d.meta?.remoteHost) return d;

		const crew = await this.local.run(() =>
			this.run(
				{name: path.join(a.home, 'bin', 'fm-crew-state.sh'), args: [a.taskId], cwd: a.home, env: {FM_HOME: a.home}},
				this.cfg.taskTimeoutMs,
			),
		);
		try {
			d.crew = parseCrewState(crew.stdout);
		} catch (error) {
			d.crewError = crew.error ?? (error as Error).message;
		}

		const runId = d.crew?.runId ?? '';
		if (!runId && d.meta?.mode !== 'no-mistakes') return d;
		try {
			d.pipeline = await this.pipeline(a, d.meta, runId);
		} catch (error) {
			d.pipelineError = (error as Error).message;
		}
		return d;
	}

	private async pipeline(a: Agent, meta: Meta | undefined, runId: string): Promise<Pipeline> {
		let cwd = a.home;
		if (meta && (await isDir(meta.worktree))) cwd = meta.worktree;
		else if (!runId) return noRun('worktree gone');
		const args = ['axi', 'status', ...(runId ? ['--run', runId] : [])];
		const r = await this.local.run(() => this.run({name: 'no-mistakes', args, cwd}, this.cfg.taskTimeoutMs));
		let p: Pipeline;
		try {
			p = parsePipeline(r.stdout);
		} catch (error) {
			throw new Error(r.error ?? (error as Error).message);
		}
		// Without a run id from crew-state, the worktree's latest run counts only
		// when it is on the task's own branch.
		if (!runId && !p.noRun && meta?.branch && p.branch !== meta.branch) {
			return noRun(`latest run is on ${p.branch}, not this task's branch`, meta.branch);
		}
		return p;
	}

	// pr reads one pull request and its checks.
	async pr(url: string): Promise<PR> {
		const r = await this.remote.run(() => this.run({name: 'gh', args: ['pr', 'view', url, '--json', PR_FIELDS]}, this.cfg.prTimeoutMs));
		if (r.error) throw new Error(r.error);
		return parsePr(r.stdout);
	}

	async focus(session: string, pane: string): Promise<void> {
		const r = await this.run(focusCmd(session, pane), this.cfg.focusTimeoutMs);
		if (r.error) throw new Error(r.error);
	}
}

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

// readTail returns at most limit trailing bytes of a file, starting at a
// whole line, and the file's modification time.
export async function readTail(file: string, limit: number): Promise<{text: string; modified: number}> {
	const fh = await open(file, 'r');
	try {
		const info = await fh.stat();
		const offset = Math.max(info.size - limit, 0);
		const buf = Buffer.alloc(info.size - offset);
		await fh.read(buf, 0, buf.length, offset);
		let text = buf.toString('utf8');
		if (offset > 0) {
			const nl = text.indexOf('\n');
			text = nl >= 0 ? text.slice(nl + 1) : '';
		}
		return {text, modified: info.mtimeMs};
	} finally {
		await fh.close();
	}
}

async function isDir(p: string): Promise<boolean> {
	if (!p) return false;
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}
