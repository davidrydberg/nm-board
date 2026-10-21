// Pure text rendering of the model: header, board, and footer as styled
// lines. The Ink app lays these out; tests read them directly.

import chalk, {type ChalkInstance} from 'chalk';
import stringWidth from 'string-width';

import type {Agent} from '../fleet/agent.js';
import {MAIN_OWNER} from '../fleet/bearings.js';
import {statusLabel} from '../fleet/pipeline.js';
import {columnWidths, visibleEnd, type Card} from './board.js';
import type {Model} from './model.js';

const FLASH_MS = 5000;

const dim = chalk.gray;
const bold = chalk.bold;
const accent = chalk.bold.blueBright;
const warn = chalk.yellow;
const error = chalk.red;
const decision = chalk.bold.magentaBright;

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
	let left = accent('nm-watch') + dim(m.bearings.home ? ` · ${m.bearings.home}` : '');
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

// freshness reports how old the fleet read is, flagging stale data.
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
	return parts.join(' ');
}

// boardLines is the board: column headings, cards, and an info line about
// the selected card, filling the body height.
export function boardLines(m: Model): string[] {
	const h = m.bodyHeight();
	const lines: string[] = [];
	if (!m.board.some((c) => c.cards.length > 0)) {
		if (!m.loaded && m.fleetError !== undefined) lines.push(error('the fleet snapshot failed; retrying'));
		else if (!m.loaded || m.taskPending.size > 0) lines.push(dim('reading runs…'));
		else if (m.filter) lines.push(dim('no runs match the filter'));
		else lines.push(dim('no no-mistakes runs in flight'));
		return lines;
	}
	const widths = columnWidths(m.board, m.columns);
	const end = visibleEnd(widths, m.boardLeft, m.columns);
	const blocks: string[][] = [];
	for (let i = m.boardLeft; i < end; i++) blocks.push(columnLines(m, i, widths[i]!, h - 1));
	for (let r = 0; r < h - 1; r++) lines.push(blocks.map((b) => b[r]!).join(dim('│')));
	lines.push(boardInfo(m, end));
	return lines;
}

function columnLines(m: Model, i: number, w: number, height: number): string[] {
	const c = m.board[i]!;
	const out: string[] = [];
	if (c.cards.length === 0) {
		out.push(pad(dim(truncate(` ${c.name}`, w)), w), dim('─'.repeat(w)));
	} else {
		const human = c.cards.some((card) => card.human);
		out.push(pad((human ? decision : bold)(truncate(` ${c.name.toUpperCase()} ${c.cards.length}`, w)), w));
		const top = i === m.col ? m.cardTop : 0;
		const slots = m.cardSlots();
		const above = top > 0 ? truncate(`↑ ${top} more `, w) : '';
		out.push(dim(above + '─'.repeat(w - stringWidth(above))));
		for (let k = top; k < c.cards.length && k < top + slots; k++) {
			out.push(...cardLines(m, c.cards[k]!, w, i === m.col && k === m.card), ' '.repeat(w));
		}
		const below = c.cards.length - top - slots;
		if (below > 0) out[out.length - 1] = pad(dim(truncate(` ↓ ${below} more`, w)), w);
	}
	while (out.length < height) out.push(' '.repeat(w));
	return out.slice(0, height);
}

// cardLines is one card: the task, its step status in full, and its project
// with how long the run has been at the step, when no-mistakes reports it. A card waiting on a person is
// drawn in the decision colour.
function cardLines(m: Model, c: Card, w: number, selected: boolean): string[] {
	const a = m.agents[c.agent]!;
	const flag = (m.infos.get(a.id)?.decisions.length ?? 0) > 0 ? '⚑ ' : '';
	const inner = w - 2;
	const right = c.spent ? ` ${c.spent}` : '';
	const task = truncate(flag + a.id, inner);
	const status = truncate(statusLabel(c.status), inner);
	const project = truncate(projectLabel(a), Math.max(inner - stringWidth(right), 4));
	const gap = ' '.repeat(Math.max(inner - stringWidth(project) - stringWidth(right), 0));
	const bar = (c.human ? decision : barStyle(c.status))('▌');
	if (selected) return [task, status, project + gap + right].map((l) => bar + chalk.inverse(pad(` ${l}`, w - 1)));
	return [
		`${bar} ${pad((c.human ? decision : bold)(task), inner)}`,
		`${bar} ${pad(stepStyle(c.status)(status), inner)}`,
		`${bar} ${dim(project)}${gap}${right}`,
	];
}

function barStyle(status: string): ChalkInstance {
	switch (status) {
		case 'running':
		case 'fixing':
		case 'passed':
			return chalk.green;
		case 'unreadable':
			return error;
		default:
			return chalk.gray;
	}
}

// boardInfo names the selected card's task and run, and the columns
// scrolled off either side.
function boardInfo(m: Model, end: number): string {
	const hidden = [m.boardLeft > 0 ? `‹ ${m.boardLeft} more` : '', end < m.board.length ? `${m.board.length - end} more ›` : '']
		.filter((s) => s !== '')
		.join('  ');
	const right = hidden ? dim(` ${hidden}`) : '';
	const a = m.selectedCardAgent();
	let left = '';
	if (a) {
		const d = m.details.get(a.id);
		const p = d?.pipeline;
		let note = '';
		if (d?.pipelineError) note = error(`no-mistakes: ${firstLine(d.pipelineError)}`);
		else if (p?.noRun) note = dim(p.note || 'no run');
		else if (p?.error) note = error(firstLine(p.error));
		else if (p) note = dim(`run ${p.runId}`);
		left = [bold(a.id), a.name && a.name !== a.id ? a.name : '', note].filter((s) => s !== '').join(dim(' · '));
	}
	const shown = truncate(left, Math.max(m.columns - stringWidth(right), 0));
	return shown + ' '.repeat(Math.max(m.columns - stringWidth(shown) - stringWidth(right), 0)) + right;
}

export function footer(m: Model): string {
	if (m.filtering) return `/${m.filter}${chalk.inverse(' ')}` + dim('  enter keeps · esc clears');
	const help = `←/→ column · ↑/↓ card · enter open run${m.cfg.popup ? ' (esc closes it)' : ''} · / filter · r refresh · q quit`;
	const parts: string[] = [];
	if (m.filter) parts.push(warn(`filter: ${m.filter} (esc clears)`));
	if (m.flash && m.now() - m.flashAt < FLASH_MS) parts.push(bold(m.flash));
	parts.push(dim(help));
	return truncate(parts.join('  '), m.columns);
}

function stepStyle(status: string): ChalkInstance {
	switch (status) {
		case 'completed':
		case 'passed':
			return chalk.green;
		case 'running':
		case 'fixing':
			return chalk.bold;
		case 'awaiting_approval':
		case 'fix_review':
			return chalk.yellow;
		case 'failed':
		case 'unreadable':
			return chalk.red;
		default:
			return chalk.gray;
	}
}

function projectLabel(a: Agent): string {
	return a.owner === MAIN_OWNER ? a.repo : `${a.repo} via ${a.owner}`;
}
