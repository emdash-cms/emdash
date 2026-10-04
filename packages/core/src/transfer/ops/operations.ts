/**
 * Transfer operation rows: creation, lease claims, and lease-fenced state
 * writes.
 *
 * Every step of a running operation happens under a lease: `claim` is one
 * `UPDATE … WHERE lease is free … RETURNING` statement that installs a fresh
 * ULID lease token, and every later write is fenced on that token and on the
 * lease still being live. A caller that loses its lease (expiry, another
 * caller took over) gets `TRANSFER_LEASE_LOST` and must stop without writing.
 */

import { sql, type Kysely, type Selectable, type UpdateObject } from "kysely";
import { ulid } from "ulidx";

import type { Database, TransferOperationTable } from "../../database/types.js";
import {
	TransferError,
	transferErrorDetailSchema,
	type TransferErrorCode,
	type TransferErrorDetail,
} from "../errors.js";
import { bumpRunningExportWriteEpochs } from "../fence.js";
import { isSha256Digest, type Sha256Digest } from "../format/digest.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import { siteImportReceiptSchema, type SiteImportReceipt } from "../format/receipt.js";
import {
	EXECUTING_IMPORT_STATES,
	isTransferOperationKind,
	isTransferOperationState,
	PRE_EXECUTION_IMPORT_STATES,
	TERMINAL_IMPORT_STATES,
	TRANSFER_RUNTIME_GENERATION,
	transferCursorSchema,
	transferProgressSchema,
	type TransferCursor,
	type TransferOperationKind,
	type TransferOperationState,
	type TransferProgress,
} from "./states.js";
import {
	timestampIsDue,
	timestampIsLive,
	timestampIsOlderThan,
	timestampNow,
	timestampOffset,
} from "./time.js";

type OperationRow = Selectable<TransferOperationTable>;
type OperationUpdate = UpdateObject<Database, "_emdash_transfer_operations">;

export interface TransferOperation {
	id: string;
	kind: TransferOperationKind;
	state: TransferOperationState;
	stage: string | null;
	cursor: TransferCursor | null;
	progress: TransferProgress | null;
	options: unknown;
	idempotencyKey: string | null;
	packageDigest: Sha256Digest | null;
	planDigest: Sha256Digest | null;
	originSiteId: string | null;
	/**
	 * 128-bit hex secret in the operation's staging prefix. Internal only:
	 * serialize operations for clients with {@link toPublicOperation}.
	 */
	stagingSecret: string;
	receipt: SiteImportReceipt | null;
	errorCode: string | null;
	errorDetail: TransferErrorDetail | null;
	writeEpoch: number;
	attemptCount: number;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	runtimeGeneration: number;
	cancelRequestedAt: string | null;
	mutationStartedAt: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	expiresAt: string | null;
	stagingCollectedAt: string | null;
}

/**
 * An operation as it may be shown to API clients: without the staging secret
 * and lease token.
 */
export type PublicTransferOperation = Omit<TransferOperation, "stagingSecret" | "leaseToken">;

export function toPublicOperation(operation: TransferOperation): PublicTransferOperation {
	const { stagingSecret: _secret, leaseToken: _lease, ...rest } = operation;
	return rest;
}

export interface CreateTransferOperationInput {
	kind: TransferOperationKind;
	createdBy: string;
	idempotencyKey?: string;
	/** For imports, the digest of the manifest the operation was created with. */
	packageDigest?: Sha256Digest;
	originSiteId?: string;
	options?: unknown;
	/** Seconds until the operation expires if it does not finish. */
	ttlSeconds?: number;
}

export type ClaimResult =
	| { outcome: "claimed"; operation: TransferOperation; leaseToken: string }
	| { outcome: "lease_active"; operation: TransferOperation }
	| { outcome: "invalid_state"; operation: TransferOperation };

