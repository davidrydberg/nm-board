import {
	captainDecisions,
	currentDoing,
	currentState,
	isInactive,
	prUrl,
	SECONDMATE_GROUP,
	type Agent,
	type Detail,
	type PendingDecision,
} from '../fleet/agent.js';
import type {Bearings} from '../fleet/bearings.js';

// Info is what the list and detail pane derive for one agent from all sources.
export interface Info {
	state: string;
	doing: string;
	decisions: PendingDecision[];
	inactive: boolean;
	prUrl: string;
}

export function deriveInfo(a: Agent, d: Detail | undefined, b: Bearings): Info {
	const state = currentState(a, d);
	return {
		state,
		doing: currentDoing(a, d),
		decisions: captainDecisions(a, d, b.decisions),
		inactive: isInactive(state),
		prUrl: prUrl(a, d, b),
	};
}

// Row is one list line: a group header, or an agent (an index into agents).
export type Row = {header: string; count: number; hidden: number} | {agent: number};

export const isHeader = (r: Row): r is {header: string; count: number; hidden: number} => 'header' in r;

export const DECISIONS_GROUP = 'captain decisions';
export const NO_PROJECT_GROUP = '(no project)';

// buildRows groups agents for the list: agents with an open captain decision
// pinned first, then one group per project, secondmate homes last. Within a
// group, live states sort before inactive ones. It also returns how many
// inactive agents hideInactive left out.
export function buildRows(
	agents: Agent[],
	infos: Map<string, Info>,
	filter: string,
	hideInactive: boolean,
): {rows: Row[]; hidden: number} {
	const needle = filter.trim().toLowerCase();
	const groups = new Map<string, number[]>();
	const hiddenBy = new Map<string, number>();
	let hidden = 0;
	agents.forEach((a, i) => {
		const inf = infos.get(a.id);
		if (!inf) return;
		if (needle && !matches(a, inf, needle)) return;
		const g = groupOf(a, inf);
		if (hideInactive && inf.inactive && inf.decisions.length === 0) {
			hiddenBy.set(g, (hiddenBy.get(g) ?? 0) + 1);
			hidden++;
			return;
		}
		groups.set(g, [...(groups.get(g) ?? []), i]);
	});
	const names = [...groups.keys()].sort((x, y) => groupRank(x) - groupRank(y) || (x < y ? -1 : x > y ? 1 : 0));
	const rows: Row[] = [];
	for (const g of names) {
		const members = groups.get(g)!;
		members.sort((i, j) => {
			const ai = agents[i]!;
			const aj = agents[j]!;
			const rank = stateRank(infos.get(ai.id)!.state) - stateRank(infos.get(aj.id)!.state);
			return rank || (ai.id < aj.id ? -1 : ai.id > aj.id ? 1 : 0);
		});
		rows.push({header: g, count: members.length, hidden: hiddenBy.get(g) ?? 0});
		for (const i of members) rows.push({agent: i});
	}
	return {rows, hidden};
}

function groupOf(a: Agent, inf: Info): string {
	if (inf.decisions.length > 0) return DECISIONS_GROUP;
	return a.repo || NO_PROJECT_GROUP;
}

function groupRank(g: string): number {
	if (g === DECISIONS_GROUP) return 0;
	if (g === SECONDMATE_GROUP) return 2;
	if (g === NO_PROJECT_GROUP) return 3;
	return 1;
}

function stateRank(state: string): number {
	switch (state) {
		case 'working':
			return 0;
		case 'parked':
		case 'paused':
			return 1;
		case 'blocked':
		case 'failed':
			return 2;
		case 'done':
			return 4;
		case 'absent':
			return 6;
		default:
			return isInactive(state) ? 5 : 3;
	}
}

function matches(a: Agent, inf: Info, needle: string): boolean {
	return [a.id, a.name, a.repo, inf.state, inf.doing].some((s) => s.toLowerCase().includes(needle));
}
