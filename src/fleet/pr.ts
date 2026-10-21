// PR_FIELDS is the --json field list fleetwatch requests from `gh pr view`.
export const PR_FIELDS = 'number,title,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,url,headRefName';

// Checks summarises statusCheckRollup. failedNames and pendingNames name the
// checks behind those counts.
export interface Checks {
	total: number;
	passed: number;
	failed: number;
	pending: number;
	skipped: number;
	failedNames: string[];
	pendingNames: string[];
}

// PR is a pull request and its check rollup as `gh pr view --json` reports it.
export interface PR {
	number: number;
	title: string;
	url: string;
	state: string; // OPEN, MERGED, CLOSED
	draft: boolean;
	reviewDecision: string;
	mergeState: string;
	headRef: string;
	checks: Checks;
}

type Raw = Record<string, unknown>;

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

export function parsePr(text: string): PR {
	let raw: Raw;
	try {
		raw = JSON.parse(text) as Raw;
	} catch (error) {
		throw new Error(`gh pr view: ${(error as Error).message}`);
	}
	if (typeof raw?.['number'] !== 'number' || raw['number'] === 0) {
		throw new Error('gh pr view: no pull request number in output');
	}
	const checks: Checks = {total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, failedNames: [], pendingNames: []};
	const rollup = Array.isArray(raw['statusCheckRollup']) ? (raw['statusCheckRollup'] as Raw[]) : [];
	for (const c of rollup) addCheck(checks, c);
	return {
		number: raw['number'],
		title: str(raw['title']),
		url: str(raw['url']),
		state: str(raw['state']),
		draft: raw['isDraft'] === true,
		reviewDecision: str(raw['reviewDecision']),
		mergeState: str(raw['mergeStateStatus']),
		headRef: str(raw['headRefName']),
		checks,
	};
}

// addCheck counts one rollup entry. Entries are either a CheckRun (status,
// conclusion, name) or a commit StatusContext (state, context).
function addCheck(c: Checks, g: Raw): void {
	const name = str(g['name']) || str(g['context']);
	const status = str(g['status']);
	const state = str(g['state']);
	let outcome: 'pass' | 'skip' | 'pending' | 'fail';
	if (g['__typename'] === 'StatusContext' || (status === '' && state !== '')) {
		outcome = state === 'SUCCESS' ? 'pass' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'fail';
	} else {
		const conclusion = str(g['conclusion']);
		if (status !== 'COMPLETED') outcome = 'pending';
		else if (conclusion === 'SUCCESS') outcome = 'pass';
		else if (conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') outcome = 'skip';
		else outcome = 'fail';
	}
	c.total++;
	if (outcome === 'pass') c.passed++;
	else if (outcome === 'skip') c.skipped++;
	else if (outcome === 'pending') {
		c.pending++;
		c.pendingNames.push(name);
	} else {
		c.failed++;
		c.failedNames.push(name);
	}
}

// checksSummary is a short human reading of the rollup.
export function checksSummary(c: Checks): string {
	if (c.total === 0) return 'no checks';
	if (c.failed > 0) return `${c.failed} failing: ${c.failedNames.join(', ')}`;
	if (c.pending > 0) return `${c.pending} pending: ${c.pendingNames.join(', ')}`;
	return `${c.passed}/${c.total - c.skipped} passing`;
}

// isTerminal reports whether the PR can no longer change state.
export function isTerminal(pr: PR): boolean {
	return pr.state === 'MERGED' || pr.state === 'CLOSED';
}