export interface OperationPatch {
	state?: TransferOperationState;
	stage?: string | null;
	cursor?: TransferCursor | null;
	progress?: TransferProgress | null;
	packageDigest?: Sha256Digest;
	planDigest?: Sha256Digest | null;
	originSiteId?: string;
	/** Record that the importer is about to write to the target (idempotent). */
	markMutationStarted?: true;
	/** Reset `expires_at` to now + this many seconds. */
	ttlSeconds?: number;
	/**
	 * Record the retryable failure of the last step on a non-terminal
	 * operation in `error_code`/`error_detail`, or clear it with null.
	 */
	retryError?: { code: TransferErrorCode; detail?: TransferErrorDetail } | null;
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function parseJson(value: string | null): unknown {
	if (value === null) return null;
	return JSON.parse(value);
}

function toOperation(row: OperationRow): TransferOperation {
	const { kind, state } = row;
	if (!isTransferOperationKind(kind) || !isTransferOperationState(state)) {
		throw new TransferError("TRANSFER_INVALID_STATE", "Unknown transfer operation kind or state");
	}
	const cursor = parseJson(row.cursor);
	const progress = parseJson(row.progress);
	const receipt = parseJson(row.receipt);
	const errorDetail = parseJson(row.error_detail);
	return {
		id: row.id,
		kind,
		state,
		stage: row.stage,
		cursor: cursor === null ? null : transferCursorSchema.parse(cursor),
		progress: progress === null ? null : transferProgressSchema.parse(progress),
		options: parseJson(row.options),
		idempotencyKey: row.idempotency_key,
		packageDigest: isSha256Digest(row.package_digest) ? row.package_digest : null,
		planDigest: isSha256Digest(row.plan_digest) ? row.plan_digest : null,
		originSiteId: row.origin_site_id,
		stagingSecret: row.staging_secret,
		receipt: receipt === null ? null : siteImportReceiptSchema.parse(receipt),
		errorCode: row.error_code,
		errorDetail: errorDetail === null ? null : transferErrorDetailSchema.parse(errorDetail),
		writeEpoch: Number(row.write_epoch),
		attemptCount: Number(row.attempt_count),
		leaseToken: row.lease_token,
		leaseExpiresAt: row.lease_expires_at,
		runtimeGeneration: Number(row.runtime_generation),
		cancelRequestedAt: row.cancel_requested_at,
		mutationStartedAt: row.mutation_started_at,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
		expiresAt: row.expires_at,
		stagingCollectedAt: row.staging_collected_at,
	};
}

export function createStagingSecret(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class TransferOperationRepository {
	constructor(private readonly db: Kysely<Database>) {}

	async get(id: string): Promise<TransferOperation | null> {
		const row = await this.db
			.selectFrom("_emdash_transfer_operations")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? toOperation(row) : null;
	}

	async require(id: string): Promise<TransferOperation> {
		const operation = await this.get(id);
		if (!operation) {
			throw new TransferError("TRANSFER_OPERATION_NOT_FOUND", "Transfer operation not found");
		}
		return operation;
	}

	/**
	 * Create an operation, or return the existing one for the same
	 * `(createdBy, kind, idempotencyKey)`. Throws
	 * `TRANSFER_IDEMPOTENCY_CONFLICT` when that key was used with a different
	 * package digest, and `TRANSFER_IMPORT_IN_PROGRESS` when another import
	 * already occupies the target.
	 */
	async create(
		input: CreateTransferOperationInput,
	): Promise<{ operation: TransferOperation; created: boolean }> {
		if (
			input.idempotencyKey !== undefined &&
			(input.idempotencyKey.length === 0 ||
				input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
		) {
			throw new TransferError("TRANSFER_IDEMPOTENCY_CONFLICT", "Invalid idempotency key");
		}

		if (input.idempotencyKey !== undefined) {
			const existing = await this.findByIdempotencyKey(input);
			if (existing) return { operation: existing, created: false };
		}

		const id = ulid();
		const inserted = await this.db
			.insertInto("_emdash_transfer_operations")
			.values({
				id,
				kind: input.kind,
				state: input.kind === "export" ? "pending" : "uploading",
				idempotency_key: input.idempotencyKey ?? null,
				package_digest: input.packageDigest ?? null,
				origin_site_id: input.originSiteId ?? null,
				options: input.options === undefined ? null : JSON.stringify(input.options),
				staging_secret: createStagingSecret(),
				runtime_generation: TRANSFER_RUNTIME_GENERATION,
				created_by: input.createdBy,
				expires_at: timestampOffset(this.db, input.ttlSeconds ?? defaultTtl(input.kind)),
				stage: null,
				cursor: null,
				progress: null,
				plan_digest: null,
				receipt: null,
				error_code: null,
				error_detail: null,
				lease_token: null,
				lease_expires_at: null,
				cancel_requested_at: null,
				mutation_started_at: null,
				completed_at: null,
				staging_collected_at: null,
			})
			.onConflict((conflict) => conflict.doNothing())
			.returningAll()
			.executeTakeFirst();
		if (inserted) return { operation: toOperation(inserted), created: true };

		if (input.idempotencyKey !== undefined) {
			const existing = await this.findByIdempotencyKey(input);
			if (existing) return { operation: existing, created: false };
		}
		throw new TransferError(
			"TRANSFER_IMPORT_IN_PROGRESS",
			"Another import is already in progress on this site",
		);
	}

	private async findByIdempotencyKey(
		input: CreateTransferOperationInput,
	): Promise<TransferOperation | null> {
		const row = await this.db
			.selectFrom("_emdash_transfer_operations")
			.selectAll()
			.where("created_by", "=", input.createdBy)
			.where("kind", "=", input.kind)
			.where("idempotency_key", "=", input.idempotencyKey ?? "")
			.executeTakeFirst();
		if (!row) return null;
		if (
			input.packageDigest !== undefined &&
			row.package_digest !== null &&
			row.package_digest !== input.packageDigest
		) {
			throw new TransferError(
				"TRANSFER_IDEMPOTENCY_CONFLICT",
				"Idempotency key was already used for a different package",
			);
		}
		return toOperation(row);
	}

	/** The import that currently occupies the target, if any. */
	async findOccupyingImport(): Promise<TransferOperation | null> {
		const row = await this.db
			.selectFrom("_emdash_transfer_operations")
			.selectAll()
			.where("kind", "=", "import")
			.where((eb) =>
				eb.or([
					eb("state", "in", [...PRE_EXECUTION_IMPORT_STATES, ...EXECUTING_IMPORT_STATES]),
					eb.and([
						eb("state", "in", ["failed", "cancelled"]),
						eb("mutation_started_at", "is not", null),
					]),
				]),
			)
			.executeTakeFirst();
		return row ? toOperation(row) : null;
	}

	/**
	 * Take the operation's lease if it is in one of `states` and no live lease
	 * exists. Throws `TRANSFER_OPERATION_NOT_FOUND`, or
	 * `TRANSFER_RUNTIME_MISMATCH` when the row was written by an incompatible
	 * runtime generation.
	 */
	async claim(
		id: string,
		states: readonly TransferOperationState[],
		options: { leaseSeconds?: number } = {},
	): Promise<ClaimResult> {
		const leaseToken = ulid();
		const now = timestampNow(this.db);
		const row = await this.db
			.updateTable("_emdash_transfer_operations")
			.set({
				lease_token: leaseToken,
				lease_expires_at: timestampOffset(
					this.db,
					options.leaseSeconds ?? TRANSFER_LIMITS.leaseSeconds,
				),
				attempt_count: sql<number>`attempt_count + 1`,
				updated_at: now,
			})
			.where("id", "=", id)
			.where("state", "in", [...states])
			.where("runtime_generation", "=", TRANSFER_RUNTIME_GENERATION)
			.where((eb) =>
				eb.or([
					eb("lease_token", "is", null),
					eb("lease_expires_at", "is", null),
					timestampIsDue(this.db, "lease_expires_at"),
				]),
			)
			.returningAll()
			.executeTakeFirst();
		if (row) return { outcome: "claimed", operation: toOperation(row), leaseToken };

		const current = await this.require(id);
		if (current.runtimeGeneration !== TRANSFER_RUNTIME_GENERATION) {
			throw new TransferError(
				"TRANSFER_RUNTIME_MISMATCH",
				"Transfer operation was created by an incompatible EmDash version",
			);
		}
		if (!states.includes(current.state)) return { outcome: "invalid_state", operation: current };
		return { outcome: "lease_active", operation: current };
	}

	/**
	 * Write state under the lease and extend it. Throws `TRANSFER_LEASE_LOST`
	 * when the lease is gone.
	 */
	async advance(id: string, leaseToken: string, patch: OperationPatch): Promise<TransferOperation> {
		return this.fencedUpdate(id, leaseToken, {
			...this.patchValues(patch),
			lease_expires_at: timestampOffset(this.db, TRANSFER_LIMITS.leaseSeconds),
		});
	}

	/** Write state and give up the lease so the next step can claim it. */
	async release(
		id: string,
		leaseToken: string,
		patch: OperationPatch = {},
	): Promise<TransferOperation> {
		return this.fencedUpdate(id, leaseToken, {
			...this.patchValues(patch),
			lease_token: null,
			lease_expires_at: null,
		});
	}

	/**
	 * Write `patch`, move to `state`, and give up the lease; when a cancel was
	 * requested while the lease was held, move to `cancelled` instead. One
	 * statement decides, so a cancel racing the release is never lost.
	 */
	async releaseUnlessCancelled(
		id: string,
		leaseToken: string,
		state: TransferOperationState,
		patch: Omit<OperationPatch, "state"> = {},
	): Promise<TransferOperation> {
		const now = timestampNow(this.db);
		return this.fencedUpdate(id, leaseToken, {
			...this.patchValues(patch),
			state: sql<string>`CASE WHEN cancel_requested_at IS NULL THEN ${state} ELSE 'cancelled' END`,
			completed_at: sql<
				string | null
			>`CASE WHEN cancel_requested_at IS NULL THEN completed_at ELSE ${now} END`,
			lease_token: null,
			lease_expires_at: null,
		});
	}

	async complete(
		id: string,
		leaseToken: string,
		result: { receipt?: SiteImportReceipt; ttlSeconds?: number; progress?: TransferProgress } = {},
	): Promise<TransferOperation> {
		return this.fencedUpdate(id, leaseToken, {
			state: "complete",
			receipt: result.receipt === undefined ? undefined : JSON.stringify(result.receipt),
			progress: result.progress === undefined ? undefined : JSON.stringify(result.progress),
			completed_at: timestampNow(this.db),
			expires_at:
				result.ttlSeconds === undefined ? undefined : timestampOffset(this.db, result.ttlSeconds),
			lease_token: null,
			lease_expires_at: null,
		});
	}

	async fail(
		id: string,
		leaseToken: string,
		error: { code: TransferErrorCode; detail?: TransferErrorDetail },
	): Promise<TransferOperation> {
		return this.fencedUpdate(id, leaseToken, {
			state: "failed",
			error_code: error.code,
			error_detail: error.detail === undefined ? null : JSON.stringify(error.detail),
			completed_at: timestampNow(this.db),
			lease_token: null,
			lease_expires_at: null,
		});
	}

	/** Finish a cancellation the lease holder observed via `cancelRequestedAt`. */
	async finishCancelled(id: string, leaseToken: string): Promise<TransferOperation> {
		return this.fencedUpdate(id, leaseToken, {
			state: "cancelled",
			completed_at: timestampNow(this.db),
			lease_token: null,
			lease_expires_at: null,
		});
	}

	/**
	 * Cancel an import. Without a live lease the operation becomes `cancelled`
	 * immediately; otherwise `cancel_requested_at` is set and the lease holder
	 * stops after its current batch. Returns the updated operation.
	 */
	async requestCancel(id: string): Promise<TransferOperation> {
		const cancellable = [...PRE_EXECUTION_IMPORT_STATES, ...EXECUTING_IMPORT_STATES];
		const now = timestampNow(this.db);
		const immediate = await this.db
			.updateTable("_emdash_transfer_operations")
			.set({
				state: "cancelled",
				cancel_requested_at: now,
				completed_at: now,
				updated_at: now,
				lease_token: null,
				lease_expires_at: null,
			})
			.where("id", "=", id)
			.where("kind", "=", "import")
			.where("state", "in", cancellable)
			.where((eb) =>
				eb.or([
					eb("lease_token", "is", null),
					eb("lease_expires_at", "is", null),
					timestampIsDue(this.db, "lease_expires_at"),
				]),
			)
			.returningAll()
			.executeTakeFirst();
		if (immediate) return toOperation(immediate);

		const flagged = await this.db
			.updateTable("_emdash_transfer_operations")
			.set({ cancel_requested_at: now, updated_at: now })
			.where("id", "=", id)
			.where("kind", "=", "import")
			.where("state", "in", cancellable)
			.returningAll()
			.executeTakeFirst();
		if (flagged) return toOperation(flagged);

		await this.require(id);
		throw new TransferError("TRANSFER_INVALID_STATE", "Transfer operation cannot be cancelled");
	}

	/**
	 * Mark a failed or cancelled import abandoned. Lifts the write fence; never
	 * deletes imported data.
	 */
	async abandon(id: string): Promise<TransferOperation> {
		const now = timestampNow(this.db);
		const row = await this.db
			.updateTable("_emdash_transfer_operations")
			.set({ state: "abandoned", updated_at: now })
			.where("id", "=", id)
			.where("kind", "=", "import")
			.where("state", "in", ["failed", "cancelled"])
			.where((eb) =>
				eb.or([
					eb("lease_token", "is", null),
					eb("lease_expires_at", "is", null),
					timestampIsDue(this.db, "lease_expires_at"),
				]),
			)
			.returningAll()
			.executeTakeFirst();
		if (row) return toOperation(row);
		await this.require(id);
		throw new TransferError(
			"TRANSFER_INVALID_STATE",
			"Only a failed or cancelled import can be abandoned",
		);
	}

	/**
	 * Move operations past their `expires_at` to `expired` (pre-execution
	 * imports and every non-expired export) when no live lease holds them.
	 * Returns the expired operations so their staging can be collected.
	 */
	async expireDue(
		limit = 50,
	): Promise<Array<Pick<TransferOperation, "id" | "kind" | "stagingSecret">>> {
		const candidates = await this.db
			.selectFrom("_emdash_transfer_operations")
			.select("id")
			.where("expires_at", "is not", null)
			.where(timestampIsDue(this.db, "expires_at"))
			.where((eb) =>
				eb.or([
					eb.and([
						eb("kind", "=", "import"),
						eb("state", "in", [...PRE_EXECUTION_IMPORT_STATES]),
						eb("mutation_started_at", "is", null),
					]),
					eb.and([
						eb("kind", "=", "export"),
						eb("state", "in", ["pending", "running", "complete", "failed"]),
					]),
				]),
			)
			.where((eb) =>
				eb.or([
					eb("lease_token", "is", null),
					eb("lease_expires_at", "is", null),
					timestampIsDue(this.db, "lease_expires_at"),
				]),
			)
			.orderBy("expires_at")
			.limit(limit)
			.execute();
		if (candidates.length === 0) return [];
		const now = timestampNow(this.db);
		const rows = await this.db
			.updateTable("_emdash_transfer_operations")
			.set({ state: "expired", updated_at: now, lease_token: null, lease_expires_at: null })
			.where(
				"id",
				"in",
				candidates.map((candidate) => candidate.id),
			)
			.where(timestampIsDue(this.db, "expires_at"))
			.where((eb) =>
				eb.or([
					eb.and([
						eb("kind", "=", "import"),
						eb("state", "in", [...PRE_EXECUTION_IMPORT_STATES]),
						eb("mutation_started_at", "is", null),
					]),
					eb.and([
						eb("kind", "=", "export"),
						eb("state", "in", ["pending", "running", "complete", "failed"]),
					]),
				]),
			)
			.returning(["id", "kind", "staging_secret"])
			.execute();
		return rows.flatMap((row) =>
			isTransferOperationKind(row.kind)
				? [{ id: row.id, kind: row.kind, stagingSecret: row.staging_secret }]
				: [],
		);
	}

	/**
	 * Operations whose staging area can be collected and has not been yet:
	 * imports in a terminal state, and exports that failed or expired
	 * (complete exports stay downloadable until they expire). Oldest first.
	 * A collector deletes staged objects with `TransferStage.deleteSome` until
	 * it returns 0, deletes child rows with {@link deleteChildRows} until it
	 * returns 0, then calls {@link markCollected}; a crash anywhere in between
	 * leaves the operation listed here, so collection resumes.
	 *
	 * `importRetentionSeconds` keeps a finished import's staging for that long
	 * after its last state change; expired imports are listed at once.
	 */
	async listUncollected(
		limit = 20,
		options: { importRetentionSeconds?: number } = {},
	): Promise<Array<Pick<TransferOperation, "id" | "kind" | "state" | "stagingSecret">>> {
		const retention = options.importRetentionSeconds ?? 0;
		const retainedStates = TERMINAL_IMPORT_STATES.filter((state) => state !== "expired");
		const rows = await this.db
			.selectFrom("_emdash_transfer_operations")
			.select(["id", "kind", "state", "staging_secret"])
			.where("staging_collected_at", "is", null)
			.where((eb) =>
				eb.or([
					eb.and([eb("kind", "=", "import"), eb("state", "=", "expired")]),
					eb.and([
						eb("kind", "=", "import"),
						eb("state", "in", retainedStates),
						timestampIsOlderThan(this.db, "updated_at", retention),
					]),
					eb.and([eb("kind", "=", "export"), eb("state", "in", ["failed", "expired"])]),
				]),
			)
			.where((eb) =>
				eb.or([
					eb("lease_token", "is", null),
					eb("lease_expires_at", "is", null),
					timestampIsDue(this.db, "lease_expires_at"),
				]),
			)
			.orderBy("updated_at")
			.orderBy("id")
			.limit(Math.min(Math.max(limit, 1), 100))
			.execute();
		return rows.flatMap((row) =>
			isTransferOperationKind(row.kind) && isTransferOperationState(row.state)
				? [{ id: row.id, kind: row.kind, state: row.state, stagingSecret: row.staging_secret }]
				: [],
		);
	}

	/** Record that an operation's staging area and child rows are gone. */
	async markCollected(id: string): Promise<void> {
		await this.db
			.updateTable("_emdash_transfer_operations")
			.set({ staging_collected_at: timestampNow(this.db) })
			.where("id", "=", id)
			.where("staging_collected_at", "is", null)
			.execute();
	}

	/**
	 * Delete up to `limit` child rows of each child table of an operation
	 * (staged files, package index, media blobs), one bounded statement per
	 * table. Returns the number deleted; call until it returns 0. Always drain
	 * children this way before deleting an operation row: an `ON DELETE
	 * CASCADE` over millions of child rows in one statement exceeds D1's
	 * limits.
	 */
	async deleteChildRows(operationId: string, limit = 500): Promise<number> {
		const bounded = Math.min(Math.max(Math.trunc(limit), 1), 5000);
		const staged = await sql`
			DELETE FROM _emdash_transfer_staged_files
			WHERE operation_id = ${operationId}
				AND path IN (
					SELECT path FROM _emdash_transfer_staged_files
					WHERE operation_id = ${operationId}
					LIMIT ${bounded}
				)
		`.execute(this.db);
		const indexed = await sql`
			DELETE FROM _emdash_transfer_package_index
			WHERE operation_id = ${operationId}
				AND (kind, id) IN (
					SELECT kind, id FROM _emdash_transfer_package_index
					WHERE operation_id = ${operationId}
					LIMIT ${bounded}
				)
		`.execute(this.db);
		const blobs = await sql`
			DELETE FROM _emdash_transfer_media_blobs
			WHERE operation_id = ${operationId}
				AND media_id IN (
					SELECT media_id FROM _emdash_transfer_media_blobs
					WHERE operation_id = ${operationId}
					LIMIT ${bounded}
				)
		`.execute(this.db);
		return [staged, indexed, blobs].reduce(
			(sum, result) => sum + Number(result.numAffectedRows ?? 0n),
			0,
		);
	}

	/**
	 * Delete a collected operation row once it has no child rows left.
	 * Returns false, deleting nothing, otherwise. Identity-map rows are kept.
	 */
	async deleteIfChildless(id: string): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_emdash_transfer_operations")
			.where("id", "=", id)
			.where("staging_collected_at", "is not", null)
			.where((eb) =>
				eb.and([
					eb.not(
						eb.exists(
							eb
								.selectFrom("_emdash_transfer_staged_files")
								.select("path")
								.where("_emdash_transfer_staged_files.operation_id", "=", id),
						),
					),
					eb.not(
						eb.exists(
							eb
								.selectFrom("_emdash_transfer_package_index")
								.select("kind")
								.where("_emdash_transfer_package_index.operation_id", "=", id),
						),
					),
					eb.not(
						eb.exists(
							eb
								.selectFrom("_emdash_transfer_media_blobs")
								.select("media_id")
								.where("_emdash_transfer_media_blobs.operation_id", "=", id),
						),
					),
				]),
			)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0n) > 0;
	}

	/**
	 * Bump `write_epoch` on every running export. Fenced write paths call this
	 * so an export's consistency fence notices writes to tables that have no
	 * `updated_at`. Returns the number of exports touched.
	 */
	async recordWriteForRunningExports(): Promise<number> {
		return bumpRunningExportWriteEpochs(this.db);
	}

	/** Operations newest first, `{ items, nextCursor }` over `(created_at, id)`. */
	async list(
		options: {
			kind?: TransferOperationKind;
			createdBy?: string;
			limit?: number;
			cursor?: { createdAt: string; id: string };
		} = {},
	): Promise<{ items: PublicTransferOperation[]; next?: { createdAt: string; id: string } }> {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
		let query = this.db.selectFrom("_emdash_transfer_operations").selectAll();
		if (options.kind) query = query.where("kind", "=", options.kind);
		if (options.createdBy) query = query.where("created_by", "=", options.createdBy);
		const cursor = options.cursor;
		if (cursor) {
			query = query.where((eb) =>
				eb.or([
					eb("created_at", "<", cursor.createdAt),
					eb.and([eb("created_at", "=", cursor.createdAt), eb("id", "<", cursor.id)]),
				]),
			);
		}
		const rows = await query
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1)
			.execute();
		const items = rows.slice(0, limit).map((row) => toPublicOperation(toOperation(row)));
		const last = items.at(-1);
		return rows.length > limit && last
			? { items, next: { createdAt: last.createdAt, id: last.id } }
			: { items };
	}

