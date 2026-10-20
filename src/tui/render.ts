// Pure text rendering of the model: header, list, detail pane, and footer as
// styled lines. The Ink app lays these out; tests read them directly.

import chalk, {type ChalkInstance} from 'chalk';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

import {lastActivity, type Agent, type Detail} from '../fleet/agent.js';
import {MAIN_OWNER} from '../fleet/bearings.js';
import {stage} from '../fleet/pipeline.js';
import {checksSummary} from '../fleet/pr.js';
import type {Meta} from '../fleet/task.js';
import type {Model} from './model.js';
import {DECISIONS_GROUP, isHeader} from './rows.js';

const STATUS_TAIL = 6;
const FLASH_MS = 5000;

const dim = chalk.gray;
const bold = chalk.bold;
const accent = chalk.bold.blueBright;
const warn = chalk.yellow;
const error = chalk.red;
const decision = chalk.bold.magentaBright;

function stateStyle(state: string): ChalkInstance {
	switch (state) {
		case 'working':
			return chalk.green;
		case 'parked':
		case 'paused':
			return chalk.yellow;
		case 'blocked':
		case 'failed':
			return chalk.red;
		default:
			return chalk.gray;
	}
}

function stateIcon(state: string, hasDecision: boolean): string {
	if (hasDecision) return '⚑';
	switch (state) {
		case 'working':
			return '●';
		case 'parked':
		case 'paused':
			return '◐';
		case 'blocked':
		case 'failed':
			return '✗';
		case 'done':
			return '✓';
		case 'absent':
			return '○';
		default:
			return '?';
	}
}

