import { sql, type Kysely, type RawBuilder, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { isPostgres, tableExists } from "../../database/dialect-helpers.js";
import type { Database, MediaUsageActivationTable } from "../../database/types.js";
import {
	installMediaUsageCaptureTriggers,
	verifyMediaUsageCaptureTriggers,
} from "./capture-triggers.js";

const ACTIVATION_KEY = "incremental_capture";
const ACTIVATION_ERROR_CODE = "MEDIA_USAGE_ACTIVATION_FAILED";
export const MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION = 1;

export const MEDIA_USAGE_ACTIVATION_LIMITS = Object.freeze({
	collectionsPerCall: 1,
	leaseDurationSeconds: 5 * 60,
});

export type MediaUsageActivationResult =
	| { outcome: "active"; processedCollections: number }
	| {
			outcome: "activating";
			processedCollections: number;
			collectionCursor: string | null;
	  }
	| { outcome: "lease_active"; leaseExpiresAt: string }
	| { outcome: "conflict"; processedCollections: number };

export interface MediaUsageCollectionCapturePreparation {
	captureRequired: boolean;
	collectionId: string;
	registrationExists: boolean;
	resuming: boolean;
}

export async function canResumeMediaUsageCollectionCapture(
	db: Kysely<Database>,
	identity: { collectionId: string; collectionSlug: string; creationFingerprint?: string },
): Promise<boolean> {
	const activation = await findActivationIfAvailable(db);
	if (!activation) return false;
	assertRuntimeGeneration(activation);
	if (activation.state !== "active") return false;

	const lifecycle = await db
		.selectFrom("_emdash_media_usage_index_status")
		.select(["collection_id", "cursor"])
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", identity.collectionSlug)
		.where("collection_id", "=", identity.collectionId)
		.where("capture_state", "in", ["installing", "ready"])
		.executeTakeFirst();
	return (
		lifecycle?.collection_id === identity.collectionId &&
		(identity.creationFingerprint
			? lifecycle.cursor === identity.creationFingerprint
			: lifecycle.cursor === null)
	);
}

export async function prepareMediaUsageCollectionCapture(
	db: Kysely<Database>,
	input: {
		collectionId: string;
		collectionSlug: string;
		creationFingerprint?: string;
		registeredCollectionId?: string;
	},
): Promise<MediaUsageCollectionCapturePreparation> {
	const activation = await findActivationIfAvailable(db);
	if (!activation) {
		return {
			captureRequired: false,
			collectionId: input.collectionId,
			registrationExists: input.registeredCollectionId !== undefined,
			resuming: false,
		};
	}
	assertRuntimeGeneration(activation);
	if (activation.state !== "active") {
		return {
			captureRequired: false,
			collectionId: input.collectionId,
			registrationExists: input.registeredCollectionId !== undefined,
			resuming: false,
		};
	}

	const existing = await db
		.selectFrom("_emdash_media_usage_index_status")
		.select(["collection_id", "capture_state", "cursor"])
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", input.collectionSlug)
		.executeTakeFirst();
	if (existing) {
		if (
			existing.collection_id &&
			(existing.capture_state === "installing" || existing.capture_state === "ready") &&
			(input.creationFingerprint
				? existing.cursor === input.creationFingerprint
				: existing.cursor === null) &&
			(input.registeredCollectionId === undefined ||
				input.registeredCollectionId === existing.collection_id)
		) {
			return {
				captureRequired: true,
				collectionId: existing.collection_id,
				registrationExists: input.registeredCollectionId !== undefined,
				resuming: true,
			};
		}
		throw new Error("Media usage collection lifecycle identity conflict");
	}
	if (input.registeredCollectionId !== undefined) {
		throw new Error("Media usage collection lifecycle is missing");
	}

	await db
		.insertInto("_emdash_media_usage_index_status")
		.values({
			adapter_id: "content-media",
			scope_type: "collection",
			scope_key: input.collectionSlug,
			status: "never",
			collection_id: input.collectionId,
			reconciliation_required: 1,
			capture_state: "installing",
			cursor: input.creationFingerprint ?? null,
			updated_at: timestampOffset(db, 0),
		})
		.execute();
	return {
		captureRequired: true,
		collectionId: input.collectionId,
		registrationExists: false,
		resuming: false,
	};
}

export async function installPreparedMediaUsageCollectionCapture(
	db: Kysely<Database>,
	identity: { collectionId: string; collectionSlug: string },
): Promise<void> {
	await installMediaUsageCaptureTriggers(db, identity, { replaceExisting: false });
	if (!(await verifyMediaUsageCaptureTriggers(db, identity))) {
		throw new Error("Media usage capture trigger verification failed");
	}
}

export async function markMediaUsageCollectionCaptureReady(
	db: Kysely<Database>,
	identity: { collectionId: string; collectionSlug: string },
): Promise<void> {
	const result = await db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "ready", updated_at: timestampOffset(db, 0) })
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", identity.collectionSlug)
		.where("collection_id", "=", identity.collectionId)
		.where("capture_state", "in", ["installing", "ready"])
		.where(
			sql<boolean>`EXISTS (
				SELECT 1 FROM _emdash_media_usage_activation AS activation
				WHERE activation.task_key = ${ACTIVATION_KEY}
					AND activation.state = 'active'
					AND activation.runtime_generation = ${MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION}
			)`,
		)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows ?? 0) === 0) {
		throw new Error("Media usage collection readiness lost its fence");
	}
}

