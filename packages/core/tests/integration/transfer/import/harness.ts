/**
 * Test harness for import execution: a default-seeded target with the golden
 * package staged under a planned import operation, a hand-built plan (no
 * analyzer), a fault-injecting database plugin, and a driver that advances
 * the import to a terminal state.
 */

import {
	type Kysely,
	type KyselyPlugin,
	type PluginTransformQueryArgs,
	type PluginTransformResultArgs,
	type QueryResult,
	type RootOperationNode,
	type UnknownRow,
} from "kysely";

import type { Database } from "../../../../src/database/types.js";
import { applySeed } from "../../../../src/seed/apply.js";
import { defaultSeed } from "../../../../src/seed/default.js";
import { inspectPortableDomain } from "../../../../src/transfer/domain.js";
import { canonicalJson } from "../../../../src/transfer/format/canonical.js";
import { planDigest, type Sha256Digest } from "../../../../src/transfer/format/digest.js";
import { RECORD_KINDS } from "../../../../src/transfer/format/kinds.js";
import type { SiteImportPlan } from "../../../../src/transfer/format/plan.js";
import type { ImportTransformation } from "../../../../src/transfer/format/transformations.js";
import {
	advanceImport,
	requestImportExecution,
	type AdvanceImportResult,
	type VerifyImportStep,
} from "../../../../src/transfer/import/index.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import { TransferOperationRepository } from "../../../../src/transfer/ops/operations.js";
import { TransferStagedFileRepository } from "../../../../src/transfer/ops/staged-files.js";
import { getOrCreateSiteId } from "../../../../src/transfer/site-id.js";
import { stagingPrefix } from "../../../../src/transfer/staging/keys.js";
import { TransferStage } from "../../../../src/transfer/staging/stage.js";
import type { DialectName } from "../../../utils/test-db.js";
import {
	buildGoldenPackage,
	GOLDEN_IDS,
	type GoldenPackage,
} from "../../../utils/transfer/golden-package.js";
import type { MemoryStorage } from "../../../utils/transfer/memory-storage.js";

export const TARGET_USER = "target_user_bob";

export const verifyOk: VerifyImportStep = async () => ({
	done: true,
	logicalDigest: `sha256:${"0".repeat(64)}`,
	counts: { entry: 6 },
	mismatches: [],
});

export interface StagedImport {
	operationId: string;
	golden: GoldenPackage;
	plan: SiteImportPlan;
	packageDigest: Sha256Digest;
	planDigest: Sha256Digest;
}

export async function seedTarget(db: Kysely<Database>): Promise<void> {
	await applySeed(db, defaultSeed, { includeContent: false, onConflict: "skip" });
	await db
		.insertInto("users")
		.values({
			id: TARGET_USER,
			email: "bob@target.example",
			name: "Target Bob",
			avatar_url: null,
			role: 50,
			email_verified: 1,
			data: null,
		})
		.execute();
}

/**
 * Stage the golden package under a new import operation, write a plan, and
 * request execution. Alice is left unmapped (so her inferred credits are
 * materialized) and Bob maps to a target user.
 */
export async function stageGoldenImport(
	db: Kysely<Database>,
	storage: MemoryStorage,
	dialect: DialectName,
	options: { siteTitle?: "package" | "target"; transformations?: ImportTransformation[] } = {},
): Promise<StagedImport> {
	const ops = new TransferOperationRepository(db);
	const { operation } = await ops.create({ kind: "import", createdBy: TARGET_USER });
	const prefix = stagingPrefix("import", operation.id, operation.stagingSecret);
	const golden = await buildGoldenPackage(storage, { prefix });

	const files = [];
	for await (const { entry } of golden.reader.index()) files.push(entry);
	await new TransferStagedFileRepository(db).declareMany(operation.id, files, "verified");

	const domain = await inspectPortableDomain(db);
	const scaffold = domain.seededScaffold.map((item) => ({ type: item.type, id: item.id }));
	const counts: Partial<Record<(typeof RECORD_KINDS)[number], number>> = {};
	for (const kind of RECORD_KINDS) {
		const summary = golden.manifest.records[kind];
		if (summary) counts[kind] = summary.count;
	}
	const transformations: ImportTransformation[] = [
		{ code: "seeded_scaffold_removed", count: scaffold.length, items: scaffold },
		...(dialect === "postgres"
			? ([
					{ code: "search_unsupported", kind: "collection", ids: [GOLDEN_IDS.posts] },
					{ code: "float4_rounded", count: 1 },
				] satisfies ImportTransformation[])
			: []),
		...(options.transformations ?? []),
	];
	const plan: SiteImportPlan = {
		formatVersion: "1",
		packageDigest: golden.digest,
		origin: {
			siteId: golden.manifest.originSiteId,
			packageId: golden.manifest.packageId,
			createdAt: golden.manifest.createdAt,
			createdByEmDashVersion: golden.manifest.createdByEmDashVersion,
		},
		target: { siteId: await getOrCreateSiteId(db), dialect, emdashVersion: "dev" },
		counts,
		bytes: { records: golden.manifest.files.totalBytes, media: golden.manifest.media.totalBytes },
		principals: [
			{ id: GOLDEN_IDS.alice, displayName: "Alice Author", references: 8 },
			{ id: GOLDEN_IDS.bob, displayName: "Bob", references: 5, suggestedUserId: TARGET_USER },
		],
		settings: { title: {}, tagline: {} },
		decisions: {
			principalMappings: { [GOLDEN_IDS.alice]: null, [GOLDEN_IDS.bob]: TARGET_USER },
			siteTitle: options.siteTitle ?? "package",
			siteTagline: "package",
		},
		transformations,
		warnings: [],
		blockers: [],
		estimatedSteps: 1,
	};
	const digest = await planDigest(plan);
	await new TransferStage(storage, prefix).putAux("plan", canonicalJson(plan));
	await db
		.updateTable("_emdash_transfer_operations")
		.set({
			state: "planned",
			package_digest: golden.digest,
			plan_digest: digest,
			origin_site_id: golden.manifest.originSiteId,
		})
		.where("id", "=", operation.id)
		.execute();
	await requestImportExecution({
		db,
		operationId: operation.id,
		packageDigest: golden.digest,
		planDigest: digest,
	});
	return {
		operationId: operation.id,
		golden,
		plan,
		packageDigest: golden.digest,
		planDigest: digest,
	};
}