// age renders a duration compactly: 42s, 7m, 3h12m, 2d4h.
export function age(ms: number): string {
	const s = Math.max(Math.floor(ms / 1000), 0);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${String(m - 60 * h).padStart(2, '0')}m`;
	const d = Math.floor(h / 24);
	return `${d}d${h - 24 * d}h`;
}

// since renders "<age> ago", or "never" for no time.
export function since(now: number, t: number | undefined): string {
	return t === undefined ? 'never' : `${age(now - t)} ago`;
}

// truncate cuts a styled string to width columns, ending in an ellipsis.
export function truncate(s: string, width: number, ellipsis = '…'): string {
	if (stringWidth(s) <= width) return s;
	const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
	let out = '';
	for (const ch of plain) {
		if (stringWidth(out + ch + ellipsis) > width) break;
		out += ch;
	}
	return out + ellipsis;
}

const pad = (s: string, width: number) => s + ' '.repeat(Math.max(width - stringWidth(s), 0));

const firstLine = (s: string) => s.split('\n')[0] ?? '';

export function header(m: Model): string {
	const now = m.now();
	let working = 0;
	let waiting = 0;
	for (const a of m.agents) {
		const inf = m.infos.get(a.id);
		if (inf?.state === 'working') working++;
		if (inf && inf.decisions.length > 0) waiting++;
	}
	let left = accent('fleetwatch') + dim(m.bearings.home ? ` · ${m.bearings.home}` : '');
	if (m.loaded) {
		left += ` · ${m.agents.length} agents · ${chalk.green(String(working))} working`;
		if (waiting > 0) left += ' · ' + decision(`${waiting} need the captain`);
		if (m.bearings.decisions.length > 0) left += dim(` · ${m.bearings.decisions.length} captain holds open`);
	}
	// Freshness stays visible on a narrow screen; the counts give way first.
	const right = freshness(m, now);
	const room = m.columns - stringWidth(right) - 1;
	if (room < 10) return truncate(right, m.columns);
	const shown = truncate(left, room);
	return shown + ' '.repeat(m.columns - stringWidth(shown) - stringWidth(right)) + right;
}

// freshness reports how old the fleet and PR reads are, flagging stale data.
export function freshness(m: Model, now: number): string {
	const parts: string[] = [];
	if (m.fleetError !== undefined) {
		parts.push(error(`fleet error: ${firstLine(m.fleetError)}`));
		if (m.fleetAt !== undefined) parts.push(warn(`showing ${since(now, m.fleetAt)}`));
	} else if (!m.loaded) {
		parts.push(dim('reading fleet…'));
	} else {
		const s = `fleet ${since(now, m.fleetAt)}`;
		const stale = now - (m.fleetAt ?? 0) > 3 * m.cfg.fleetIntervalMs + 60_000;
		parts.push(stale ? warn(`${s} (stale)`) : dim(s));
	}
	if (m.fleetBusy) parts.push(dim('↻'));
	if (m.prs.size > 0) {
		let newest: number | undefined;
		let pending = 0;
		let failing = 0;
		for (const e of m.prs.values()) {
			if (e.at !== undefined && (newest === undefined || e.at > newest)) newest = e.at;
			if (e.pending) pending++;
			if (e.error !== undefined) failing++;
		}
		const s = `PRs ${since(now, newest)}`;
		parts.push(failing > 0 ? warn(`${s} (${failing} unreadable)`) : dim(s));
		if (pending > 0) parts.push(dim('↻'));
	}
	return parts.join(' ');
}

export function listLines(m: Model): string[] {
	const w = m.listWidth();
	const h = m.bodyHeight();
	const lines: string[] = [];
	if (m.rows.length === 0) {
		if (!m.loaded && m.fleetError !== undefined) lines.push(error('the fleet snapshot failed; retrying'));
		else if (!m.loaded) lines.push(dim('reading fleet…'));
		else if (m.filter) lines.push(dim('no agents match the filter'));
		else if (m.hidden > 0) lines.push(dim(`all ${m.hidden} agents are inactive; d shows them`));
		else lines.push(dim('no agents in flight'));
	}
	const now = m.now();
	for (let i = m.listTop; i < m.rows.length && lines.length < h; i++) lines.push(rowLine(m, i, w, now));
	return lines.map((l) => truncate(l, w));
}

function rowLine(m: Model, i: number, w: number, now: number): string {
	const r = m.rows[i]!;
	if (isHeader(r)) {
		const isDecisions = r.header === DECISIONS_GROUP;
		const label = (isDecisions ? '⚑ ' : '') + r.header.toUpperCase();
		const count = ` ${r.count}` + (r.hidden > 0 ? ` (+${r.hidden} inactive)` : '');
		return (isDecisions ? decision(label) : bold.gray(label)) + dim(count);
	}
	const a = m.agents[r.agent]!;
	const inf = m.infos.get(a.id)!;
	const d = m.details.get(a.id);
	// The pipeline stage says more than the state, except once the crew is
	// done: a done crew's run may still be monitoring a green PR for merge.
	let label = inf.state;
	if (d?.pipeline && !d.pipeline.noRun && inf.state !== 'done') label = stage(d.pipeline);
	const last = lastActivity(d);
	let right = last === undefined ? label : `${label} ${age(now - last)}`;
	right = truncate(right, Math.floor(w / 2));
	const icon = stateIcon(inf.state, inf.decisions.length > 0);
	const id = truncate(a.id, Math.max(w - 4 - stringWidth(right), 4));
	const gap = ' '.repeat(Math.max(w - 3 - stringWidth(id) - stringWidth(right), 1));
	const plain = ` ${icon} ${id}${gap}${right}`;
	if (i === m.cursor) return chalk.inverse(pad(plain, w));
	if (inf.inactive) return dim(plain);
	const iconStyle = inf.decisions.length > 0 ? decision : stateStyle(inf.state);
	return ` ${iconStyle(icon)} ${id}${gap}${stateStyle(inf.state)(right)}`;
}

export function footer(m: Model): string {
	if (m.filtering) return `/${m.filter}${chalk.inverse(' ')}` + dim('  enter keeps · esc clears');
	const toggle = m.hideInactive ? `d show ${m.hidden} inactive` : 'd hide inactive';
	const help = `↑/↓ select · enter focus in herdr · / filter · ${toggle} · pgup/pgdn scroll · r refresh · q quit`;
	const parts: string[] = [];
	if (m.filter) parts.push(warn(`filter: ${m.filter} (esc clears)`));
	if (m.flash && m.now() - m.flashAt < FLASH_MS) parts.push(bold(m.flash));
	parts.push(dim(help));
	return truncate(parts.join('  '), m.columns);
}

// detailLines is the right pane for one agent, wrapped to width.
export function detailLines(m: Model, a: Agent, width: number): string[] {
	const now = m.now();
	const inf = m.infos.get(a.id);
	const d = m.details.get(a.id);
	const out: string[] = [];
	const line = (s: string) => out.push(...wrapAnsi(s, width, {hard: true}).split('\n'));
	const sub = (s: string) => out.push(...wrapAnsi(s, width - 2, {hard: true}).split('\n').map((l) => `  ${l}`));
	const section = (title: string) => out.push('', accent(title));
	const state = inf?.state ?? a.state;

	line(`${bold(a.id)}  ${stateStyle(state)(`[${state}]`)}`);
	if (a.name && a.name !== a.id) line(a.name);
	line(dim([projectLabel(a), a.kind, metaLabel(d?.meta)].filter((s) => s.trim() !== '').join(' · ')));

	if (a.absent) {
		section('ABSENT');
		line(a.absentReason);
		if (a.doing) line(dim(`last reported by bearings: ${a.doing}`));
		return out;
	}

	section('NOW');
	if (inf?.doing) line(inf.doing);
	const from = d?.crew ? `crew-state (${d.crew.source})` : 'bearings snapshot';
	const harness = d?.busy ? ` · harness ${d.busy.state}` : '';
	line(dim(`last activity ${since(now, lastActivity(d))}${harness} · from ${from}`));
	if (d?.crewError) line(error(`crew-state: ${d.crewError}`));

	if (inf && inf.decisions.length > 0) {
		section('⚑ WAITING ON THE CAPTAIN');
		for (const dec of inf.decisions) {
			let head = dec.source + (dec.key ? ` ${dec.key}` : '');
			if (dec.at !== undefined) head += ` · ${since(now, dec.at)}`;
			line(decision(head));
			sub(dec.text);
		}
	}

	if (d?.pipeline || d?.pipelineError) {
		section('PIPELINE');
		pipelineLines(d, line, sub);
	}

	if (inf?.prUrl) {
		section('PULL REQUEST');
		prLines(m, inf.prUrl, now, line);
	}

	if (d && (d.status.length > 0 || d.statusError)) {
		section('STATUS LOG');
		if (d.statusError) line(error(d.statusError));
		for (const e of d.status.slice(-STATUS_TAIL).reverse()) {
			const when = e.at === undefined ? '' : ` ${since(now, e.at)}`;
			line(`${stateStyle(logState(e.state))(e.state)}${dim(when)}  ${firstLine(e.text)}`);
		}
	}

	section('ENDPOINT');
	const meta = d?.meta;
	if (meta) {
		if (meta.herdrPane) line(`herdr ${meta.herdrSession} ${meta.herdrPane}${dim('  (enter to focus)')}`);
		else if (meta.window) line(`${meta.backend} ${meta.window}`);
		if (meta.worktree) line(dim(meta.worktree));
		if (meta.branch) line(dim(`branch ${meta.branch}`));
	} else if (d?.metaError) {
		line(error(`meta: ${d.metaError}`));
	}
	if (!d) {
		line(dim(m.taskPending.has(a.id) ? 'reading agent state…' : 'agent state not read yet'));
	} else {
		const every = inf?.inactive ? m.cfg.inactiveIntervalMs : m.cfg.intervalMs;
		const read = `read ${since(now, d.fetchedAt)}`;
		line(now - d.fetchedAt > 3 * every + 60_000 ? warn(`${read} (stale)`) : dim(read));
	}
	return out;
}

function pipelineLines(d: Detail, line: (s: string) => void, sub: (s: string) => void): void {
	if (d.pipelineError) {
		line(error(`no-mistakes: ${d.pipelineError}`));
		return;
	}
	const p = d.pipeline!;
	if (p.noRun) {
		line(dim(p.note || 'no run'));
		return;
	}
	line(`run ${p.runId} · ${p.status}${p.outcome ? ` · outcome ${p.outcome}` : ''}`);
	if (d.meta?.branch && p.branch && p.branch !== d.meta.branch) {
		line(warn(`run branch ${p.branch} is not this task's branch ${d.meta.branch}`));
	}
	if (p.steps.length > 0) {
		line(p.steps.map((s) => stepStyle(s.status)(`${stepMark(s.status)} ${s.name}${s.findings > 0 ? `(${s.findings})` : ''}`)).join('  '));
	}
	for (const act of p.active) {
		line(`${act.step} ${act.status} for ${act.activeFor}`);
		if (act.lastActivity) sub(dim(act.lastActivity));
	}
	if (p.awaitingAgent) line(warn(`awaiting agent: ${p.awaitingAgent}`));
	if (p.gate) {
		line(warn(`gate at ${p.gate.step} (${p.gate.status}) · ${p.gate.findings.length} finding(s)`));
		for (const f of p.gate.findings) sub(`${f.action} ${f.severity} ${f.id}${dim(` ${f.file}`)}`);
	} else if (p.findings && p.findings !== 'none') {
		line(dim(`findings: ${p.findings}`));
	}
	if (p.error) line(error(firstLine(p.error)));
}