export async function finalizeMediaUsageCollectionCapture(
	db: Kysely<Database>,
	identity: { collectionId: string; collectionSlug: string },
): Promise<void> {
	const result = await db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active", cursor: null, updated_at: timestampOffset(db, 0) })
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", identity.collectionSlug)
		.where("collection_id", "=", identity.collectionId)
		.where("capture_state", "=", "ready")
		.where(
			sql<boolean>`EXISTS (
				SELECT 1 FROM _emdash_collections AS collection
				WHERE collection.id = ${identity.collectionId}
					AND collection.slug = ${identity.collectionSlug}
			)`,
		)
		.where(
			sql<boolean>`EXISTS (
				SELECT 1 FROM _emdash_media_usage_activation AS activation
				WHERE activation.task_key = ${ACTIVATION_KEY}
					AND activation.state = 'active'
					AND activation.runtime_generation = ${MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION}
			)`,
		)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows ?? 0) === 0) {
		throw new Error("Media usage collection activation lost its fence");
	}
}

export async function activateMediaUsageCapture(
	db: Kysely<Database>,
	input: { writersDrained: true },
): Promise<MediaUsageActivationResult> {
	if (input.writersDrained !== true) {
		throw new Error("Media usage activation requires confirmation that writers are drained");
	}

	const before = await findActivation(db);
	assertRuntimeGeneration(before);
	if (before.state === "active") {
		return { outcome: "active", processedCollections: 0 };
	}

	const leaseToken = ulid();
	const lease = await claimActivation(db, leaseToken);
	if (!lease) return activationClaimLoss(db);

	let processedCollections = 0;
	try {
		const candidates = await findActivationCandidates(db, lease.collection_cursor);
		for (const collection of candidates.slice(
			0,
			MEDIA_USAGE_ACTIVATION_LIMITS.collectionsPerCall,
		)) {
			await requireActivationLease(db, leaseToken);
			await prepareCollectionForActivation(db, collection, leaseToken);
			await requireActivationLease(db, leaseToken);
			await installMediaUsageCaptureTriggers(
				db,
				{
					collectionId: collection.id,
					collectionSlug: collection.slug,
				},
				{ replaceExisting: false },
			);
			await requireActivationLease(db, leaseToken);
			if (
				!(await verifyMediaUsageCaptureTriggers(db, {
					collectionId: collection.id,
					collectionSlug: collection.slug,
				}))
			) {
				throw new Error("Media usage capture trigger verification failed");
			}
			if (!(await activateCollectionLifecycle(db, collection, leaseToken))) {
				throw new Error("Media usage collection activation lost its fence");
			}
			processedCollections++;
		}

		const collectionCursor =
			candidates[Math.min(processedCollections, candidates.length) - 1]?.slug ??
			lease.collection_cursor;
		if (candidates.length > MEDIA_USAGE_ACTIVATION_LIMITS.collectionsPerCall) {
			if (!(await releaseActivationBatch(db, leaseToken, collectionCursor))) {
				throw new Error("Media usage activation cursor lost its fence");
			}
			return { outcome: "activating", processedCollections, collectionCursor };
		}

		const incomplete = await findIncompleteCollection(db);
		if (incomplete) {
			if (!(await releaseActivationBatch(db, leaseToken, null))) {
				throw new Error("Media usage activation restart lost its fence");
			}
			return { outcome: "activating", processedCollections, collectionCursor: null };
		}

		if (!(await finalizeActivation(db, leaseToken, collectionCursor))) {
			throw new Error("Media usage activation finalization lost its fence");
		}
		return { outcome: "active", processedCollections };
	} catch (error) {
		if (!(await activationLeaseIsLive(db, leaseToken))) {
			return { outcome: "conflict", processedCollections };
		}
		await recordActivationFailure(db, leaseToken);
		throw new Error("Media usage activation failed", { cause: error });
	}
}

