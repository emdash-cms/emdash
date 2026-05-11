/**
 * Publishing client.
 *
 * Wraps `@atcute/client` with an authenticated session against the publisher's
 * own PDS. Used by the CLI to put profile and release records and to read back
 * what was just written.
 *
 * This module deliberately does NOT implement the interactive OAuth flow
 * itself. Callers (the CLI in `@emdash-cms/registry-cli`) are responsible for:
 *   1. Driving the OAuth dance (browser-redirect with device-flow fallback,
 *      DPoP-bound tokens) via `@atcute/oauth-node-client`.
 *   2. Persisting the resulting session somewhere durable.
 *   3. Calling `PublishingClient.fromHandler(...)` here with a ready-built
 *      atproto fetch handler.
 *
 * Lexicon validation
 * ------------------
 *
 * Every write defaults to `validate: true`. The PDS will reject records that
 * don't match the lexicon for their collection. Callers can opt out via
 * `validate: false` for the rare case where they're writing records the PDS
 * doesn't know about, but the default is to use the lexicons we've spent
 * effort defining.
 *
 * Typed writes
 * ------------
 *
 * `putRecord` is generic over the registry's `RegistryRecords` map: the
 * `record` argument's TypeScript shape is derived from the collection NSID,
 * so writing a `package.profile` with the wrong fields fails at compile time.
 * Use `unsafePutRecord` if you really need to put an opaque payload.
 *
 * Atomic batches
 * --------------
 *
 * `applyWrites` performs multiple operations in a single atproto commit. We
 * use it for the publish flow's profile-bootstrap + release-create pair so
 * a network blip between the two writes can't leave a half-published state.
 */

// Type-only import: pulls in the `declare module "@atcute/lexicons/ambient"`
// blocks from `@atcute/atproto`'s generated type modules so the typed
// `client.get/post` calls below see overloads for `com.atproto.repo.*`. We use
// the empty named-import form (`type {}`) so this stays types-only and adds no
// runtime cost; oxlint's `no-empty-named-blocks` rule doesn't recognise this
// pattern, hence the disable.
// eslint-disable-next-line @typescript-eslint/no-empty-named-blocks, eslint-plugin-import/no-empty-named-blocks, eslint-plugin-unicorn/require-module-specifiers, import/no-empty-named-blocks, unicorn/require-module-specifiers
import type {} from "@atcute/atproto";
import { Client, type FetchHandler, type FetchHandlerObject, ok } from "@atcute/client";
import type { Nsid } from "@atcute/lexicons";
import type { RegistryRecordCollection, RegistryRecords } from "@emdash-cms/registry-lexicons";

import type { Did } from "../credentials/types.js";

/**
 * Options accepted by `PublishingClient.fromHandler`.
 */
export interface PublishingClientFromHandlerOptions {
	/**
	 * The atproto fetch handler. Typically this is the handler returned by an
	 * authenticated `@atcute/oauth-node-client` session.
	 */
	handler: FetchHandler | FetchHandlerObject;

	/** Publisher DID. The repo we operate on. */
	did: Did;

	/**
	 * PDS endpoint. Used informationally (e.g. logging "publishing to <pds>");
	 * the actual routing comes from the handler.
	 */
	pds: string;
}

/**
 * Single create operation in an `applyWrites` batch.
 */
export interface PublishCreate<C extends RegistryRecordCollection = RegistryRecordCollection> {
	op: "create";
	collection: C;
	rkey: string;
	record: RegistryRecords[C];
}

/**
 * Single update operation in an `applyWrites` batch.
 */
export interface PublishUpdate<C extends RegistryRecordCollection = RegistryRecordCollection> {
	op: "update";
	collection: C;
	rkey: string;
	record: RegistryRecords[C];
}

/**
 * Single delete operation in an `applyWrites` batch.
 */
export interface PublishDelete {
	op: "delete";
	collection: Nsid;
	rkey: string;
}

export type PublishOperation = PublishCreate | PublishUpdate | PublishDelete;

export interface ApplyWritesResult {
	/** Per-operation results, in input order. */
	results: Array<
		| { op: "create"; uri: string; cid: string }
		| { op: "update"; uri: string; cid: string }
		| { op: "delete" }
	>;
}

/**
 * High-level operations against a publisher's atproto repo, scoped to the
 * registry's NSIDs.
 *
 * All methods are stateless: they do not cache, retry, or batch. Callers
 * wanting those behaviours should layer them on top.
 */
export class PublishingClient {
	readonly did: Did;
	readonly pds: string;
	readonly #client: Client;

	private constructor(client: Client, did: Did, pds: string) {
		this.#client = client;
		this.did = did;
		this.pds = pds;
	}

	/**
	 * Build a publishing client from a pre-authenticated atproto fetch handler.
	 * This is the preferred constructor: the CLI builds the handler via OAuth
	 * and hands it in.
	 */
	static fromHandler(options: PublishingClientFromHandlerOptions): PublishingClient {
		const client = new Client({ handler: options.handler });
		return new PublishingClient(client, options.did, options.pds);
	}

