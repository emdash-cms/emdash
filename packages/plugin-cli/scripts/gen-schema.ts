/**
 * Generate the JSON Schema for `emdash-plugin.jsonc` from the Zod source
 * of truth in `src/manifest/schema.ts`.
 *
 * Run via `pnpm gen-schema` (wired into `build`). The output is committed
 * to `schemas/emdash-plugin.schema.json` and shipped in the package's
 * `files` array so users can reference it via:
 *
 *     "$schema": "./node_modules/@emdash-cms/registry-cli/schemas/emdash-plugin.schema.json"
 *
 * Drift between the Zod schema and the committed JSON Schema is caught
 * by the snapshot test in `tests/schema.test.ts`.
 *
 * Why a separate script rather than emitting on build:
 *
 *   - The schema is part of the package's user-facing surface; checking
 *     it into git makes diffs visible in PR review (a field rename in
 *     Zod produces a tracked diff in the JSON Schema too).
 *   - Tests can run without first building. The schema file exists
 *     at-rest; the test compares Zod's current output to it.
 *
 * Runs under Node's native TypeScript stripping (Node 22+). No `tsx` or
 * `ts-node` dependency.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { ManifestSchema } from "../src/manifest/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "..", "schemas", "emdash-plugin.schema.json");

// zod 4's native JSON Schema emitter. `target: "draft-2020-12"` is what
// every modern JSON Schema editor (VS Code's built-in schema store,
// IntelliJ's JSON LSP) supports out of the box.
const jsonSchema = z.toJSONSchema(ManifestSchema, {
	target: "draft-2020-12",
	// Use full reuse rather than inline-everything: smaller file, easier
	// diffs when a single subschema changes.
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

const serialised = `${JSON.stringify(document, null, "\t")}\n`;

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, serialised, "utf8");
process.stdout.write(`Wrote ${OUT_PATH}\n`);
