// Opens a run's view in a herdr popup over the board. herdr launches popups
// only for plugin entrypoints, so fleetwatch ships a minimal plugin in
// herdr-plugin/, which `fleetwatch herdr-setup` links. herdr's CLI cannot ask
// for a popup, so the request goes straight to the socket of the herdr server
// fleetwatch runs in.

import {createConnection} from 'node:net';
import {fileURLToPath} from 'node:url';

// PLUGIN_ID and VIEW_ENTRYPOINT name the plugin pane herdr-plugin.toml
// declares.
export const PLUGIN_ID = 'fleetwatch';
export const VIEW_ENTRYPOINT = 'view';

// PLUGIN_DIR is the herdr plugin shipped with the package, and VIEW_SCRIPT the
// program its pane runs.
export const PLUGIN_DIR = fileURLToPath(new URL('../../herdr-plugin', import.meta.url));
export const VIEW_SCRIPT = fileURLToPath(new URL('../view.js', import.meta.url));

// herdrSocket is the API socket of the herdr server fleetwatch runs in, or
// undefined outside herdr.
export function herdrSocket(env: NodeJS.ProcessEnv): string | undefined {
	return env['HERDR_ENV'] === '1' && env['HERDR_SOCKET_PATH'] ? env['HERDR_SOCKET_PATH'] : undefined;
}

// ViewTarget is the run a view shows. A demo view shows a synthetic stand-in
// and never reads no-mistakes.
export interface ViewTarget {
	runId: string;
	cwd: string;
	demo?: boolean;
}

// viewEnv is how a view learns its target: herdr passes environment
// variables, not arguments, to a plugin pane. FLEETWATCH_NODE keeps the view
// on fleetwatch's own Node, whatever herdr's PATH holds.
export function viewEnv(t: ViewTarget): Record<string, string> {
	const env: Record<string, string> = {FLEETWATCH_RUN: t.runId, FLEETWATCH_CWD: t.cwd, FLEETWATCH_NODE: process.execPath};
	if (t.demo) env['FLEETWATCH_DEMO'] = '1';
	return env;
}

// popupRequest is the plugin.pane.open request for a view.
export function popupRequest(t: ViewTarget): object {
	return {
		id: 'fleetwatch-view',
		method: 'plugin.pane.open',
		params: {plugin_id: PLUGIN_ID, entrypoint: VIEW_ENTRYPOINT, placement: 'popup', env: viewEnv(t)},
	};
}

// openPopup asks herdr to open a view in a popup. It resolves once herdr has
// launched it, and rejects with herdr's reason, such as the plugin not being
// linked.
export function openPopup(socket: string, t: ViewTarget, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		let buf = '';
		let settled = false;
		const conn = createConnection(socket);
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			conn.destroy();
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(new Error('herdr did not answer')), timeoutMs);
		conn.on('connect', () => conn.write(JSON.stringify(popupRequest(t)) + '\n'));
		conn.setEncoding('utf8').on('data', (s: string) => {
			buf += s;
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			let res: {result?: unknown; error?: {code?: string; message?: string}};
			try {
				res = JSON.parse(buf.slice(0, nl));
			} catch {
				return finish(new Error('herdr sent an unreadable answer'));
			}
			if (res.error) return finish(new Error(`herdr: ${res.error.message || res.error.code || 'unknown error'}`));
			finish();
		});
		conn.on('error', (error) => finish(new Error(`herdr: ${error.message}`)));
		conn.on('close', () => finish(new Error('herdr closed the connection without answering')));
	});
}