async function findActivation(
	db: Kysely<Database>,
): Promise<Selectable<MediaUsageActivationTable>> {
	return db
		.selectFrom("_emdash_media_usage_activation")
		.selectAll()
		.where("task_key", "=", ACTIVATION_KEY)
		.executeTakeFirstOrThrow();
}

async function findActivationIfAvailable(
	db: Kysely<Database>,
): Promise<Selectable<MediaUsageActivationTable> | null> {
	if (!(await tableExists(db, "_emdash_media_usage_activation"))) return null;
	return findActivation(db);
}

function assertRuntimeGeneration(activation: Selectable<MediaUsageActivationTable>): void {
	if (activation.runtime_generation !== MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION) {
		throw new Error("Media usage activation runtime generation mismatch");
	}
}

async function claimActivation(
	db: Kysely<Database>,
	leaseToken: string,
): Promise<Selectable<MediaUsageActivationTable> | null> {
	const now = timestampOffset(db, 0);
	return (
		(await db
			.updateTable("_emdash_media_usage_activation")
			.set({
				state: "activating",
				drain_confirmed_at: now,
				lease_token: leaseToken,
				lease_expires_at: timestampOffset(db, MEDIA_USAGE_ACTIVATION_LIMITS.leaseDurationSeconds),
				attempt_count: sql<number>`attempt_count + 1`,
				last_attempted_at: now,
				last_error_code: null,
				updated_at: now,
			})
			.where("task_key", "=", ACTIVATION_KEY)
			.where("runtime_generation", "=", MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION)
			.where((eb) =>
				eb.or([
					eb("state", "=", "expanded"),
					eb.and([
						eb("state", "=", "activating"),
						eb.or([
							eb("lease_token", "is", null),
							eb.and([
								eb("lease_expires_at", "is not", null),
								timestampIsDue(db, "lease_expires_at"),
							]),
						]),
					]),
				]),
			)
			.returningAll()
			.executeTakeFirst()) ?? null
	);
}

async function activationClaimLoss(db: Kysely<Database>): Promise<MediaUsageActivationResult> {
	const current = await findActivation(db);
	assertRuntimeGeneration(current);
	if (current.state === "active") return { outcome: "active", processedCollections: 0 };
	if (
		current.state === "activating" &&
		current.lease_token &&
		current.lease_expires_at &&
		(await activationLeaseIsLive(db, current.lease_token))
	) {
		return { outcome: "lease_active", leaseExpiresAt: current.lease_expires_at };
	}
	throw new Error("Media usage activation state is not claimable");
}

async function activationLeaseIsLive(db: Kysely<Database>, leaseToken: string): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_media_usage_activation")
		.select("task_key")
		.where("task_key", "=", ACTIVATION_KEY)
		.where("state", "=", "activating")
		.where("runtime_generation", "=", MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION)
		.where("lease_token", "=", leaseToken)
		.where("lease_expires_at", "is not", null)
		.where(timestampIsLive(db, "lease_expires_at"))
		.executeTakeFirst();
	return row !== undefined;
}

