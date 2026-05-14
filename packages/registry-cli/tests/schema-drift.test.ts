/**
 * Guard against drift between the Zod source of truth and the committed
 * JSON Schema at `schemas/emdash-plugin.schema.json`.
 *
 * The committed JSON Schema is shipped to users via
 * `node_modules/@emdash-cms/registry-cli/schemas/emdash-plugin.schema.json`
 * so editors can offer completion and validation without running our CLI.
 * If a contributor changes the Zod schema and forgets to regenerate, this
 * test fails with a clear "run pnpm gen-schema" instruction.
 *
 * We assert byte-for-byte equality after re-running the same `toJSONSchema`
 * call the generator script uses. The generator's wrapping fields (`$id`,
 * `title`, `description`) are added on top so we replicate them here.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ManifestSchema } from "../src/manifest/schema.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const COMMITTED_SCHEMA_PATH = resolve(HERE, "..", "schemas", "emdash-plugin.schema.json");

describe("JSON Schema drift", () => {
	it("matches the output of z.toJSONSchema(ManifestSchema)", async () => {
		const committed = await readFile(COMMITTED_SCHEMA_PATH, "utf8");

		// Reproduce the generator script's emit. If this diverges from
		// `scripts/gen-schema.ts`, update both (the script is the
		// canonical version users run; this is its mirror).
		const jsonSchema = z.toJSONSchema(ManifestSchema, {
			target: "draft-2020-12",
			reused: "ref",
		});
		const document = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: "https://emdashcms.com/schemas/emdash-plugin.schema.json",
			title: "EmDash plugin manifest (emdash-plugin.jsonc)",
			description:
				"Authoring format for publishing plugins to the EmDash plugin registry. Translated to the on-wire atproto record format at publish time. See https://github.com/emdash-cms/emdash/issues/1028.",
			...jsonSchema,
		};
		const regenerated = `${JSON.stringify(document, null, "\t")}\n`;

		// On failure, the diff is enormous and unreadable. Surface a
		// pointer to the fix command instead.
		if (committed !== regenerated) {
			throw new Error(
				"schemas/emdash-plugin.schema.json is out of date with the Zod schema.\n" +
					"Run: pnpm --filter @emdash-cms/registry-cli gen-schema\n" +
					"Then commit the result.",
			);
		}
		expect(committed).toBe(regenerated);
	});
});
