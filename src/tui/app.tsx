import {Box, Text, useApp, useInput, useWindowSize} from 'ink';
import {useEffect, useReducer, useRef} from 'react';

import type {Source} from '../collect/collect.js';
import type {Effect, Event, Model} from './model.js';
import {boardLines, footer, header} from './render.js';

const TICK_MS = 1000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// App renders the model and runs its effects: every read goes through the
// source in the background, and its result returns to the model as an event.
// Opening a run shows it in a herdr popup over the board when fleetwatch runs
// inside herdr; otherwise it suspends the app and hands the terminal to
// no-mistakes until the captain leaves its view.
export function App({model, source}: {model: Model; source: Source}) {
	const {exit, suspendTerminal} = useApp();
	const {columns, rows} = useWindowSize();
	const [, rerender] = useReducer((n: number) => n + 1, 0);

	const dispatch = useRef((ev: Event) => {
		run(model.dispatch(ev));
		rerender();
	}).current;
	const run = (effects: Effect[]) => {
		for (const e of effects) {
			switch (e.kind) {
				case 'fleet':
					source.fleet().then(
						(fleet) => dispatch({type: 'fleet', fleet}),
						(error: unknown) => dispatch({type: 'fleetError', error: message(error)}),
					);
					break;
				case 'task':
					source.task(e.agent).then(
						(detail) => dispatch({type: 'task', id: e.agent.id, detail}),
						(error: unknown) =>
							dispatch({type: 'task', id: e.agent.id, detail: {status: [], fetchedAt: model.now(), crewError: message(error)}}),
					);
					break;
				case 'attach': {
					const {agent, worktree, runId} = e;
					const fullScreen = (note?: string) =>
						suspendTerminal(() => source.attach(agent, worktree, runId)).then(
							() => dispatch({type: 'attached', id: agent.id, note}),
							(error: unknown) => dispatch({type: 'attachError', id: agent.id, error: message(error)}),
						);
					// A popup leaves the board running underneath; without one, the run
					// takes the whole terminal.
					source.popup(agent, worktree, runId).then(
						(opened) => {
							if (!opened) fullScreen();
						},
						(error: unknown) => fullScreen(`no herdr popup (${message(error)}); fleetwatch herdr-setup links it`),
					);
					break;
				}
				case 'quit':
					exit();
					break;
			}
		}
	};

	if (model.columns !== columns || model.height !== rows) model.dispatch({type: 'resize', columns, rows});

	useEffect(() => {
		run(model.start());
		const timer = setInterval(() => dispatch({type: 'tick'}), TICK_MS);
		return () => clearInterval(timer);
	}, []);

	useInput((input, key) => dispatch({type: 'key', input, key}));

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Text wrap="truncate">{header(model)}</Text>
			<Box height={model.bodyHeight()}>
				<Text wrap="truncate">{boardLines(model).join('\n')}</Text>
			</Box>
			<Text wrap="truncate">{footer(model)}</Text>
		</Box>
	);
}