async function findActivationCandidates(
	db: Kysely<Database>,
	collectionCursor: string | null,
): Promise<Array<{ id: string; slug: string }>> {
	let query = db.selectFrom("_emdash_collections").select(["id", "slug"]);
	if (collectionCursor) query = query.where("slug", ">", collectionCursor);
	return query
		.orderBy("slug", "asc")
		.limit(MEDIA_USAGE_ACTIVATION_LIMITS.collectionsPerCall + 1)
		.execute();
}

async function prepareCollectionForActivation(
	db: Kysely<Database>,
	collection: { id: string; slug: string },
	leaseToken: string,
): Promise<void> {
	const now = timestampOffset(db, 0);
	const existingStatus = sql.ref("_emdash_media_usage_index_status.status");
	const existingCompletedAt = sql.ref("_emdash_media_usage_index_status.completed_at");
	const existingCollectionId = sql.ref("_emdash_media_usage_index_status.collection_id");
	const existingCaptureState = sql.ref("_emdash_media_usage_index_status.capture_state");
	const row = await db
		.insertInto("_emdash_media_usage_index_status")
		.values({
			adapter_id: "content-media",
			scope_type: "collection",
			scope_key: collection.slug,
			status: "never",
			collection_id: collection.id,
			reconciliation_required: 1,
			capture_state: "installing",
			updated_at: now,
		})
		.onConflict((conflict) =>
			conflict
				.columns(["adapter_id", "scope_type", "scope_key"])
				.doUpdateSet({
					status: sql<string>`CASE WHEN ${existingStatus} IN ('complete', 'running') THEN 'stale' ELSE ${existingStatus} END`,
					completed_at: sql<
						string | null
					>`CASE WHEN ${existingStatus} IN ('complete', 'running') THEN NULL ELSE ${existingCompletedAt} END`,
					cursor: null,
					collection_id: collection.id,
					reconciliation_required: 1,
					capture_state: "installing",
					updated_at: now,
				})
				.where((eb) =>
					eb.and([
						eb.or([
							eb(existingCollectionId, "is", null),
							eb(existingCollectionId, "=", collection.id),
						]),
						eb.or([
							eb(existingCaptureState, "is", null),
							eb(existingCaptureState, "!=", "deleting"),
						]),
						activeActivationLease(db, leaseToken),
					]),
				),
		)
		.returning("collection_id")
		.executeTakeFirst();
	if (row?.collection_id !== collection.id) {
		throw new Error("Media usage collection lifecycle identity conflict");
	}
}

async function requireActivationLease(db: Kysely<Database>, leaseToken: string): Promise<void> {
	if (!(await activationLeaseIsLive(db, leaseToken))) {
		throw new Error("Media usage activation lease is no longer live");
	}
}

async function activateCollectionLifecycle(
	db: Kysely<Database>,
	collection: { id: string; slug: string },
	leaseToken: string,
): Promise<boolean> {
	const result = await db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active", updated_at: timestampOffset(db, 0) })
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", collection.slug)
		.where("collection_id", "=", collection.id)
		.where("capture_state", "=", "installing")
		.where(
			sql<boolean>`EXISTS (
				SELECT 1 FROM _emdash_collections AS collection
				WHERE collection.id = ${collection.id}
					AND collection.slug = ${collection.slug}
			)`,
		)
		.where(activeActivationLease(db, leaseToken))
		.executeTakeFirst();
	return Number(result.numUpdatedRows ?? 0) > 0;
}

async function releaseActivationBatch(
	db: Kysely<Database>,
	leaseToken: string,
	collectionCursor: string | null,
): Promise<boolean> {
	const result = await db
		.updateTable("_emdash_media_usage_activation")
		.set({
			collection_cursor: collectionCursor,
			lease_token: null,
			lease_expires_at: null,
			updated_at: timestampOffset(db, 0),
		})
		.where("task_key", "=", ACTIVATION_KEY)
		.where("state", "=", "activating")
		.where("runtime_generation", "=", MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION)
		.where("lease_token", "=", leaseToken)
		.where("lease_expires_at", "is not", null)
		.where(timestampIsLive(db, "lease_expires_at"))
		.executeTakeFirst();
	return Number(result.numUpdatedRows ?? 0) > 0;
}

