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
	ISSUE_PHASES,
	KINDS,
	machineSnapshot,
	runMachineSnapshot,
	STATES,
	TRANSITIONS,
	transitionTargets,
} from "../.flue/lib/machine.ts";

export function renderMachineJson(): string {
	return `${JSON.stringify({ ...machineSnapshot(), run: runMachineSnapshot() }, null, "\t")}\n`;
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
			`| ${code(id)} | ${code(meta.phase)} | ${meta.label ? code(meta.label) : "—"} | ${meta.boardColumn} | ${
				meta.terminal ? "yes" : "no"
			} | ${meta.transient ? "yes" : "no"} | ${commandList(meta.offeredCommands)} |`,
	);
	return [
		"### States",
		"",
		"| State | Phase | Label | Board column | Terminal | Transient | Offered commands |",
		"| --- | --- | --- | --- | --- | --- | --- |",
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
		"### Events",
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
		"### Transitions",
		"",
		"| From | Event | To | Action |",
		"| --- | --- | --- | --- |",
		...rows,
	].join("\n");
}

function transitionDestination(transition: (typeof TRANSITIONS)[number]): string {
	if (transition.event === "resume") {
		return `saved: ${code("working")}, ${code("investigating")}, or ${code("fixing")}`;
	}
	const overrides = Object.entries(transition.toByKind ?? {});
	if (overrides.length === 0) return code(transition.to);
	return [
		`default: ${code(transition.to)}`,
		...overrides.map(([kind, target]) => `${code(kind)}: ${code(target)}`),
	].join("; ");
}

function diagram(): string {
	const edges = TRANSITIONS.flatMap((transition) =>
		(transition.event === "resume"
			? (["working", "investigating", "fixing"] as const)
			: transitionTargets(transition)
		).map((target) => {
			const kinds = Object.entries(transition.toByKind ?? {})
				.filter(([, kindTarget]) => kindTarget === target)
				.map(([kind]) => kind);
			const qualifier =
				target === transition.to
					? transition.toByKind
						? " [default]"
						: ""
					: ` [${kinds.join(", ")}]`;
			return `    ${transition.from} --> ${target}: ${transition.event}${transition.event === "resume" ? " [saved]" : qualifier}${transition.action ? ` / ${transition.action}` : ""}`;
		}),
	);
	return [
		"### Diagram",
		"",
		"```mermaid",
		"stateDiagram-v2",
		`    [*] --> ${ENTRY_STATE}`,
		...edges,
		"```",
	].join("\n");
}

function issuePhasesTable(): string {
	return [
		"### Phases",
		"",
		"| Phase | Label |",
		"| --- | --- |",
		...ISSUE_PHASES.map((phase) => `| ${code(phase.id)} | ${phase.label} |`),
	].join("\n");
}

function runLifecycle(): string {
	const run = runMachineSnapshot();
	const planRows = Object.entries(run.plans).map(
		([mode, phases]) => `| ${code(mode)} | ${phases.map(code).join(" → ")} |`,
	);
	const edges = new Map<string, string[]>();
	for (const [mode, phases] of Object.entries(run.plans)) {
		for (let index = 0; index < phases.length - 1; index += 1) {
			const from = phases[index];
			const to = phases[index + 1];
			if (!from || !to) continue;
			const key = `${from} --> ${to}`;
			edges.set(key, [...(edges.get(key) ?? []), mode]);
		}
	}
	return [
		"## Agent run lifecycle",
		"",
		"A run stores its mode, selected phase plan, current phase, status, attempt, and fixed deadline independently from the issue state. An explicit `implement` directive selects the direct implementation plan and omits reproduction and diagnosis.",
		"",
		"### Phases",
		"",
		"| Phase | Label |",
		"| --- | --- |",
		...run.phases.map((phase) => `| ${code(phase.id)} | ${phase.label} |`),
		"",
		"### Plans",
		"",
		"| Mode | Ordered phases |",
		"| --- | --- |",
		...planRows,
		"",
		"### Task-specific work plan",
		"",
		"Each agent run creates a bounded work plan for its specific directive through `update_work_plan`. The plan is independent from the run phase plan: it may describe arbitrary repository work, while the run phases track deadlines and publication.",
		"",
		"The Orchestrator stores the plan and projects it into one evolving GitHub comment for that run and into the dashboard. Resume updates the same run comment. A fresh retry or directive creates a new run comment. The final agent result updates the same comment; `Completed` is used only when the mode's trusted outcome succeeds.",
		"",
		"### Statuses",
		"",
		run.statuses.map(code).join(", "),
		"",
		"### Diagram",
		"",
		"```mermaid",
		"stateDiagram-v2",
		"    [*] --> prepare",
		...Array.from(edges.entries(), ([edge, modes]) => `    ${edge}: ${modes.join(", ")}`),
		"    report --> [*]",
		"```",
	].join("\n");
}

export function renderMachineDoc(): string {
	const kinds = KINDS.map(code).join(", ");
	return `${[
		"# emdashbot lifecycle machines",
		"",
		"<!-- Generated from .flue/lib/machine.ts by `pnpm bot:generate`. Do not edit by hand. -->",
		"",
		"The issue lifecycle coordinates the long-lived GitHub item. The agent run lifecycle records one bounded execution attempt. GitHub labels project the issue state; run mode and phase remain in Durable Object storage.",
		"",
		"## Issue lifecycle",
		"",
		`Entry state: ${code(ENTRY_STATE)}. Kinds: ${kinds}.`,
		"",
		issuePhasesTable(),
		"",
		statesTable(),
		"",
		eventsTable(),
		"",
		transitionsTable(),
		"",
		diagram(),
		"",
		runLifecycle(),
	].join("\n")}\n`;
}
