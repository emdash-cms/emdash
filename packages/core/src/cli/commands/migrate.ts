import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { defineCommand } from "citty";

import { buildMigrationManifestFromConfig } from "../../migrations/config-loader.js";
import type { CoreMigrationIdentity } from "../../migrations/identity.js";
import type { MigrationManifestV1 } from "../../migrations/manifest.js";
import {
	MigrationManifestValidationError,
	validateMigrationManifest,
} from "../../migrations/manifest.js";
import type {
	MigrationExecutor,
	MigrationExecutorFactory,
	MigrationReport,
	MigrationTarget,
	MigrationTargetOverrides,
} from "../../migrations/protocol.js";

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_TARGET_KIND_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SAFE_MIGRATION_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const CREDENTIAL_URL_PATTERN = /:\/\/[^/\s]+@/;
const CREDENTIAL_QUERY_PATTERN = /[?&](?:auth|credential|key|password|secret|signature|token)=/i;

export const MIGRATE_EXIT_CODES = Object.freeze({
	success: 0,
	error: 1,
	pending: 2,
	unknownApplied: 3,
	confirmation: 4,
	interrupted: 130,
} as const);

export type MigrationSignal = "SIGINT" | "SIGTERM";

export interface MigrateCommandOptions extends MigrationTargetOverrides {
	manifest?: string;
	fromConfig?: boolean;
	config?: string;
	check?: boolean;
	status?: boolean;
	json?: boolean;
	expectedTargetFingerprint?: string;
}

export interface MigrateCommandDependencies {
	cwd: string;
	env: Readonly<Record<string, string | undefined>>;
	interactive: boolean;
	findProjectRoot: (start: string) => Promise<string>;
	readManifest: (path: string, isDefault: boolean) => Promise<unknown>;
	buildManifestFromConfig: (projectRoot: string, configFile?: string) => Promise<unknown>;
	loadProjectIdentity: (projectRoot: string) => Promise<CoreMigrationIdentity>;
	loadProjectExecutor: (
		projectRoot: string,
		entrypoint: string,
	) => Promise<MigrationExecutorFactory>;
	confirm: (message: string) => Promise<boolean>;
	writeStdout: (value: string) => void;
	writeStderr: (value: string) => void;
	onSignal: (signal: MigrationSignal, handler: () => Promise<void>) => () => void;
	cleanupTimeoutMs: number;
}

class MigrateCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MigrateCommandError";
	}
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moduleExport(module: unknown, name: string): unknown {
	if (!isRecord(module)) return undefined;
	const direct = Reflect.get(module, name);
	if (direct !== undefined) return direct;
	const defaultExport = Reflect.get(module, "default");
	return isRecord(defaultExport) ? Reflect.get(defaultExport, name) : undefined;
}

async function importProjectModule(projectRoot: string, specifier: string): Promise<unknown> {
	let resolvedEntrypoint: string;
	try {
		resolvedEntrypoint = createRequire(resolve(projectRoot, "package.json")).resolve(specifier);
	} catch {
		throw new MigrateCommandError(`Could not resolve ${specifier} from the project.`);
	}
	return import(pathToFileURL(resolvedEntrypoint).href);
}

function validateIdentity(value: unknown): CoreMigrationIdentity {
	if (
		!isRecord(value) ||
		typeof value.emdashVersion !== "string" ||
		!Array.isArray(value.names) ||
		!value.names.every((name) => typeof name === "string") ||
		typeof value.fingerprint !== "string" ||
		!FINGERPRINT_PATTERN.test(value.fingerprint)
	) {
		throw new MigrateCommandError(
			"The project-local emdash/migrations module returned an invalid migration identity.",
		);
	}
	return {
		emdashVersion: value.emdashVersion,
		names: [...value.names],
		fingerprint: value.fingerprint,
	};
}

export async function loadProjectMigrationIdentity(
	projectRoot: string,
): Promise<CoreMigrationIdentity> {
	const loaded = await importProjectModule(projectRoot, "emdash/migrations");
	const getIdentity = moduleExport(loaded, "getCoreMigrationIdentity");
	if (typeof getIdentity !== "function") {
		throw new MigrateCommandError(
			"The project-local emdash/migrations module does not export getCoreMigrationIdentity.",
		);
	}
	return validateIdentity(await Reflect.apply(getIdentity, undefined, []));
}

