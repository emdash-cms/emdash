/**
 * Seed file loading
 *
 * Imports seed data from the virtual module, which embeds the user's seed file
 * (or the default seed) at Vite build time. This avoids runtime filesystem access,
 * which doesn't work in workerd/miniflare where process.cwd() returns "/".
 */

import type { SeedFile } from "./types.js";

interface SeedModule {
	seed: SeedFile;
	userSeed: SeedFile | null;
}

async function getSeedModule(): Promise<SeedModule> {
	// @ts-ignore - virtual module, only available within Vite runtime
	return import("virtual:emdash/seed") as Promise<SeedModule>;
}

/**
 * Load the seed file (user seed or default).
 */
export async function loadSeed(): Promise<SeedFile> {
	const { seed } = await getSeedModule();
	return seed;
}

export function resolveAutoSeed(
	seed: SeedFile,
	userSeed: SeedFile | null,
): { seed: SeedFile; includeContent: boolean } {
	return { seed: userSeed ?? seed, includeContent: userSeed !== null };
}

/** Load the automatic first-boot seed and whether its authored content should be applied. */
export async function loadAutoSeed(): Promise<{ seed: SeedFile; includeContent: boolean }> {
	const { seed, userSeed } = await getSeedModule();
	return resolveAutoSeed(seed, userSeed);
}

/**
 * Load the user's seed file, or null if none exists.
 */
export async function loadUserSeed(): Promise<SeedFile | null> {
	const { userSeed } = await getSeedModule();
	return userSeed ?? null;
}