async function findIncompleteCollection(
	db: Kysely<Database>,
): Promise<{ id: string; slug: string } | null> {
	const row = await db
		.selectFrom("_emdash_collections as collection")
		.select(["collection.id", "collection.slug"])
		.where((eb) =>
			eb.not(
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_index_status as status")
						.select("status.scope_key")
						.where("status.adapter_id", "=", "content-media")
						.where("status.scope_type", "=", "collection")
						.whereRef("status.scope_key", "=", "collection.slug")
						.whereRef("status.collection_id", "=", "collection.id")
						.where("status.capture_state", "=", "active"),
				),
			),
		)
		.orderBy("collection.slug", "asc")
		.limit(1)
		.executeTakeFirst();
	return row ?? null;
}

async function finalizeActivation(
	db: Kysely<Database>,
	leaseToken: string,
	collectionCursor: string | null,
): Promise<boolean> {
	const now = timestampOffset(db, 0);
	const result = await db
		.updateTable("_emdash_media_usage_activation")
		.set({
			state: "active",
			collection_cursor: collectionCursor,
			lease_token: null,
			lease_expires_at: null,
			last_error_code: null,
			activated_at: now,
			updated_at: now,
		})
		.where("task_key", "=", ACTIVATION_KEY)
		.where("state", "=", "activating")
		.where("runtime_generation", "=", MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION)
		.where("lease_token", "=", leaseToken)
		.where("lease_expires_at", "is not", null)
		.where(timestampIsLive(db, "lease_expires_at"))
		.where(
			sql<boolean>`NOT EXISTS (
				SELECT 1
				FROM _emdash_collections AS collection
				WHERE NOT EXISTS (
					SELECT 1
					FROM _emdash_media_usage_index_status AS status
					WHERE status.adapter_id = 'content-media'
						AND status.scope_type = 'collection'
						AND status.scope_key = collection.slug
						AND status.collection_id = collection.id
						AND status.capture_state = 'active'
				)
			)`,
		)
		.executeTakeFirst();
	return Number(result.numUpdatedRows ?? 0) > 0;
}

async function recordActivationFailure(db: Kysely<Database>, leaseToken: string): Promise<void> {
	await db
		.updateTable("_emdash_media_usage_activation")
		.set({
			lease_token: null,
			lease_expires_at: null,
			last_error_code: ACTIVATION_ERROR_CODE,
			updated_at: timestampOffset(db, 0),
		})
		.where("task_key", "=", ACTIVATION_KEY)
		.where("state", "=", "activating")
		.where("runtime_generation", "=", MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION)
		.where("lease_token", "=", leaseToken)
		.execute();
}

function activeActivationLease(db: Kysely<Database>, leaseToken: string): RawBuilder<boolean> {
	return sql<boolean>`EXISTS (
		SELECT 1
		FROM _emdash_media_usage_activation AS activation
		WHERE activation.task_key = ${ACTIVATION_KEY}
			AND activation.state = 'activating'
			AND activation.runtime_generation = ${MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION}
			AND activation.lease_token = ${leaseToken}
			AND activation.lease_expires_at IS NOT NULL
			AND ${timestampIsLive(db, "activation.lease_expires_at")}
	)`;
}

function timestampIsDue(db: Kysely<Database>, column: string): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`${sql.ref(column)}::timestamptz <= clock_timestamp()`
		: sql<boolean>`${sql.ref(column)} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampIsLive(db: Kysely<Database>, column: string): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`${sql.ref(column)}::timestamptz > clock_timestamp()`
		: sql<boolean>`${sql.ref(column)} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampOffset(db: Kysely<Database>, seconds: number): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql<string>`to_char(
			clock_timestamp() AT TIME ZONE 'UTC' + (${seconds} * interval '1 second'),
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		)`;
	}
	return sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`+${seconds} seconds`})`;
}
