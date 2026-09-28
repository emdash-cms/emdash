/**
 * emdash site
 *
 * Export a whole site to a portable `.emdash` package, and import one into an
 * empty site.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { defineCommand } from "citty";
import { consola } from "consola";

import type { SiteImportPlan, TransferOperation } from "../../client/index.js";
import { connectionArgs, createClientFromArgs, resolveBaseUrl } from "../client-factory.js";
import { configureOutputMode, output } from "../output.js";
import { runSiteExport } from "../site/export.js";
import {
	abandonImport,
	analyzePackage,
	cancelImport,
	confirmPackage,
	importReceipt,
	importStatus,
	isExecuting,
	normalizePlanDigest,
	resumeImport,
	type AnalyzeOutcome,
	type CompletedImport,
	type DecisionFlags,
} from "../site/import.js";
import {
	describeError,
	formatBytes,
	formatProgress,
	SiteTransferCliError,
	transformationLabel,
	type TransferRuntime,
} from "../site/shared.js";

/** Exit status when analysis produced a plan with blockers. */
export const EXIT_PLAN_BLOCKED = 2;

const IMPORT_ACTIONS = new Set(["status", "resume", "receipt", "cancel", "abandon"]);

/** Import states `import status` reports with exit status 1. */
const UNSUCCESSFUL_STATES = new Set(["failed", "cancelled", "abandoned", "expired"]);

interface OutputArgs {
	json?: boolean;
}

function wantsJson(args: OutputArgs): boolean {
	return Boolean(args.json) || !process.stdout.isTTY;
}

function runtimeFor(): TransferRuntime {
	const progress = consola.create({ stdout: process.stderr, stderr: process.stderr });
	return {
		reporter: {
			info: (message) => progress.info(message),
			warn: (message) => progress.warn(message),
		},
	};
}

async function confirmOnTerminal(question: string): Promise<boolean> {
	const prompt = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		prompt.close();
	}
}

/**
 * Ask before a cancel or abandon unless `--yes` or JSON output was chosen.
 * Without a terminal to ask on, the command needs `--yes`.
 */
async function confirmed(
	args: OutputArgs & { yes?: boolean },
	action: string,
	operationId: string,
	question: string,
): Promise<boolean> {
	if (args.yes || wantsJson(args)) return true;
	if (!process.stdin.isTTY) {
		throw new SiteTransferCliError(
			"INVALID_ARGUMENT",
			`Pass --yes to ${action} import ${operationId} without a confirmation prompt`,
		);
	}
	return confirmOnTerminal(question);
}

function fail(error: unknown, args: OutputArgs): void {
	const info = describeError(error);
	if (wantsJson(args)) {
		output({ error: info }, args);
	} else {
		consola.error(info.message);
	}
	process.exitCode = 1;
}

/** Every value of a repeatable string flag, from the raw arguments. */
export function collectFlag(rawArgs: readonly string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === `--${name}`) {
			const next = rawArgs[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				values.push(next);
				i++;
			} else {
				throw new SiteTransferCliError("INVALID_ARGUMENT", `--${name} needs a value`);
			}
		} else if (arg.startsWith(`--${name}=`)) {
			values.push(arg.slice(name.length + 3));
		}
	}
	return values;
}

// ── Output shapes ──────────────────────────────────────────────

export function planJson(outcome: AnalyzeOutcome) {
	return {
		operationId: outcome.operation.id,
		state: outcome.operation.state,
		packageDigest: outcome.packageDigest,
		planDigest: outcome.planDigest,
		executable: outcome.plan.blockers.length === 0,
		plan: outcome.plan,
	};
}

export function operationJson(operation: TransferOperation) {
	return { operationId: operation.id, state: operation.state, operation };
}

