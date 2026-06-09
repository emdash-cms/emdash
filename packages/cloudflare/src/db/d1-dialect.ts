/**
 * Shared D1 Kysely dialect with EmDash's D1-compatible introspector.
 *
 * Lives in its own module (rather than d1.ts) so the coalescing dialect in
 * coalescing-d1.ts can extend it without creating a circular import with
 * d1.ts, and without pulling cloudflare:workers into test environments.
 */

import { type DatabaseIntrospector, type Kysely, SqliteAdapter } from "kysely";
import { D1Dialect } from "kysely-d1";

import { D1Introspector } from "./d1-introspector.js";

const D1_ADAPTER_MARKER = Symbol.for("emdash:d1-adapter");

/**
 * Custom D1 Dialect that uses our D1-compatible introspector
 *
 * The default kysely-d1 dialect uses SqliteIntrospector which does a
 * cross-join with pragma_table_info() that D1 doesn't allow.
 */
export class EmDashD1Dialect extends D1Dialect {
	override createAdapter(): SqliteAdapter {
		const adapter = super.createAdapter();
		Object.defineProperty(adapter, D1_ADAPTER_MARKER, {
			value: true,
			enumerable: false,
			configurable: false,
			writable: false,
		});
		return adapter;
	}

	override createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}
