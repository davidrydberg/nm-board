import stringWidth from 'string-width';

import type {Agent, Detail} from '../fleet/agent.js';
import {needsHuman, PIPELINE_STEPS, position} from '../fleet/pipeline.js';
import {matches, type Info} from './rows.js';

// NO_RUN leads the board with tasks that have no run yet; FINISHED ends it
// with runs that reached their outcome.
export const NO_RUN = 'no run';
export const FINISHED = 'finished';

// Card is one task on the board. status is the step status or run outcome as
// no-mistakes names it; spent is how long it has been there, when reported.
export interface Card {
	agent: number; // index into agents
	status: string;
	spent: string;
	human: boolean;
}

export interface Column {
	name: string;
	cards: Card[];
}

// Place is the column a task's run belongs in.
export interface Place {
	column: string;
	status: string;
	spent: string;
}

// place puts a task with a pipeline read on the board. Tasks whose run was
// never read, such as scouts, have no place.
export function place(d: Detail | undefined): Place | undefined {
	if (!d) return undefined;
	if (d.pipelineError) return {column: NO_RUN, status: 'unreadable', spent: ''};
	if (!d.pipeline) return undefined;
	if (d.pipeline.noRun) return {column: NO_RUN, status: NO_RUN, spent: ''};
	const pos = position(d.pipeline);
	return {column: pos.finished ? FINISHED : pos.step, status: pos.status, spent: pos.spent};
}

// buildBoard lays tasks out in one column per pipeline step, in pipeline
// order, between NO_RUN and FINISHED. Within a column, cards waiting on a
// person come first.
export function buildBoard(agents: Agent[], details: Map<string, Detail>, infos: Map<string, Info>, filter: string): Column[] {
	const needle = filter.trim().toLowerCase();
	let steps = PIPELINE_STEPS;
	const cards = new Map<string, Card[]>();
	agents.forEach((a, i) => {
		const d = details.get(a.id);
		const inf = infos.get(a.id);
		const at = place(d);
		if (a.secondmate || a.absent || !inf || !at) return;
		const run = d?.pipeline?.steps.map((s) => s.name) ?? [];
		if (at.column !== NO_RUN && at.column !== FINISHED) run.push(at.column);
		steps = mergeSteps(steps, run);
		if (needle && !matches(a, inf, needle) && !at.status.includes(needle) && !at.column.includes(needle)) return;
		const card = {agent: i, status: at.status, spent: at.spent, human: needsHuman(at.status)};
		cards.set(at.column, [...(cards.get(at.column) ?? []), card]);
	});
	return [NO_RUN, ...steps, FINISHED].map((name) => ({
		name,
		cards: (cards.get(name) ?? []).sort((x, y) => Number(y.human) - Number(x.human) || compare(agents[x.agent]!.id, agents[y.agent]!.id)),
	}));
}

const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

// mergeSteps adds the steps of one run that base lacks, each after the step
// it follows in that run.
export function mergeSteps(base: string[], run: string[]): string[] {
	const out = [...base];
	let at = 0;
	for (const name of run) {
		const i = out.indexOf(name);
		if (i >= 0) {
			at = i + 1;
			continue;
		}
		out.splice(at++, 0, name);
	}
	return out;
}

// CARD_MIN and CARD_MAX bound a column that holds cards. An empty column
// shrinks to its name, so the busy columns get the room.
export const CARD_MIN = 22;
export const CARD_MAX = 36;

export function columnWidths(board: Column[], total: number): number[] {
	const narrow = (c: Column) => stringWidth(c.name) + 1;
	let room = total - Math.max(board.length - 1, 0);
	let full = 0;
	for (const c of board) {
		if (c.cards.length === 0) room -= narrow(c);
		else full++;
	}
	const each = full === 0 ? 0 : Math.min(Math.max(Math.floor(room / full), CARD_MIN), CARD_MAX);
	return board.map((c) => (c.cards.length === 0 ? narrow(c) : each));
}

// visibleEnd returns the index after the last column that fits on screen
// when the board starts at column left. One column always shows.
export function visibleEnd(widths: number[], left: number, total: number): number {
	let used = 0;
	let end = left;
	while (end < widths.length) {
		const need = used + (end > left ? 1 : 0) + widths[end]!;
		if (need > total && end > left) break;
		used = need;
		end++;
	}
	return end;
}

// CARD_LINES is the height of one card: task, status, and project.
export const CARD_LINES = 3;