function prLines(m: Model, url: string, now: number, line: (s: string) => void): void {
	const e = m.prs.get(url);
	if (!e || (e.pr === undefined && e.error === undefined)) {
		line(url);
		line(dim('reading from GitHub…'));
		return;
	}
	if (e.pr) {
		const pr = e.pr;
		const c = pr.checks;
		const checkStyle = c.failed > 0 ? error : c.pending > 0 || c.total === 0 ? warn : chalk.green;
		const parts = [`#${pr.number} ${pr.state}${pr.draft ? ' draft' : ''}`, checkStyle(`checks ${checksSummary(c)}`)];
		if (pr.mergeState) parts.push(pr.mergeState.toLowerCase());
		if (pr.reviewDecision) parts.push(pr.reviewDecision.toLowerCase().replaceAll('_', ' '));
		line(parts.join(' · '));
		line(pr.title);
	}
	line(dim(url));
	if (e.error !== undefined) line(error(`gh: ${e.error}`));
	line(dim(`read ${since(now, e.at)}`));
}

function stepMark(status: string): string {
	switch (status) {
		case 'completed':
			return '✓';
		case 'running':
		case 'fixing':
			return '▶';
		case 'awaiting_approval':
		case 'fix_review':
			return '⏸';
		case 'failed':
			return '✗';
		case 'skipped':
			return '↷';
		default:
			return '·';
	}
}

function stepStyle(status: string): ChalkInstance {
	switch (status) {
		case 'completed':
			return chalk.green;
		case 'running':
		case 'fixing':
			return chalk.bold;
		case 'awaiting_approval':
		case 'fix_review':
			return chalk.yellow;
		case 'failed':
			return chalk.red;
		default:
			return chalk.gray;
	}
}

function logState(s: string): string {
	if (s === 'needs-decision') return 'paused';
	if (s === 'resolved') return 'done';
	return s;
}

function projectLabel(a: Agent): string {
	return a.owner === MAIN_OWNER ? a.repo : `${a.repo} via ${a.owner}`;
}

function metaLabel(meta?: Meta): string {
	if (!meta) return '';
	const model = meta.model + (meta.effort ? `/${meta.effort}` : '');
	return [meta.mode, meta.harness, model].filter((s) => s.trim() !== '').join(' · ');
}
