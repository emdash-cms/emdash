import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MigrationSignal } from "../../../src/cli/commands/migrate.js";
import {
	loadProjectMigrationExecutor,
	loadProjectMigrationIdentity,
	MIGRATE_EXIT_CODES,
	readMigrationManifestFile,
	runMigrateCommand,
	type MigrateCommandDependencies,
} from "../../../src/cli/commands/migrate.js";
import { createCoreMigrationIdentity } from "../../../src/migrations/identity.js";
import type { MigrationManifestV1 } from "../../../src/migrations/manifest.js";
import type { MigrationExecutor } from "../../../src/migrations/protocol.js";

async function fixture(
	options: {
		pending?: string[];
		unknownApplied?: string[];
		executed?: string[];
		interactive?: boolean;
		targetKind?: string;
	} = {},
) {
	const identity = await createCoreMigrationIdentity("1.2.3", ["001_initial"]);
	const manifest: MigrationManifestV1 = {
		schemaVersion: 1,
		emdashVersion: identity.emdashVersion,
		migrationSet: { names: [...identity.names], fingerprint: identity.fingerprint },
		i18n: null,
		database: {
			type: "sqlite",
			executorEntrypoint: "project-executor",
			executorConfig: { url: "file:./data.db" },
		},
	};
	const target = Object.freeze({
		kind: options.targetKind ?? "sqlite",
		label: "/project/data.db",
		fingerprint: "a".repeat(64),
	});
	const calls: string[] = [];
	const execute = vi.fn(async () => {
		calls.push("execute");
		return {
			target,
			knownApplied: [],
			pending: options.pending ?? [],
			unknownApplied: options.unknownApplied ?? [],
			executed: options.executed ?? [],
		};
	});
	const dispose = vi.fn(async () => undefined);
	const executor: MigrationExecutor = { target, execute, dispose };
	const createExecutor = vi.fn(async () => {
		calls.push("target");
		return executor;
	});
	const stdout: string[] = [];
	const stderr: string[] = [];
	const signalHandlers = new Map<MigrationSignal, () => Promise<void>>();
	const dependencies: MigrateCommandDependencies = {
		cwd: "/project/subdirectory",
		env: {},
		interactive: options.interactive ?? false,
		findProjectRoot: vi.fn(async () => {
			calls.push("root");
			return "/project";
		}),
		readManifest: vi.fn(async () => {
			calls.push("manifest");
			return manifest;
		}),
		buildManifestFromConfig: vi.fn(async () => manifest),
		loadProjectIdentity: vi.fn(async () => {
			calls.push("identity");
			return identity;
		}),
		loadProjectExecutor: vi.fn(async () => {
			calls.push("executor-module");
			return createExecutor;
		}),
		confirm: vi.fn(async () => true),
		writeStdout: (value) => {
			calls.push("stdout");
			stdout.push(value);
		},
		writeStderr: (value) => {
			calls.push("stderr");
			stderr.push(value);
		},
		onSignal: (signal, handler) => {
			signalHandlers.set(signal, handler);
			return () => signalHandlers.delete(signal);
		},
		cleanupTimeoutMs: 10,
	};
	return {
		calls,
		createExecutor,
		dependencies,
		dispose,
		execute,
		manifest,
		signalHandlers,
		stderr,
		stdout,
		target,
	};
}