export async function loadProjectMigrationExecutor(
	projectRoot: string,
	entrypoint: string,
): Promise<MigrationExecutorFactory> {
	const loaded = await importProjectModule(projectRoot, entrypoint);
	const factory = moduleExport(loaded, "createMigrationExecutor");
	if (typeof factory !== "function") {
		throw new MigrateCommandError(
			`The project-local ${entrypoint} module does not export createMigrationExecutor.`,
		);
	}
	return (manifestConfig, context) => Reflect.apply(factory, undefined, [manifestConfig, context]);
}

async function findProjectRoot(start: string): Promise<string> {
	let current = resolve(start);
	const filesystemRoot = parse(current).root;
	for (;;) {
		try {
			await readFile(resolve(current, "package.json"), "utf8");
			return current;
		} catch (error) {
			if (isRecord(error) && error.code !== "ENOENT" && error.code !== "ENOTDIR") {
				throw new MigrateCommandError("Could not read the project package.json.");
			}
		}
		if (current === filesystemRoot) break;
		current = dirname(current);
	}
	throw new MigrateCommandError("Could not find a project root containing package.json.");
}

export async function readMigrationManifestFile(
	path: string,
	isDefault: boolean,
): Promise<unknown> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if (isDefault && isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			throw new MigrateCommandError(
				`No migration manifest found at ${path}. Build the project or use --from-config.`,
			);
		}
		throw new MigrateCommandError(`Could not read migration manifest: ${path}`);
	}
	try {
		return JSON.parse(source);
	} catch {
		throw new MigrateCommandError(`Migration manifest is not valid JSON: ${path}`);
	}
}

async function confirmWithReadline(message: string): Promise<boolean> {
	const prompt = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await prompt.question(`${message} [y/N] `);
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} finally {
		prompt.close();
	}
}

function onProcessSignal(signal: MigrationSignal, handler: () => Promise<void>): () => void {
	const listener = () => {
		void handler().finally(() => process.exit(MIGRATE_EXIT_CODES.interrupted));
	};
	process.once(signal, listener);
	return () => process.removeListener(signal, listener);
}

const defaultDependencies: MigrateCommandDependencies = {
	cwd: process.cwd(),
	env: process.env,
	interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
	findProjectRoot,
	readManifest: readMigrationManifestFile,
	buildManifestFromConfig: (projectRoot, configFile) =>
		buildMigrationManifestFromConfig({ projectRoot, configFile }),
	loadProjectIdentity: loadProjectMigrationIdentity,
	loadProjectExecutor: loadProjectMigrationExecutor,
	confirm: confirmWithReadline,
	writeStdout: (value) => process.stdout.write(`${value}\n`),
	writeStderr: (value) => process.stderr.write(`${value}\n`),
	onSignal: onProcessSignal,
	cleanupTimeoutMs: 2_000,
};

function validateOptions(options: MigrateCommandOptions): void {
	if (options.manifest && options.fromConfig) {
		throw new MigrateCommandError("--manifest and --from-config cannot be used together.");
	}
	if (options.config && !options.fromConfig) {
		throw new MigrateCommandError("--config requires --from-config.");
	}
	if (options.check && options.status) {
		throw new MigrateCommandError("--check and --status cannot be used together.");
	}
	if (
		options.expectedTargetFingerprint &&
		!FINGERPRINT_PATTERN.test(options.expectedTargetFingerprint)
	) {
		throw new MigrateCommandError("--expected-target-fingerprint must be a SHA-256 fingerprint.");
	}
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function targetField(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		hasControlCharacter(value) ||
		CREDENTIAL_URL_PATTERN.test(value) ||
		CREDENTIAL_QUERY_PATTERN.test(value)
	) {
		throw new MigrateCommandError(`The executor returned an unsafe migration target ${name}.`);
	}
	return value;
}