function printPlan(outcome: AnalyzeOutcome, archivePath: string | null): void {
	const { plan } = outcome;
	consola.log(`Import ${outcome.operation.id}`);
	consola.log(`  Package digest: ${outcome.packageDigest}`);
	consola.log(`  Plan digest:    ${outcome.planDigest}`);
	consola.log(
		`  Origin:         site ${plan.origin.siteId}, exported ${plan.origin.createdAt} by EmDash ${plan.origin.createdByEmDashVersion}`,
	);
	const counts = Object.entries(plan.counts)
		.map(([kind, count]) => `${kind} ${count}`)
		.join(", ");
	consola.log(`  Records:        ${counts || "none"}`);
	consola.log(
		`  Size:           records ${formatBytes(plan.bytes.records)}, media ${formatBytes(plan.bytes.media)}`,
	);
	printSetting("Site title", plan.settings.title, plan.decisions.siteTitle);
	printSetting("Tagline", plan.settings.tagline, plan.decisions.siteTagline);

	if (plan.principals.length > 0) {
		consola.log("  Principals (package users; map them with --map-principal <id>=<user|none>):");
		for (const principal of plan.principals) {
			const mapped = plan.decisions.principalMappings[principal.id];
			const target = mapped ? `user ${mapped}` : "unassigned";
			const suggested =
				principal.suggestedUserId && principal.suggestedUserId !== mapped
					? `, suggested user ${principal.suggestedUserId}`
					: "";
			const email = principal.email ? ` <${principal.email}>` : "";
			consola.log(
				`    ${principal.id}  ${principal.displayName}${email}, ${principal.references} references -> ${target}${suggested}`,
			);
		}
	}
	printTransformations(plan.transformations);
	printIssues("Warnings", plan.warnings);
	printIssues("Blockers", plan.blockers);

	if (plan.blockers.length > 0) {
		consola.error(`The plan has ${plan.blockers.length} blocker(s); it cannot be executed.`);
		return;
	}
	const file = archivePath ?? "<file>";
	consola.success(
		`Ready. To import, run:\n  emdash site import ${file} --plan ${outcome.planDigest} --confirm`,
	);
}

function printSetting(
	label: string,
	values: SiteImportPlan["settings"]["title"],
	choice: "package" | "target",
): void {
	const value = choice === "package" ? values.package : values.target;
	consola.log(
		`  ${`${label}:`.padEnd(16)}${JSON.stringify(value ?? "")} (from the ${choice}; package ${JSON.stringify(values.package ?? "")}, this site ${JSON.stringify(values.target ?? "")})`,
	);
}

/** Every declared difference from the source site, one line per code. */
function printTransformations(transformations: SiteImportPlan["transformations"]): void {
	const groups = new Map<string, { count: number; kinds: Set<string>; details: string[] }>();
	for (const transformation of transformations) {
		const group = groups.get(transformation.code) ?? {
			count: 0,
			kinds: new Set<string>(),
			details: [],
		};
		if ("count" in transformation) group.count += transformation.count;
		else if ("ids" in transformation) group.count += transformation.ids.length;
		else group.count += transformation.locales.length;
		if ("kind" in transformation) group.kinds.add(transformation.kind);
		if ("locales" in transformation) {
			for (const { from, to } of transformation.locales) group.details.push(`${from} -> ${to}`);
		}
		if ("items" in transformation) {
			const types = new Map<string, number>();
			for (const item of transformation.items)
				types.set(item.type, (types.get(item.type) ?? 0) + 1);
			group.details.push(Array.from(types, ([type, count]) => `${type} ${count}`).join(", "));
		}
		groups.set(transformation.code, group);
	}
	if (groups.size === 0) return;
	consola.log(`  Differences from the source site (${groups.size}):`);
	for (const [code, group] of groups) {
		const kinds = group.kinds.size > 0 ? ` [${[...group.kinds].join(", ")}]` : "";
		consola.log(`    ${code}${kinds} x${group.count}: ${transformationLabel(code)}`);
		for (const detail of group.details) consola.log(`      ${detail}`);
	}
}

function printIssues(
	label: string,
	issues: ReadonlyArray<{ code: string; message: string; kind?: string; count?: number }>,
): void {
	if (issues.length === 0) return;
	consola.log(`  ${label} (${issues.length}):`);
	for (const issue of issues) {
		const where = issue.kind ? ` [${issue.kind}]` : "";
		const count = issue.count !== undefined ? ` x${issue.count}` : "";
		consola.log(`    ${issue.code}${where}${count}: ${issue.message}`);
	}
}

function printReceipt(result: CompletedImport): void {
	const { receipt } = result;
	consola.success(`Import ${result.operationId} is complete and verified.`);
	consola.log(
		`  Receipt digest: ${receipt.receiptDigest}${result.receiptDigestValid ? "" : " (INVALID)"}`,
	);
	consola.log(`  Package digest: ${receipt.packageDigest}`);
	consola.log(`  Plan digest:    ${receipt.planDigest}`);
	consola.log(`  Logical digest: ${receipt.logicalDigest}`);
	consola.log(`  Completed:      ${receipt.completedAt}`);
	const counts = Object.entries(receipt.counts)
		.map(([kind, count]) => `${kind} ${count}`)
		.join(", ");
	consola.log(`  Counts:         ${counts || "none"}`);
	for (const warning of receipt.warnings) consola.warn(`${warning.code}: ${warning.message}`);
}