describe("runMigrateCommand", () => {
	it("validates project identity before loading the executor and prints the target before SQL", async () => {
		const context = await fixture({ pending: ["001_initial"] });

		const exitCode = await runMigrateCommand(
			{ check: true, database: "override.db" },
			context.dependencies,
		);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.pending);
		expect(context.calls.slice(0, 5)).toEqual([
			"root",
			"manifest",
			"identity",
			"executor-module",
			"target",
		]);
		expect(context.calls.indexOf("stderr")).toBeLessThan(context.calls.indexOf("execute"));
		expect(context.execute).toHaveBeenCalledOnce();
		expect(context.execute).toHaveBeenCalledWith({
			action: "check",
			i18n: null,
			artifact: {
				emdashVersion: "1.2.3",
				migrationSetFingerprint: context.manifest.migrationSet.fingerprint,
			},
		});
		expect(context.dependencies.loadProjectExecutor).toHaveBeenCalledWith(
			"/project",
			"project-executor",
		);
		expect(context.dispose).toHaveBeenCalledOnce();
	});

	it("requires the expected target fingerprint for noninteractive apply", async () => {
		const missing = await fixture();
		const mismatch = await fixture();

		await expect(runMigrateCommand({}, missing.dependencies)).resolves.toBe(
			MIGRATE_EXIT_CODES.confirmation,
		);
		await expect(
			runMigrateCommand({ expectedTargetFingerprint: "b".repeat(64) }, mismatch.dependencies),
		).resolves.toBe(MIGRATE_EXIT_CODES.confirmation);
		expect(missing.execute).not.toHaveBeenCalled();
		expect(mismatch.execute).not.toHaveBeenCalled();
		expect(missing.stderr.join("\n")).toContain("--expected-target-fingerprint");
		expect(mismatch.stderr.join("\n")).not.toContain("b".repeat(64));
	});

	it("passes every target override to the project-local executor", async () => {
		const context = await fixture({ pending: ["001_initial"] });
		const overrides = {
			database: "custom.db",
			databaseUrlEnv: "CUSTOM_DATABASE_URL",
			d1: "database-id",
			accountId: "account-id",
			wranglerConfig: "wrangler.custom.jsonc",
			wranglerEnv: "staging",
		};

		await runMigrateCommand({ check: true, ...overrides }, context.dependencies);

		expect(context.createExecutor).toHaveBeenCalledWith(context.manifest.database.executorConfig, {
			projectRoot: "/project",
			env: {},
			overrides,
		});
	});

	it("rejects a stale project identity before resolving an executor or target", async () => {
		const context = await fixture();
		context.dependencies.loadProjectIdentity = vi.fn(async () =>
			createCoreMigrationIdentity("9.9.9", ["001_initial"]),
		);

		const exitCode = await runMigrateCommand({ status: true }, context.dependencies);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.error);
		expect(context.dependencies.loadProjectExecutor).not.toHaveBeenCalled();
		expect(context.createExecutor).not.toHaveBeenCalled();
	});

	it("prompts before interactive apply and reports executed migration names", async () => {
		const context = await fixture({ interactive: true, executed: ["001_initial"] });

		const exitCode = await runMigrateCommand({}, context.dependencies);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.success);
		expect(context.dependencies.confirm).toHaveBeenCalledOnce();
		expect(context.execute).toHaveBeenCalledOnce();
		expect(context.stdout.join("\n")).toContain("001_initial");
	});

	it("uses stable check and status exit-code behavior", async () => {
		const pending = await fixture({ pending: ["001_initial"] });
		const unknown = await fixture({
			pending: ["001_initial"],
			unknownApplied: ["999_foreign"],
		});
		const status = await fixture({
			pending: ["001_initial"],
			unknownApplied: ["999_foreign"],
		});

		await expect(runMigrateCommand({ check: true }, pending.dependencies)).resolves.toBe(
			MIGRATE_EXIT_CODES.pending,
		);
		await expect(runMigrateCommand({ check: true }, unknown.dependencies)).resolves.toBe(
			MIGRATE_EXIT_CODES.unknownApplied,
		);
		await expect(runMigrateCommand({ status: true }, status.dependencies)).resolves.toBe(
			MIGRATE_EXIT_CODES.success,
		);
		expect(status.stdout.join("\n")).toContain("Known applied");
		expect(status.stdout.join("\n")).toContain("Pending");
		expect(status.stdout.join("\n")).toContain("Unknown applied");
	});

	it("emits one stable JSON report while writing the preflight target to stderr", async () => {
		const context = await fixture({ pending: ["001_initial"] });

		const exitCode = await runMigrateCommand({ status: true, json: true }, context.dependencies);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.success);
		expect(context.stdout).toHaveLength(1);
		expect(JSON.parse(context.stdout[0]!)).toEqual({
			target: context.target,
			knownApplied: [],
			pending: ["001_initial"],
			unknownApplied: [],
			executed: [],
		});
		expect(context.stderr.join("\n")).toContain(context.target.fingerprint);
	});

	it("rejects array-shaped executor reports", async () => {
		const context = await fixture();
		const report = Object.assign([], {
			target: context.target,
			knownApplied: [],
			pending: [],
			unknownApplied: [],
			executed: [],
		});
		context.execute.mockResolvedValueOnce(report);

		const exitCode = await runMigrateCommand({ status: true, json: true }, context.dependencies);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.error);
		expect(context.stdout).toEqual([]);
		expect(context.stderr.join("\n")).toContain("invalid report");
		expect(context.dispose).toHaveBeenCalledOnce();
	});

	it("rejects reports for a different migration target", async () => {
		const context = await fixture();
		context.execute.mockResolvedValueOnce({
			target: { ...context.target, fingerprint: "b".repeat(64) },
			knownApplied: [],
			pending: [],
			unknownApplied: [],
			executed: [],
		});

		const exitCode = await runMigrateCommand({ status: true, json: true }, context.dependencies);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.error);
		expect(context.stdout).toEqual([]);
		expect(context.stderr.join("\n")).toContain("report target does not match");
		expect(context.dispose).toHaveBeenCalledOnce();
	});

	it("warns before D1 applies without warning for read-only or non-D1 operations", async () => {
		const apply = await fixture({ pending: ["001_initial"], targetKind: "d1" });
		const check = await fixture({ pending: ["001_initial"], targetKind: "d1" });
		const status = await fixture({ pending: ["001_initial"], targetKind: "d1" });
		const sqlite = await fixture({ pending: ["001_initial"] });

		await runMigrateCommand(
			{
				expectedTargetFingerprint: apply.target.fingerprint,
				json: true,
			},
			apply.dependencies,
		);
		await runMigrateCommand({ check: true }, check.dependencies);
		await runMigrateCommand({ status: true }, status.dependencies);
		await runMigrateCommand(
			{ expectedTargetFingerprint: sqlite.target.fingerprint },
			sqlite.dependencies,
		);

		const warning = apply.stderr.find((line) => line.includes("serialized externally"));
		expect(warning).toContain("Cloudflare account and database UUID");
		expect(apply.calls.lastIndexOf("stderr")).toBeLessThan(apply.calls.indexOf("execute"));
		expect(apply.stdout).toHaveLength(1);
		expect(() => JSON.parse(apply.stdout[0]!)).not.toThrow();
		expect(check.stderr.join("\n")).not.toContain("serialized externally");
		expect(status.stderr.join("\n")).not.toContain("serialized externally");
		expect(sqlite.stderr.join("\n")).not.toContain("serialized externally");
	});

	it("disposes once on failure without leaking executor errors or environment secrets", async () => {
		const context = await fixture();
		context.dependencies.env = { DATABASE_URL: "postgres://user:very-secret@example.com/db" };
		context.execute.mockRejectedValueOnce(
			new Error("failed postgres://user:very-secret@example.com/db token=very-secret"),
		);

		const exitCode = await runMigrateCommand(
			{ expectedTargetFingerprint: context.target.fingerprint },
			context.dependencies,
		);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.error);
		expect(context.execute).toHaveBeenCalledOnce();
		expect(context.dispose).toHaveBeenCalledOnce();
		expect(context.stderr.join("\n")).not.toContain("very-secret");
		expect(context.stderr.join("\n")).not.toContain("postgres://");
	});

	it("preserves useful executor errors after redaction", async () => {
		const context = await fixture();
		context.execute.mockRejectedValueOnce(
			new Error("Cannot apply migrations with unknown applied migrations: 999_foreign"),
		);

		await runMigrateCommand(
			{ expectedTargetFingerprint: context.target.fingerprint },
			context.dependencies,
		);

		expect(context.stderr.join("\n")).toContain(
			"Cannot apply migrations with unknown applied migrations: 999_foreign",
		);
	});

	it("fails on cleanup errors when there is no primary failure", async () => {
		const context = await fixture({ pending: ["001_initial"] });
		context.dispose.mockRejectedValueOnce(new Error("cleanup secret"));

		const exitCode = await runMigrateCommand({ status: true }, context.dependencies);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.error);
		expect(context.stderr.join("\n")).toContain("Migration executor cleanup failed");
		expect(context.stderr.join("\n")).not.toContain("cleanup secret");
	});

	it("bounds signal cleanup and does not let cleanup replace the primary error", async () => {
		const context = await fixture();
		let rejectExecute: ((error: Error) => void) | undefined;
		context.execute.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectExecute = reject;
				}),
		);
		context.dispose.mockRejectedValueOnce(new Error("cleanup secret"));

		const run = runMigrateCommand(
			{ expectedTargetFingerprint: context.target.fingerprint },
			context.dependencies,
		);
		await vi.waitFor(() => expect(context.execute).toHaveBeenCalledOnce());
		await context.signalHandlers.get("SIGTERM")?.();
		rejectExecute?.(new Error("primary secret"));

		await expect(run).resolves.toBe(MIGRATE_EXIT_CODES.interrupted);
		expect(context.dispose).toHaveBeenCalledOnce();
		expect(context.stderr.join("\n")).not.toContain("primary secret");
		expect(context.stderr.join("\n")).not.toContain("cleanup secret");
	});

	it("rejects conflicting discovery options before reading a manifest", async () => {
		const context = await fixture();

		const exitCode = await runMigrateCommand(
			{ manifest: "custom.json", fromConfig: true, config: "astro.config.mjs" },
			context.dependencies,
		);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.error);
		expect(context.dependencies.readManifest).not.toHaveBeenCalled();
		expect(context.dependencies.buildManifestFromConfig).not.toHaveBeenCalled();
	});

	it("rejects check and status together before reading a manifest", async () => {
		const context = await fixture();

		const exitCode = await runMigrateCommand({ check: true, status: true }, context.dependencies);

		expect(exitCode).toBe(MIGRATE_EXIT_CODES.error);
		expect(context.dependencies.readManifest).not.toHaveBeenCalled();
	});

	it("explains how to create or bypass a missing default manifest", async () => {
		await expect(
			readMigrationManifestFile("/missing/.emdash/migrations.json", true),
		).rejects.toThrow("Build the project or use --from-config");
	});

	it("does not report other manifest read failures as a missing build", async () => {
		const directory = await mkdtemp(join(tmpdir(), "emdash-manifest-read-error-"));
		try {
			await expect(readMigrationManifestFile(directory, true)).rejects.toThrow(
				"Could not read migration manifest",
			);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("announces explicit trusted config evaluation", async () => {
		const context = await fixture({ pending: ["001_initial"] });

		await runMigrateCommand(
			{ fromConfig: true, config: "astro.config.mjs", status: true },
			context.dependencies,
		);

		expect(context.dependencies.buildManifestFromConfig).toHaveBeenCalledWith(
			"/project",
			"astro.config.mjs",
		);
		expect(context.stderr.join("\n")).toContain("Using trusted evaluated Astro configuration");
	});
});

describe("project-local migration module resolution", () => {
	const tempDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
		);
	});

	async function writeModule(path: string, contents: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, contents);
	}

	it("resolves identity and executor from pnpm-linked project dependencies", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-cli-project-resolution-"));
		tempDirectories.push(root);
		const modules = join(root, "node_modules");
		const emdashPackage = join(modules, ".pnpm", "emdash@project", "node_modules", "emdash");
		const identity = await createCoreMigrationIdentity("7.6.5-project", ["001_project"]);
		await writeFile(join(root, "package.json"), '{"type":"module"}');
		await writeModule(
			join(emdashPackage, "package.json"),
			JSON.stringify({
				name: "emdash",
				type: "module",
				exports: {
					"./migrations": "./migrations.js",
					"./project-executor": "./executor.js",
				},
			}),
		);
		await writeModule(
			join(emdashPackage, "migrations.js"),
			`export async function getCoreMigrationIdentity() { return ${JSON.stringify(identity)}; }`,
		);
		await writeModule(
			join(emdashPackage, "executor.js"),
			`export async function createMigrationExecutor(config, context) {
				return {
					target: { kind: "test", label: context.projectRoot + "/" + config.name, fingerprint: "${"c".repeat(64)}" },
					async execute() { throw new Error("not called"); }
				};
			}`,
		);
		await mkdir(modules, { recursive: true });
		await symlink(emdashPackage, join(modules, "emdash"), "dir");

		await expect(loadProjectMigrationIdentity(root)).resolves.toEqual(identity);
		const factory = await loadProjectMigrationExecutor(root, "emdash/project-executor");
		const executor = await factory(
			{ name: "project.db" },
			{ projectRoot: root, env: {}, overrides: {} },
		);
		expect(executor.target).toEqual({
			kind: "test",
			label: `${root}/project.db`,
			fingerprint: "c".repeat(64),
		});
	});
});
