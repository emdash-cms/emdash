import type { Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";

import { isPostgres } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";

const SITE_OPTION_PREFIX = "site:%";

/** Returns the canonical JSON representation of a site-settings revision fingerprint. */
export function normalizeSiteSettingsVersion(input: string): string {
	const decoded: unknown = JSON.parse(input);
	if (!Array.isArray(decoded)) throw new Error("Invalid site settings version");
	const entries: [string, string][] = [];
	for (const entry of decoded) {
		if (!Array.isArray(entry)) throw new Error("Invalid site settings version entry");
		const name: unknown = entry[0];
		const revision: unknown = entry[1];
		if (typeof name !== "string" || typeof revision !== "string") {
			throw new Error("Invalid site settings version entry");
		}
		entries.push([name, revision]);
	}
	return JSON.stringify(entries.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Builds the scalar query used to observe site-setting revisions alongside an
 * existing read. It deliberately does not read option values.
 */
export function siteSettingsVersionQuery(db: Kysely<Database>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql<string>`(
			select coalesce(
				json_agg(json_build_array(name, revision) order by name)::text,
				'[]'
			)
			from options
			where name like ${SITE_OPTION_PREFIX}
		)`;
	}

	return sql<string>`(
		select coalesce(
			json_group_array(json_array(name, revision)),
			'[]'
		)
		from (
			select name, revision
			from options
			where name glob ${"site:*"}
			order by name
		)
	)`;
}
