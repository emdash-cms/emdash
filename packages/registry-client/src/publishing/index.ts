/**
 * Publishing client.
 *
 * Wraps `@atcute/client` with an authenticated session against the publisher's
 * own PDS. Used by the CLI to put profile and release records, upload bundle
 * artifacts as blobs, and read back what was just written.
 *
 * This module deliberately does NOT implement the interactive OAuth flow
 * itself. The CLI (in a separate PR / package) is responsible for:
 *   1. Driving the OAuth dance (browser-redirect with device-flow fallback,
 *      DPoP-bound tokens) via `@atcute/oauth-node-client`.
 *   2. Persisting the resulting session (the OAuth library's `StoredSession`
 *      blob) somewhere durable.
 *   3. Calling `PublishingClient.fromHandler(...)` here with a ready-built
 *      atproto fetch handler.
 *
 * The reason for the split: testing OAuth in a unit test requires either a
 * mocked PDS or a real one. Both make the tests fragile. By separating the
 * "how do I get a handler" concern from the "how do I make XRPC calls with
 * one" concern, we can unit-test the latter against `simpleFetchHandler` and
 * defer the former to a CLI-level integration test that hits a real Atmosphere
 * account.
 *
 * In practice this means a CLI flow looks like:
 *
 *   const oauth = await getOAuthClient(...);
 *   const session = await oauth.signIn(handle);   // interactive
 *   credentials.put({ did: session.did, ... });
 *   const handler = await session.handler();
 *   const publisher = PublishingClient.fromHandler(handler, session.did, session.pdsUri);
 *   await publisher.putRecord({ ... });
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
 * High-level operations against a publisher's atproto repo, scoped to the
 * registry's NSIDs.
 *
 * All methods are stateless: they do not cache, retry, or batch. Callers wanting
 * those behaviours should layer them on top.
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
	 * Put a record into the publisher's repo. Returns the AT URI and CID of
	 * the resulting record.
	 *
	 * Use this for both `package.profile` (rkey = slug) and `package.release`
	 * (rkey = slug:version) records. Validation against the registry lexicons
	 * happens via `@atcute/client`'s typed call path when callers use
	 * NSID-keyed methods on the underlying client; this generic wrapper accepts
	 * any record shape so consumers can stage records before validating them.
	 */
	async putRecord(input: {
		collection: Nsid;
		rkey: string;
		record: Record<string, unknown>;
		/**
		 * Set to `true` to error if a record at this AT URI already exists.
		 * Defaults to `false` (idempotent overwrite). FAIR's release immutability
		 * rule is enforced at the aggregator and labeller layer, not here -- the
		 * PDS will happily let you overwrite a release record, but consumers
		 * will treat any change as a takedown event.
		 */
		validate?: boolean;
	}): Promise<{ uri: string; cid: string }> {
		const data = await ok(
			this.#client.post("com.atproto.repo.putRecord", {
				input: {
					repo: this.did,
					collection: input.collection,
					rkey: input.rkey,
					record: input.record,
					validate: input.validate ?? false,
				},
			}),
		);
		return { uri: data.uri, cid: data.cid };
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
