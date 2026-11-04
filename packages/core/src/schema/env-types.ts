import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { expandCollectionBlockFields } from "./block-values.js";
import { SchemaRegistry } from "./registry.js";
import { generateSchemaHash, generateTypesFile } from "./zod-generator.js";

async function safeListCollections(registry: SchemaRegistry) {
	try {
		return await registry.listCollections();
	} catch (error) {
		// Handle missing tables for new sites that haven't run setup yet
		if (error instanceof Error && error.message.includes("no such table")) {
			return [];
		}
		throw error;
	}
}

/**
 * Generate the `emdash-env.d.ts` content for the schema stored in `db`.
 */
export async function generateEnvTypes(db: Kysely<Database>) {
	const registry = new SchemaRegistry(db);
	const collections = await safeListCollections(registry);
	const collectionsWithFields = await Promise.all(
		collections.map(async (c) => {
			const fields = await registry.listFields(c.id);
			return expandCollectionBlockFields(db, { ...c, fields });
		}),
	);

	const types = generateTypesFile(collectionsWithFields);
	const hash: string = await generateSchemaHash(collectionsWithFields);

	return { types, hash, collections: collections.length };
}
