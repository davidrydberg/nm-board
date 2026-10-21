import {Box, Text, useApp, useInput, useWindowSize} from 'ink';
import {useEffect, useReducer, useRef} from 'react';

import type {Source} from '../collect/collect.js';
import type {Effect, Event, Model} from './model.js';
import {detailLines, footer, header, listLines} from './render.js';

const TICK_MS = 1000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// App renders the model and runs its effects: every read goes through the
// source in the background, and its result returns to the model as an event.
export function App({model, source}: {model: Model; source: Source}) {
	const {exit} = useApp();
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
				case 'pr':
					source.pr(e.url).then(
						(pr) => dispatch({type: 'pr', url: e.url, pr}),
						(error: unknown) => dispatch({type: 'prError', url: e.url, error: message(error)}),
					);
					break;
				case 'focus':
					source.focus(e.session, e.pane).then(
						() => dispatch({type: 'focused', id: e.id}),
						(error: unknown) => dispatch({type: 'focusError', id: e.id, error: message(error)}),
					);
					break;
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

	const h = model.bodyHeight();
	const selected = model.selectedAgent();
	const detail = selected ? detailLines(model, selected, model.detailWidth()) : [];
	const empty = model.loaded ? 'Select an agent.' : 'Waiting for the first fleet snapshot.';
	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Text wrap="truncate">{header(model)}</Text>
			<Box height={h}>
				<Box width={model.listWidth()} flexShrink={0}>
					<Text wrap="truncate">{listLines(model).join('\n')}</Text>
				</Box>
				<Box width={2} flexShrink={0}>
					<Text color="gray">{Array.from({length: h}, () => '│').join('\n')}</Text>
				</Box>
				<Box width={model.detailWidth()} flexShrink={0}>
					<Text wrap="truncate">{selected ? detail.slice(model.detailTop, model.detailTop + h).join('\n') : empty}</Text>
				</Box>
			</Box>
			<Text wrap="truncate">{footer(model)}</Text>
		</Box>
	);
}
