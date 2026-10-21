// A synthetic stand-in for no-mistakes' view of one demo run. It looks like
// a run's view but only reads the demo fleet; its decision keys do nothing.

import {Box, Text, useApp, useInput} from 'ink';
import {useEffect, useState} from 'react';

import {statusLabel} from '../fleet/pipeline.js';
import {age} from '../tui/render.js';
import {DEMO_TASKS, demoPipeline} from './fleet.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const title = (step: string) => (step.length <= 2 ? step.toUpperCase() : step.charAt(0).toUpperCase() + step.slice(1));

export function DemoView({index, start}: {index: number; start: number}) {
	const {exit} = useApp();
	const [now, setNow] = useState(start);
	const [cursor, setCursor] = useState(0);
	const [note, setNote] = useState('');
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(timer);
	}, []);
	const t = DEMO_TASKS[index]!;
	const p = demoPipeline(index, start, now);
	const findings = p.gate?.findings ?? [];

	useInput((input, key) => {
		if (key.escape || input === 'q' || (key.ctrl && input === 'c')) exit();
		else if (key.downArrow || input === 'j') setCursor((c) => Math.min(c + 1, Math.max(findings.length - 1, 0)));
		else if (key.upArrow || input === 'k') setCursor((c) => Math.max(c - 1, 0));
		else if (input) setNote(`demo run: "${input}" does nothing here`);
	});

	const spin = SPINNER[Math.floor(now / 100) % SPINNER.length]!;
	const outcome = p.outcome === 'passed' ? '✓ Pipeline passed' : p.outcome === 'failed' ? '✗ Pipeline failed' : '';
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box justifyContent="space-between">
				<Text>
					<Text bold color="blueBright">
						no-mistakes
					</Text>
					<Text dimColor>
						{'  '}
						{p.branch} · {t.repo}
					</Text>
				</Text>
				<Text dimColor>run {p.runId}</Text>
			</Box>
			<Text> </Text>
			{p.steps.map((s) => {
				const active = p.active.find((a) => a.step === s.name);
				const parked = p.gate?.step === s.name;
				const icon =
					s.status === 'completed' ? (
						<Text color="green">✓</Text>
					) : s.status === 'failed' ? (
						<Text color="red">✗</Text>
					) : active ? (
						<Text color="cyan">{spin}</Text>
					) : parked ? (
						<Text color="yellow">◉</Text>
					) : (
						<Text dimColor>○</Text>
					);
				let detail = '';
				if (s.status === 'completed') detail = age(s.durationMs);
				else if (active) detail = `${statusLabel(s.status)} · ${active.activeFor} · ${active.lastActivity}`;
				else if (parked) detail = `${statusLabel(s.status)} · ${findings.length} findings · ${p.awaitingAgent}`;
				else if (s.status === 'failed') detail = 'failed · 3 tests failing in test/limits.test.ts';
				return (
					<Text key={s.name}>
						{'  '}
						{icon} <Text bold={Boolean(active || parked)}>{title(s.name).padEnd(10)}</Text>
						<Text dimColor={s.status !== 'pending' && !parked}>{detail}</Text>
					</Text>
				);
			})}
			<Text> </Text>
			{findings.length > 0 && (
				<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
					<Text bold color="yellow">
						{title(p.gate!.step)} findings · risk {p.gate!.risk}
					</Text>
					{findings.map((f, k) => (
						<Box key={f.id} flexDirection="column" marginTop={1}>
							<Text inverse={k === cursor}>
								{k === cursor ? '▸ ' : '  '}
								<Text color={f.severity === 'warning' ? 'yellow' : 'cyan'}>{f.severity.padEnd(8)}</Text>
								{f.file} <Text dimColor>{f.action}</Text>
							</Text>
							<Text wrap="wrap">
								{'    '}
								{f.description}
							</Text>
						</Box>
					))}
				</Box>
			)}
			{outcome && <Text color={p.outcome === 'passed' ? 'green' : 'red'}>{outcome}</Text>}
			<Text> </Text>
			<Text>
				{findings.length > 0 && <Text dimColor>a approve f fix s skip d diff </Text>}
				<Text dimColor>q detach </Text>
				<Text bold>esc</Text>
				<Text dimColor> close · the run keeps going</Text>
			</Text>
			<Text color="magenta">{note || 'demo: a synthetic run; nothing here reaches no-mistakes'}</Text>
		</Box>
	);
}