	private patchValues(patch: OperationPatch): OperationUpdate {
		const values: OperationUpdate = {};
		if (patch.state !== undefined) values.state = patch.state;
		if (patch.stage !== undefined) values.stage = patch.stage;
		if (patch.cursor !== undefined) {
			values.cursor =
				patch.cursor === null ? null : JSON.stringify(transferCursorSchema.parse(patch.cursor));
		}
		if (patch.progress !== undefined) {
			values.progress =
				patch.progress === null
					? null
					: JSON.stringify(transferProgressSchema.parse(patch.progress));
		}
		if (patch.packageDigest !== undefined) values.package_digest = patch.packageDigest;
		if (patch.planDigest !== undefined) values.plan_digest = patch.planDigest;
		if (patch.originSiteId !== undefined) values.origin_site_id = patch.originSiteId;
		if (patch.markMutationStarted) {
			values.mutation_started_at = sql<string>`COALESCE(mutation_started_at, ${timestampNow(this.db)})`;
		}
		if (patch.ttlSeconds !== undefined)
			values.expires_at = timestampOffset(this.db, patch.ttlSeconds);
		if (patch.retryError !== undefined) {
			values.error_code = patch.retryError?.code ?? null;
			values.error_detail =
				patch.retryError?.detail === undefined ? null : JSON.stringify(patch.retryError.detail);
		}
		return values;
	}

	private async fencedUpdate(
		id: string,
		leaseToken: string,
		values: OperationUpdate,
	): Promise<TransferOperation> {
		const row = await this.db
			.updateTable("_emdash_transfer_operations")
			.set({ ...values, updated_at: timestampNow(this.db) })
			.where("id", "=", id)
			.where("lease_token", "=", leaseToken)
			.where("lease_expires_at", "is not", null)
			.where(timestampIsLive(this.db, "lease_expires_at"))
			.returningAll()
			.executeTakeFirst();
		if (!row) {
			throw new TransferError("TRANSFER_LEASE_LOST", "Transfer operation lease was lost");
		}
		return toOperation(row);
	}
}

function defaultTtl(kind: TransferOperationKind): number {
	return kind === "export"
		? TRANSFER_LIMITS.exportTtlSeconds
		: TRANSFER_LIMITS.pendingImportTtlSeconds;
}
