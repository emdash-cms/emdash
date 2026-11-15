import type { Kysely } from "kysely";

import { ensureShopProductFields } from "../../shop/product-fields.js";
import type { Database } from "../types.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- migrations receive an untyped Kysely instance
	await ensureShopProductFields(db as Kysely<Database>);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Product fields and content are preserved when rolling back code.
}
