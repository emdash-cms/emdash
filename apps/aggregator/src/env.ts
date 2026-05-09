/**
 * Worker environment bindings.
 *
 * Production wires real Cloudflare resources via wrangler.jsonc. Tests use
 * the same Env type but bind in-memory fakes from `@emdash-cms/atproto-test-utils`.
 *
 * The Env type is the dependency-injection seam for the whole aggregator:
 * any external service the code calls is reached through a binding here, and
 * tests substitute fakes by populating the test pool's miniflare bindings.
 */

import type { D1Database, DurableObjectNamespace, Queue } from "@cloudflare/workers-types";

import type { RecordsJetstreamDO } from "./records-do.js";

export interface RecordsJob {
	did: string;
	collection: string;
	rkey: string;
	operation: "create" | "update" | "delete";
	cid: string;
	/**
	 * The Jetstream-supplied (unverified) record bytes. Compared against the
	 * verified PDS copy after fetch as a Jetstream-correctness signal; the
	 * verified copy always wins.
	 */
	jetstreamRecord?: unknown;
}

export interface Env {
	DB: D1Database;
	RECORDS_QUEUE: Queue<RecordsJob>;
	RECORDS_DO: DurableObjectNamespace<RecordsJetstreamDO>;
	JETSTREAM_URL: string;
	CONSTELLATION_URL: string;
	WANTED_COLLECTIONS: string;
}
