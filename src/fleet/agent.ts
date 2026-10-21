import {MAIN_OWNER, secondmateHost, type Bearings, type Decision} from './bearings.js';
import {askUser, type Pipeline} from './pipeline.js';
import {openDecisions, type CrewState, type Meta, type StatusEntry} from './task.js';

// SECONDMATE_GROUP is the project group secondmate homes are listed under.
export const SECONDMATE_GROUP = 'secondmates';

// Agent is one row nm-watch shows: an underway task or a secondmate home.
export interface Agent {
	// id is the bearings id; secondmate children read "<secondmate>/<task>".
	id: string;
	// taskId is the id inside the home that owns the task's state files.
	taskId: string;
	// home is the firstmate home whose state/ and bin/ serve this agent.
	home: string;
	owner: string; // MAIN_OWNER or the owning secondmate id
	kind: string;
	repo: string;
	name: string;
	// state and doing are the bearings snapshot's reading.
	state: string;
	doing: string;
	secondmate: boolean;
	// absent marks an agent nm-watch does not read, such as a remote
	// secondmate home reachable only over ssh.
	absent: boolean;
	absentReason: string;
}

// Detail is everything read for one agent in a local refresh. Times are epoch
// milliseconds.
export interface Detail {
	meta?: Meta;
	metaError?: string;
	status: StatusEntry[];
	statusError?: string;
	crew?: CrewState;
	crewError?: string;
	pipeline?: Pipeline;
	pipelineError?: string;
	fetchedAt: number;
}

// repoLabel names a project. Bearings falls back to the task's project path
// when the backlog records no repo, so a path is reduced to its last element.
function repoLabel(repo: string): string {
	const i = repo.lastIndexOf('/');
	return i >= 0 && i < repo.length - 1 ? repo.slice(i + 1) : repo;
}

// buildRoster turns a bearings snapshot into the agents to show. smMeta holds
// state/<id>.meta of each secondmate in the main home. Children of a remote
// secondmate are not listed: the home itself shows as absent.
export function buildRoster(b: Bearings, home: string, smMeta: Map<string, Meta>): Agent[] {
	const remote = (id: string): {isRemote: boolean; host: string} => {
		const m = smMeta.get(id);
		const host = m?.remoteHost || secondmateHost(b, id);
		if (host) return {isRemote: true, host};
		return {isRemote: !m || m.home === '', host: ''};
	};
	const agents: Agent[] = [];
	for (const r of b.inFlight) {
		const a: Agent = {
			id: r.id,
			taskId: r.id,
			home,
			owner: MAIN_OWNER,
			kind: r.kind,
			repo: repoLabel(r.repo),
			name: r.name,
			state: r.state,
			doing: r.doing,
			secondmate: false,
			absent: false,
			absentReason: '',
		};
		const slash = r.id.indexOf('/');
		if (slash >= 0) {
			const owner = r.id.slice(0, slash);
			if (remote(owner).isRemote) continue;
			a.owner = owner;
			a.taskId = r.id.slice(slash + 1);
			a.home = smMeta.get(owner)!.home;
		}
		agents.push(a);
	}
	for (const s of b.secondmates) {
		const {isRemote, host} = remote(s.id);
		agents.push({
			id: s.id,
			taskId: s.id,
			home,
			owner: MAIN_OWNER,
			kind: 'secondmate',
			repo: SECONDMATE_GROUP,
			name: '',
			state: s.state,
			doing: s.doing,
			secondmate: true,
			absent: isRemote,
			absentReason: !isRemote
				? ''
				: host
					? `remote home on ${host} is not read by nm-watch v1`
					: 'secondmate home is not readable from this host',
		});
	}
	return agents;
}

// currentState is the per-task crew-state read when one succeeded, else the
// bearings reading.
export function currentState(a: Agent, d?: Detail): string {
	if (a.absent) return 'absent';
	return d?.crew?.state ?? a.state;
}

// currentDoing is the latest one-line description of what the agent is doing.
export function currentDoing(a: Agent, d?: Detail): string {
	if (a.absent) return a.absentReason;
	return d?.crew?.detail || a.doing;
}

// isInactive states are shown dimmed and can be collapsed.
export function isInactive(state: string): boolean {
	return state === 'done' || state === 'unknown' || state === 'absent';
}

// PendingDecision is something waiting on the captain.
export interface PendingDecision {
	source: string; // captain-hold, needs-decision, ask-user
	key: string;
	text: string;
	at?: number;
}

// captainDecisions lists what waits on the captain for this agent: captain
// holds bearings reports for it, needs-decision status entries no resolved
// line closed, and ask-user findings parked at a pipeline gate.
export function captainDecisions(a: Agent, d: Detail | undefined, open: Decision[]): PendingDecision[] {
	if (a.absent) return [];
	const keys = d?.meta?.decisionKeys ?? [];
	const out: PendingDecision[] = open
		.filter((dec) => dec.id === a.id || (dec.owner === a.owner && keys.includes(dec.key)))
		.map((dec) => ({source: dec.verb, key: dec.key, text: dec.summary}));
	if (!d) return out;
	for (const e of openDecisions(d.status)) {
		out.push({source: 'needs-decision', key: e.key, text: e.text, at: e.at});
	}
	if (d.pipeline) {
		for (const f of askUser(d.pipeline)) out.push({source: 'ask-user', key: f.id, text: f.description});
	}
	return out;
}