	/**
	 * Put a typed registry record into the publisher's repo. The record's TS
	 * shape is derived from the collection NSID so callers can't put a
	 * profile-shaped record into a release collection (or vice versa).
	 *
	 * Defaults to `validate: true` -- the PDS will reject records that don't
	 * match the lexicon for the collection. The `unsafePutRecord` escape hatch
	 * exists for when you really need to bypass.
	 */
	async putRecord<C extends RegistryRecordCollection>(input: {
		collection: C;
		rkey: string;
		record: RegistryRecords[C];
		/**
		 * Skip lexicon validation server-side. Defaults to `false` (validation
		 * is on). Setting `true` is almost always wrong; only do it when you
		 * deliberately want to publish a record the PDS doesn't yet know how to
		 * validate (e.g. during a lexicon migration window).
		 */
		skipValidation?: boolean;
	}): Promise<{ uri: string; cid: string }> {
		return this.#putRecord({
			collection: input.collection,
			rkey: input.rkey,
			record: input.record as Record<string, unknown>,
			skipValidation: input.skipValidation ?? false,
		});
	}

	/**
	 * Untyped escape hatch for putting any record into any collection. Bypasses
	 * the `RegistryRecords` map type-check; lexicon validation server-side is
	 * still on by default. Use this only when you really must (e.g. tools that
	 * deal in opaque records like `com.atproto.*`).
	 */
	async unsafePutRecord(input: {
		collection: Nsid;
		rkey: string;
		record: Record<string, unknown>;
		skipValidation?: boolean;
	}): Promise<{ uri: string; cid: string }> {
		return this.#putRecord({ ...input, skipValidation: input.skipValidation ?? false });
	}

	async #putRecord(input: {
		collection: Nsid;
		rkey: string;
		record: Record<string, unknown>;
		skipValidation: boolean;
	}): Promise<{ uri: string; cid: string }> {
		const data = await ok(
			this.#client.post("com.atproto.repo.putRecord", {
				input: {
					repo: this.did,
					collection: input.collection,
					rkey: input.rkey,
					record: input.record,
					validate: !input.skipValidation,
				},
			}),
		);
		return { uri: data.uri, cid: data.cid };
	}

	/**
	 * Apply a batch of create/update/delete operations atomically against the
	 * publisher's repo. Either every operation succeeds (single commit, single
	 * firehose event) or none do.
	 *
	 * Used by the publish flow to bootstrap a profile and put a release in a
	 * single round-trip, so a network blip between the two writes can't leave
	 * a half-published state.
	 *
	 * Defaults to `validate: true`. Pass `skipValidation: true` to opt out;
	 * see `putRecord` for the rationale.
	 */
	async applyWrites(input: {
		writes: PublishOperation[];
		skipValidation?: boolean;
		/**
		 * If supplied, the operation aborts unless the publisher repo's current
		 * commit matches this CID. Use to detect concurrent writers.
		 */
		swapCommit?: string;
	}): Promise<ApplyWritesResult> {
		const writes = input.writes.map((op) => {
			switch (op.op) {
				case "create":
					return {
						$type: "com.atproto.repo.applyWrites#create" as const,
						collection: op.collection as Nsid,
						rkey: op.rkey,
						value: op.record as Record<string, unknown>,
					};
				case "update":
					return {
						$type: "com.atproto.repo.applyWrites#update" as const,
						collection: op.collection as Nsid,
						rkey: op.rkey,
						value: op.record as Record<string, unknown>,
					};
				case "delete":
					return {
						$type: "com.atproto.repo.applyWrites#delete" as const,
						collection: op.collection,
						rkey: op.rkey,
					};
			}
		});

		const data = await ok(
			this.#client.post("com.atproto.repo.applyWrites", {
				input: {
					repo: this.did,
					validate: !(input.skipValidation ?? false),
					writes,
					...(input.swapCommit !== undefined ? { swapCommit: input.swapCommit } : {}),
				},
			}),
		);

		const results: ApplyWritesResult["results"] = (data.results ?? []).map((r) => {
			const $type = (r as { $type?: string }).$type;
			if ($type === "com.atproto.repo.applyWrites#createResult") {
				const cr = r as { uri: string; cid: string };
				return { op: "create", uri: cr.uri, cid: cr.cid };
			}
			if ($type === "com.atproto.repo.applyWrites#updateResult") {
				const ur = r as { uri: string; cid: string };
				return { op: "update", uri: ur.uri, cid: ur.cid };
			}
			return { op: "delete" };
		});
		return { results };
	}

	/**
	 * Fetch a record from the publisher's repo by NSID and rkey.
	 */
	async getRecord(input: {
		collection: Nsid;
		rkey: string;
	}): Promise<{ uri: string; cid: string; value: unknown }> {
		const data = await ok(
			this.#client.get("com.atproto.repo.getRecord", {
				params: {
					repo: this.did,
					collection: input.collection,
					rkey: input.rkey,
				},
			}),
		);
		return {
			uri: data.uri,
			cid: data.cid ?? "",
			value: data.value,
		};
	}

	/**
	 * List records in a collection. Returns up to `limit` records and an
	 * optional cursor for pagination.
	 */
	async listRecords(input: {
		collection: Nsid;
		limit?: number;
		cursor?: string;
		reverse?: boolean;
	}): Promise<{
		records: Array<{ uri: string; cid: string; value: unknown }>;
		cursor?: string;
	}> {
		const data = await ok(
			this.#client.get("com.atproto.repo.listRecords", {
				params: {
					repo: this.did,
					collection: input.collection,
					...(input.limit !== undefined ? { limit: input.limit } : {}),
					...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
					...(input.reverse !== undefined ? { reverse: input.reverse } : {}),
				},
			}),
		);
		return {
			records: data.records.map((r) => ({
				uri: r.uri,
				cid: r.cid,
				value: r.value,
			})),
			...(data.cursor ? { cursor: data.cursor } : {}),
		};
	}
}