function printOperation(
	operation: TransferOperation,
	files?: { declared: number; verified: number },
): void {
	consola.log(
		`Import ${operation.id}: ${operation.state}${operation.stage ? ` (${operation.stage})` : ""}`,
	);
	const progress = formatProgress(operation.progress);
	if (progress) consola.log(`  Progress:       ${progress}`);
	if (files)
		consola.log(`  Files:          ${files.verified} uploaded, ${files.declared} still missing`);
	if (operation.packageDigest) consola.log(`  Package digest: ${operation.packageDigest}`);
	if (operation.planDigest) consola.log(`  Plan digest:    ${operation.planDigest}`);
	if (operation.errorCode) {
		consola.warn(
			`  Error:          ${operation.errorCode}${operation.errorDetail ? ` ${JSON.stringify(operation.errorDetail)}` : ""}`,
		);
	}
	if (blocksWritesUntilAbandoned(operation)) {
		consola.info(
			`It wrote to this site before it stopped, so site writes stay blocked until you abandon it: emdash site import abandon ${operation.id}`,
		);
	}
}

function blocksWritesUntilAbandoned(operation: TransferOperation): boolean {
	return (
		operation.mutationStartedAt !== null &&
		(operation.state === "failed" || operation.state === "cancelled")
	);
}

function printCancelled(operation: TransferOperation): void {
	if (operation.state !== "cancelled") {
		consola.success(
			`Cancellation requested. Import ${operation.id} stops after its current batch; check it with: emdash site import status ${operation.id}`,
		);
		return;
	}
	consola.success(`Import ${operation.id} is cancelled.`);
	if (blocksWritesUntilAbandoned(operation)) {
		consola.info(
			`It had started writing to this site. The data it wrote stays, and site writes stay blocked until you abandon it: emdash site import abandon ${operation.id}`,
		);
	} else {
		consola.info("It had not written anything to this site.");
	}
}

function printAbandoned(operation: TransferOperation): void {
	consola.success(`Import ${operation.id} is abandoned. The site accepts writes again.`);
	if (operation.mutationStartedAt !== null) {
		consola.info(
			"Data the import already wrote was not removed. Reset this site or set up a new one before importing again.",
		);
	}
}

/** Print whatever an import command ended with and set the exit status. */
function report(
	outcome: AnalyzeOutcome | CompletedImport | { operation: TransferOperation },
	args: OutputArgs,
	archivePath: string | null,
): void {
	if ("receipt" in outcome) {
		if (wantsJson(args)) output(outcome, args);
		else printReceipt(outcome);
		if (!outcome.receiptDigestValid) process.exitCode = 1;
		return;
	}
	if ("plan" in outcome) {
		if (wantsJson(args)) output(planJson(outcome), args);
		else printPlan(outcome, archivePath);
		if (outcome.plan.blockers.length > 0) process.exitCode = EXIT_PLAN_BLOCKED;
		return;
	}
	if (wantsJson(args)) {
		output(operationJson(outcome.operation), args);
	} else {
		printOperation(outcome.operation);
		if (isExecuting(outcome.operation)) {
			consola.info(`Continue it with: emdash site import resume ${outcome.operation.id}`);
		}
	}
	if (!isExecuting(outcome.operation)) process.exitCode = 1;
}

// ── Commands ───────────────────────────────────────────────────

const exportCommand = defineCommand({
	meta: {
		name: "export",
		description: "Export the whole site to a .emdash package file",
	},
	args: {
		...connectionArgs,
		output: {
			type: "string",
			alias: "o",
			description: "Package file to write (e.g. site.emdash)",
			required: true,
		},
		comments: {
			type: "boolean",
			default: true,
			description: "Include comments and reactions (--no-comments leaves them out)",
		},
	},
	async run({ args }) {
		configureOutputMode(args);
		try {
			const client = createClientFromArgs(args);
			const result = await runSiteExport(
				{
					client,
					baseUrl: resolveBaseUrl(args),
					outputPath: resolve(args.output),
					comments: args.comments !== false,
				},
				runtimeFor(),
			);
			if (wantsJson(args)) {
				output(result, args);
			} else {
				consola.success(
					`Exported ${result.files} files (${formatBytes(result.bytes)}) to ${result.output}`,
				);
				consola.log(`  Package digest: ${result.packageDigest}`);
			}
		} catch (error) {
			fail(error, args);
		}
	},
});

