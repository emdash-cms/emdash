// Deterministic renderers for the generated machine artifacts. The state
// machine in `.flue/lib/machine.ts` is the single source of truth; these
// functions project it into the committed `machine.json` runtime artifact and
// the `BOT_STATE_MACHINE.md` docs. `scripts/generate-machine.ts` writes them to
// disk and `tests/unit/machine-artifacts.test.ts` fails if the committed files
// drift from what these produce.
//
// Imports use the explicit `.ts` extension so `node scripts/generate-machine.ts`
// can run the chain without a bundler; `allowImportingTsExtensions` keeps tsc
// happy when the drift test pulls this module into the program.

import {
	ENTRY_STATE,
	EVENTS,
	KINDS,
	machineSnapshot,
	STATES,
	TRANSITIONS,
	transitionTargets,
} from "../.flue/lib/machine.ts";

export function renderMachineJson(): string {
	return `${JSON.stringify(machineSnapshot(), null, "\t")}\n`;
}

function code(value: string): string {
	return `\`${value}\``;
}

function commandList(commands: readonly string[]): string {
	return commands.length === 0 ? "—" : commands.map(code).join(", ");
}

function eventCategory(id: string): string {
	if (id.startsWith("agent.")) return "agent result";
	if (id.startsWith("pr.")) return "pr lifecycle";
	if (id.startsWith("preview.")) return "preview";
	if (id === "expire") return "timer";
	return "command";
}

function statesTable(): string {
	const rows = Object.entries(STATES).map(
		([id, meta]) =>
			`| ${code(id)} | ${meta.label ? code(meta.label) : "—"} | ${meta.boardColumn} | ${
				meta.terminal ? "yes" : "no"
			} | ${meta.transient ? "yes" : "no"} | ${commandList(meta.offeredCommands)} |`,
	);
	return [
		"## States",
		"",
		"| State | Label | Board column | Terminal | Transient | Offered commands |",
		"| --- | --- | --- | --- | --- | --- |",
		...rows,
	].join("\n");
}

function eventsTable(): string {
	const rows = Object.entries(EVENTS).map(
		([id, meta]) =>
			`| ${code(id)} | ${eventCategory(id)} | ${meta.actors.join(", ")} | ${
				meta.arg ? code(meta.arg) : "—"
			} | ${meta.description} |`,
	);
	return [
		"## Events",
		"",
		"| Event | Category | Actors | Arg | Description |",
		"| --- | --- | --- | --- | --- |",
		...rows,
	].join("\n");
}

function transitionsTable(): string {
	const rows = TRANSITIONS.map(
		(t) =>
			`| ${code(t.from)} | ${code(t.event)} | ${transitionDestination(t)} | ${t.action ? code(t.action) : "—"} |`,
	);
	return [
		"## Transitions",
		"",
		"| From | Event | To | Action |",
		"| --- | --- | --- | --- |",
		...rows,
	].join("\n");
}

function transitionDestination(transition: (typeof TRANSITIONS)[number]): string {
	const overrides = Object.entries(transition.toByKind ?? {});
	if (overrides.length === 0) return code(transition.to);
	return [
		`default: ${code(transition.to)}`,
		...overrides.map(([kind, target]) => `${code(kind)}: ${code(target)}`),
	].join("; ");
}

function diagram(): string {
	const edges = TRANSITIONS.flatMap((transition) =>
		transitionTargets(transition).map((target) => {
			const kinds = Object.entries(transition.toByKind ?? {})
				.filter(([, kindTarget]) => kindTarget === target)
				.map(([kind]) => kind);
			const qualifier =
				target === transition.to
					? transition.toByKind
						? " [default]"
						: ""
					: ` [${kinds.join(", ")}]`;
			return `    ${transition.from} --> ${target}: ${transition.event}${qualifier}${transition.action ? ` / ${transition.action}` : ""}`;
		}),
	);
	return [
		"## Diagram",
		"",
		"```mermaid",
		"stateDiagram-v2",
		`    [*] --> ${ENTRY_STATE}`,
		...edges,
		"```",
	].join("\n");
}

export function renderMachineDoc(): string {
	const kinds = KINDS.map(code).join(", ");
	return `${[
		"# emdashbot state machine",
		"",
		"<!-- Generated from .flue/lib/machine.ts by `pnpm bot:generate`. Do not edit by hand. -->",
		"",
		`Entry state: ${code(ENTRY_STATE)}. Kinds: ${kinds}.`,
		"",
		statesTable(),
		"",
		eventsTable(),
		"",
		transitionsTable(),
		"",
		diagram(),
	].join("\n")}\n`;
}
