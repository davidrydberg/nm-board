import {captainDecisions, currentDoing, currentState, isInactive, type Agent, type Detail, type PendingDecision} from '../fleet/agent.js';
import type {Bearings} from '../fleet/bearings.js';

// Info is what the board derives for one agent from all sources.
export interface Info {
	state: string;
	doing: string;
	decisions: PendingDecision[];
	inactive: boolean;
}

export function deriveInfo(a: Agent, d: Detail | undefined, b: Bearings): Info {
	const state = currentState(a, d);
	return {
		state,
		doing: currentDoing(a, d),
		decisions: captainDecisions(a, d, b.decisions),
		inactive: isInactive(state),
	};
}

export function matches(a: Agent, inf: Info, needle: string): boolean {
	return [a.id, a.name, a.repo, inf.state, inf.doing].some((s) => s.toLowerCase().includes(needle));
}