function immutableTarget(value: unknown): Readonly<MigrationTarget> {
	if (!isRecord(value)) {
		throw new MigrateCommandError("The executor returned an invalid migration target.");
	}
	const kind = targetField(value.kind, "kind");
	const label = targetField(value.label, "label");
	const fingerprint = targetField(value.fingerprint, "fingerprint");
	if (
		!kind ||
		!SAFE_TARGET_KIND_PATTERN.test(kind) ||
		!label ||
		!fingerprint ||
		!FINGERPRINT_PATTERN.test(fingerprint)
	) {
		throw new MigrateCommandError("The executor returned an invalid migration target.");
	}
	const target: MigrationTarget = { kind, label, fingerprint };
	const accountId = targetField(value.accountId, "accountId");
	const environment = targetField(value.environment, "environment");
	const resourceId = targetField(value.resourceId, "resourceId");
	if (accountId) target.accountId = accountId;
	if (environment) target.environment = environment;
	if (resourceId) target.resourceId = resourceId;
	return Object.freeze(target);
}

function safeMigrationNames(value: unknown, field: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((name) => typeof name === "string" && SAFE_MIGRATION_NAME_PATTERN.test(name))
	) {
		throw new MigrateCommandError(`The migration executor returned an invalid ${field} report.`);
	}
	return [...value];
}

function safeReport(value: unknown, target: Readonly<MigrationTarget>): MigrationReport {
	if (!isRecord(value)) {
		throw new MigrateCommandError("The migration executor returned an invalid report.");
	}
	const reportTarget = immutableTarget(value.target);
	if (
		reportTarget.kind !== target.kind ||
		reportTarget.label !== target.label ||
		reportTarget.fingerprint !== target.fingerprint ||
		reportTarget.accountId !== target.accountId ||
		reportTarget.environment !== target.environment ||
		reportTarget.resourceId !== target.resourceId
	) {
		throw new MigrateCommandError(
			"The migration executor report target does not match the confirmed target.",
		);
	}
	return {
		target: { ...reportTarget },
		knownApplied: safeMigrationNames(value.knownApplied, "knownApplied"),
		pending: safeMigrationNames(value.pending, "pending"),
		unknownApplied: safeMigrationNames(value.unknownApplied, "unknownApplied"),
		executed: safeMigrationNames(value.executed, "executed"),
	};
}

function printTarget(target: Readonly<MigrationTarget>, write: (value: string) => void): void {
	write(`Migration target: ${target.kind} ${target.label}`);
	if (target.accountId) write(`Account: ${target.accountId}`);
	if (target.environment) write(`Environment: ${target.environment}`);
	if (target.resourceId) write(`Resource: ${target.resourceId}`);
	write(`Target fingerprint: ${target.fingerprint}`);
}

function printNameSet(
	label: string,
	names: readonly string[],
	write: (value: string) => void,
): void {
	write(`${label}: ${names.length === 0 ? "none" : names.join(", ")}`);
}

function printHumanReport(report: MigrationReport, write: (value: string) => void): void {
	printNameSet("Known applied", report.knownApplied, write);
	printNameSet("Pending", report.pending, write);
	printNameSet("Unknown applied", report.unknownApplied, write);
	printNameSet("Executed", report.executed, write);
}

function reportExitCode(options: MigrateCommandOptions, report: MigrationReport): number {
	if (!options.check) return MIGRATE_EXIT_CODES.success;
	if (report.unknownApplied.length > 0) return MIGRATE_EXIT_CODES.unknownApplied;
	if (report.pending.length > 0) return MIGRATE_EXIT_CODES.pending;
	return MIGRATE_EXIT_CODES.success;
}

function createOverrides(options: MigrateCommandOptions): MigrationTargetOverrides {
	return {
		database: options.database,
		databaseUrlEnv: options.databaseUrlEnv,
		d1: options.d1,
		accountId: options.accountId,
		wranglerConfig: options.wranglerConfig,
		wranglerEnv: options.wranglerEnv,
	};
}