/** Advance until terminal; returns every step result. */
export async function driveImport(
	db: Kysely<Database>,
	storage: MemoryStorage,
	operationId: string,
	options: { verify?: VerifyImportStep; budget?: () => TransferStepBudget; maxSteps?: number } = {},
): Promise<AdvanceImportResult[]> {
	const results: AdvanceImportResult[] = [];
	for (let step = 0; step < (options.maxSteps ?? 10_000); step++) {
		const result = await advanceImport({
			db,
			storage,
			operationId,
			verify: options.verify ?? verifyOk,
			budget: options.budget?.(),
		});
		results.push(result);
		if (result.nextRequestInMs === null) return results;
	}
	throw new Error("Import did not finish");
}

/**
 * Counts every statement and simulates a crash: after a chosen statement has
 * executed, it and every later statement fail (later ones without
 * executing) until `disarm`, so code that swallows one error cannot carry on
 * as if nothing happened.
 */
export class FaultPlugin implements KyselyPlugin {
	executed = 0;
	maxParameters = 0;
	/** Runs after every update of an operation row (a checkpoint), outside any transaction. */
	afterCheckpoint: (() => Promise<void>) | null = null;
	#failAfter: number | null = null;
	#dead = false;
	readonly #checkpoints = new WeakSet<object>();
	#compile: ((node: RootOperationNode) => number) | null = null;

	bindCompiler(db: Kysely<Database>): void {
		const executor = db.getExecutor();
		this.#compile = (node) => executor.compileQuery(node, { queryId: "fault" }).parameters.length;
	}

	/** Crash after the `n`th statement from now executes. */
	failAfter(n: number): void {
		this.#failAfter = this.executed + n;
	}

	get crashed(): boolean {
		return this.#dead;
	}

	disarm(): void {
		this.#failAfter = null;
		this.#dead = false;
	}

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		if (this.#dead) throw new Error("injected crash");
		if (this.#compile) {
			this.maxParameters = Math.max(this.maxParameters, this.#compile(args.node));
		}
		if (
			args.node.kind === "UpdateQueryNode" &&
			JSON.stringify(args.node.table).includes('"_emdash_transfer_operations"')
		) {
			this.#checkpoints.add(args.queryId);
		}
		return args.node;
	}

	async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		this.executed++;
		if (this.#failAfter !== null && this.executed >= this.#failAfter) {
			this.#failAfter = null;
			this.#dead = true;
			throw new Error("injected crash");
		}
		if (this.afterCheckpoint && this.#checkpoints.has(args.queryId)) await this.afterCheckpoint();
		return args.result;
	}
}

export function withFaults(db: Kysely<Database>): { db: Kysely<Database>; faults: FaultPlugin } {
	const faults = new FaultPlugin();
	const faulty = db.withPlugin(faults);
	faults.bindCompiler(db);
	return { db: faulty, faults };
}

/** A step budget over a query counter, for bounded-step tests. */
export function countingBudget(
	faults: FaultPlugin,
	queryCeiling: number,
): () => TransferStepBudget {
	return () => {
		const metrics = {
			get dbCount() {
				return faults.executed - start;
			},
		};
		const start = faults.executed;
		return new TransferStepBudget({ metrics, queryCeiling });
	};
}
