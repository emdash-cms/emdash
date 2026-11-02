/**
 * Offline `emdash-env.d.ts` generation for a project directory.
 *
 * Reproduces what a fresh `astro dev` run writes: migrate an empty database,
 * apply the project's seed, and generate types from the resulting schema.
 * Used by `scripts/env-types.mjs` to keep committed files in the repo current.
 */

import { generateSeedModule } from "../astro/integration/virtual-modules.js";
import { createDatabase } from "../database/connection.js";
import { runMigrations } from "../database/migrations/runner.js";
import { applySeed } from "../seed/apply.js";
import type { SeedFile } from "../seed/types.js";
import { validateSeed } from "../seed/validate.js";
import { generateEnvTypes } from "./env-types.js";

async function loadProjectSeed(projectRoot: string): Promise<SeedFile> {
	const source = generateSeedModule(projectRoot);
	const mod: { seed: SeedFile } = await import(
		/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`
	);
	return mod.seed;
}

export async function generateProjectEnvTypes(projectRoot: string): Promise<string> {
	const seed = await loadProjectSeed(projectRoot);
	const { errors } = validateSeed(seed);
	if (errors.length > 0) {
		throw new Error(`Invalid seed in ${projectRoot}:\n  ${errors.join("\n  ")}`);
	}

	const db = createDatabase({ url: ":memory:" });
	try {
		await runMigrations(db);
		await applySeed(db, seed, { includeContent: false, onConflict: "skip" });
		const { types } = await generateEnvTypes(db);
		return types;
	} finally {
		await db.destroy();
	}
}