function bounded(
	operation: Promise<void>,
	timeoutMs: number,
): Promise<"complete" | "failed" | "timeout"> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<"timeout">((resolveTimeout) => {
		timer = setTimeout(resolveTimeout, timeoutMs, "timeout");
	});
	const completion = operation.then<"complete", "failed">(
		() => "complete",
		() => "failed",
	);
	return Promise.race([completion, timeout]).finally(() => clearTimeout(timer));
}

async function loadManifest(
	options: MigrateCommandOptions,
	projectRoot: string,
	dependencies: MigrateCommandDependencies,
): Promise<unknown> {
	if (options.fromConfig) {
		dependencies.writeStderr(
			`Using trusted evaluated Astro configuration${options.config ? `: ${options.config}` : "."}`,
		);
		return dependencies.buildManifestFromConfig(projectRoot, options.config);
	}
	const isDefault = !options.manifest;
	const path = options.manifest
		? isAbsolute(options.manifest)
			? options.manifest
			: resolve(projectRoot, options.manifest)
		: resolve(projectRoot, ".emdash/migrations.json");
	return dependencies.readManifest(path, isDefault);
}

function redactExecutorMessage(
	message: string,
	env: Readonly<Record<string, string | undefined>>,
): string {
	let redacted = message
		.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, "[REDACTED_URL]")
		.replace(
			/\b(auth|credential|key|password|secret|signature|token)\s*[=:]\s*\S+/gi,
			"$1=[REDACTED]",
		);
	for (const value of Object.values(env)) {
		if (value && value.length >= 4) redacted = redacted.replaceAll(value, "[REDACTED]");
	}
	return redacted.replaceAll(/[\r\n\t]/g, " ").slice(0, 1_000);
}

function safeCommandMessage(
	error: unknown,
	env: Readonly<Record<string, string | undefined>>,
): string {
	if (error instanceof MigrateCommandError || error instanceof MigrationManifestValidationError) {
		return error.message;
	}
	if (error instanceof Error && error.message) return redactExecutorMessage(error.message, env);
	return "Migration command failed. Check the project configuration, target, and credentials.";
}