const importCommand = defineCommand({
	meta: {
		name: "import",
		description: [
			"Import a .emdash package into an empty site: `import <file> --analyze`, then `import <file> --plan <digest> --confirm`.",
			"Manage an import with `import status|resume|receipt|cancel|abandon <operation-id>`. `cancel` stops the import after its current batch. `abandon` lifts the write block that a failed or cancelled import leaves on the site; it does not delete what the import wrote.",
			"Exit codes: 0 success, and for `status` an import in progress or complete; 1 an error, a declined prompt, or for `status` an import that failed, was cancelled or abandoned, or expired; 2 the import plan has blockers.",
		].join("\n\n"),
	},
	args: {
		target: {
			type: "positional",
			description: "Package file, or status | resume | receipt | cancel | abandon",
			required: true,
		},
		...connectionArgs,
		analyze: {
			type: "boolean",
			description: "Upload and analyze the package, then print the import plan",
		},
		"map-principal": {
			type: "string",
			description:
				"With --analyze: map a package user to a site user, <principal id|email>=<user id|email|none> (repeatable)",
		},
		"use-target-title": {
			type: "boolean",
			description: "With --analyze: keep this site's title instead of the package's",
		},
		"use-target-tagline": {
			type: "boolean",
			description: "With --analyze: keep this site's tagline instead of the package's",
		},
		plan: {
			type: "string",
			description: "Plan digest printed by --analyze; required with --confirm",
		},
		confirm: {
			type: "boolean",
			description: "Execute the import plan given by --plan",
		},
		yes: {
			type: "boolean",
			alias: "y",
			description: "With cancel or abandon: skip the confirmation prompt",
		},
	},
	async run({ args, rawArgs }) {
		configureOutputMode(args);
		try {
			const positionals = args._.map(String);
			const action = IMPORT_ACTIONS.has(args.target) ? args.target : null;
			const client = createClientFromArgs(args);
			const runtime = runtimeFor();

			if (action) {
				const operationId = positionals[1];
				if (!operationId) {
					throw new SiteTransferCliError(
						"INVALID_ARGUMENT",
						`Usage: emdash site import ${action} <operation-id>`,
					);
				}
				if (action === "status") {
					const status = await importStatus(client, operationId, runtime);
					if (wantsJson(args)) output(status, args);
					else printOperation(status.operation, status.files);
					if (UNSUCCESSFUL_STATES.has(status.operation.state)) process.exitCode = 1;
					return;
				}
				if (action === "cancel" || action === "abandon") {
					const question =
						action === "cancel"
							? `Cancel import ${operationId}? A running import stops after its current batch. Anything it already wrote stays on the site.`
							: `Abandon import ${operationId}? Site writes are unblocked, but data the import already wrote is not deleted.`;
					if (!(await confirmed(args, action, operationId, question))) {
						consola.info("Nothing was changed.");
						process.exitCode = 1;
						return;
					}
					const operation =
						action === "cancel"
							? await cancelImport(client, operationId, runtime)
							: await abandonImport(client, operationId, runtime);
					if (wantsJson(args)) output(operationJson(operation), args);
					else if (action === "cancel") printCancelled(operation);
					else printAbandoned(operation);
					return;
				}
				if (action === "receipt") {
					report(await importReceipt(client, operationId, runtime), args, null);
					return;
				}
				const archive = positionals[2] ? resolve(positionals[2]) : null;
				report(await resumeImport(client, operationId, archive, runtime), args, archive);
				return;
			}

			const archivePath = resolve(args.target);
			const mapPrincipal = collectFlag(rawArgs, "map-principal");
			const flags: DecisionFlags = {
				mapPrincipal,
				useTargetTitle: Boolean(args["use-target-title"]),
				useTargetTagline: Boolean(args["use-target-tagline"]),
			};
			if (args.confirm && !args.plan) {
				throw new SiteTransferCliError(
					"INVALID_ARGUMENT",
					"--confirm needs --plan <digest>: review the plan with --analyze first",
				);
			}
			if (args.plan && !args.confirm) {
				throw new SiteTransferCliError(
					"INVALID_ARGUMENT",
					"--plan executes an import only together with --confirm",
				);
			}
			if (args.plan && args.analyze) {
				throw new SiteTransferCliError(
					"INVALID_ARGUMENT",
					"Use either --analyze or --plan <digest> --confirm, not both",
				);
			}
			if (args.plan) {
				if (mapPrincipal.length > 0 || flags.useTargetTitle || flags.useTargetTagline) {
					throw new SiteTransferCliError(
						"INVALID_ARGUMENT",
						"Decisions can only be changed with --analyze; they change the plan digest",
					);
				}
				const planDigest = normalizePlanDigest(args.plan);
				report(await confirmPackage(client, archivePath, planDigest, runtime), args, archivePath);
				return;
			}
			if (!args.analyze) {
				throw new SiteTransferCliError(
					"INVALID_ARGUMENT",
					"Choose --analyze to review the import plan, or --plan <digest> --confirm to run it",
				);
			}
			report(await analyzePackage(client, archivePath, flags, runtime), args, archivePath);
		} catch (error) {
			fail(error, args);
		}
	},
});

export const siteCommand = defineCommand({
	meta: {
		name: "site",
		description: "Export or import a whole site as a .emdash package",
	},
	subCommands: {
		export: exportCommand,
		import: importCommand,
	},
});