export async function runMigrateCommand(
	options: MigrateCommandOptions,
	dependencies: MigrateCommandDependencies = defaultDependencies,
): Promise<number> {
	let executor: MigrationExecutor | undefined;
	let disposePromise: Promise<void> | undefined;
	let interrupted = false;
	let primaryFailure = false;
	let exitCode: number = MIGRATE_EXIT_CODES.error;
	const interruptedResult = Symbol("interrupted");
	let resolveInterruption: (() => void) | undefined;
	const interruption = new Promise<typeof interruptedResult>((resolveInterrupted) => {
		resolveInterruption = () => resolveInterrupted(interruptedResult);
	});
	const dispose = () => {
		disposePromise ??= executor?.dispose?.() ?? Promise.resolve();
		return disposePromise;
	};
	const removeSignalHandlers: (() => void)[] = [];

	const execute = async (): Promise<number> => {
		try {
			validateOptions(options);
			const projectRoot = await dependencies.findProjectRoot(dependencies.cwd);
			const unvalidatedManifest = await loadManifest(options, projectRoot, dependencies);
			const identity = await dependencies.loadProjectIdentity(projectRoot);
			const manifest: MigrationManifestV1 = await validateMigrationManifest(
				unvalidatedManifest,
				identity,
			);
			const factory = await dependencies.loadProjectExecutor(
				projectRoot,
				manifest.database.executorEntrypoint,
			);
			executor = await factory(manifest.database.executorConfig, {
				projectRoot,
				env: dependencies.env,
				overrides: createOverrides(options),
			});
			const target = immutableTarget(executor.target);
			printTarget(target, dependencies.writeStderr);

			const onSignal = async () => {
				interrupted = true;
				await bounded(dispose(), dependencies.cleanupTimeoutMs);
				resolveInterruption?.();
			};
			removeSignalHandlers.push(
				dependencies.onSignal("SIGINT", onSignal),
				dependencies.onSignal("SIGTERM", onSignal),
			);

			const applying = !options.check && !options.status;
			if (applying && target.kind === "d1") {
				dependencies.writeStderr(
					"Warning: D1 migration jobs must be serialized externally by Cloudflare account and database UUID; this command does not coordinate concurrent applies.",
				);
			}
			if (applying) {
				if (options.expectedTargetFingerprint) {
					if (options.expectedTargetFingerprint !== target.fingerprint) {
						dependencies.writeStderr("Expected target fingerprint does not match the target.");
						exitCode = MIGRATE_EXIT_CODES.confirmation;
						return exitCode;
					}
				} else if (!dependencies.interactive || options.json) {
					dependencies.writeStderr(
						"Noninteractive apply requires --expected-target-fingerprint with the displayed fingerprint.",
					);
					exitCode = MIGRATE_EXIT_CODES.confirmation;
					return exitCode;
				} else if (!(await dependencies.confirm(`Apply EmDash migrations to ${target.label}?`))) {
					dependencies.writeStderr("Migration cancelled.");
					exitCode = MIGRATE_EXIT_CODES.confirmation;
					return exitCode;
				}
			}

			const rawReport = await Promise.race([
				executor.execute({
					action: applying ? "apply" : "check",
					i18n: manifest.i18n,
					artifact: {
						emdashVersion: manifest.emdashVersion,
						migrationSetFingerprint: manifest.migrationSet.fingerprint,
					},
				}),
				interruption,
			]);
			if (rawReport === interruptedResult || interrupted) {
				exitCode = MIGRATE_EXIT_CODES.interrupted;
				return exitCode;
			}
			const report = safeReport(rawReport, target);
			if (options.json) {
				dependencies.writeStdout(JSON.stringify(report));
			} else {
				printHumanReport(report, dependencies.writeStdout);
			}
			exitCode = reportExitCode(options, report);
			return exitCode;
		} catch (error) {
			primaryFailure = true;
			dependencies.writeStderr(safeCommandMessage(error, dependencies.env));
			exitCode = interrupted ? MIGRATE_EXIT_CODES.interrupted : MIGRATE_EXIT_CODES.error;
			return exitCode;
		}
	};

	try {
		exitCode = await execute();
	} finally {
		for (const remove of removeSignalHandlers) remove();
		if (executor) {
			const cleanup = await bounded(dispose(), dependencies.cleanupTimeoutMs);
			if (cleanup !== "complete" && !primaryFailure && !interrupted) {
				dependencies.writeStderr("Migration executor cleanup failed.");
				exitCode = MIGRATE_EXIT_CODES.error;
			}
		}
	}
	return exitCode;
}

export const migrateCommand = defineCommand({
	meta: {
		name: "migrate",
		description: "Check or apply deployment-managed EmDash migrations",
	},
	args: {
		manifest: { type: "string", description: "Migration manifest path" },
		"from-config": { type: "boolean", description: "Build the manifest from Astro config" },
		config: { type: "string", description: "Astro config path (requires --from-config)" },
		check: { type: "boolean", description: "Check for pending or unknown migrations" },
		status: { type: "boolean", description: "Report all migration status sets" },
		json: { type: "boolean", description: "Print the stable JSON report" },
		"expected-target-fingerprint": {
			type: "string",
			description: "Required target fingerprint for noninteractive apply",
		},
		database: { type: "string", description: "Override the SQLite database path" },
		"database-url-env": {
			type: "string",
			description: "Override the database URL environment-variable name",
		},
		d1: { type: "string", description: "Override the D1 database UUID or name" },
		"account-id": { type: "string", description: "Override the Cloudflare account ID" },
		"wrangler-config": { type: "string", description: "Override the Wrangler config path" },
		"wrangler-env": { type: "string", description: "Override the Wrangler environment" },
	},
	async run({ args }) {
		process.exitCode = await runMigrateCommand({
			manifest: args.manifest,
			fromConfig: args["from-config"],
			config: args.config,
			check: args.check,
			status: args.status,
			json: args.json,
			expectedTargetFingerprint: args["expected-target-fingerprint"],
			database: args.database,
			databaseUrlEnv: args["database-url-env"],
			d1: args.d1,
			accountId: args["account-id"],
			wranglerConfig: args["wrangler-config"],
			wranglerEnv: args["wrangler-env"],
		});
	},
});
