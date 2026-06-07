import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SeedFile } from "./types.js";

/**
 * Deep merge multiple SeedFile objects.
 * Arrays are concatenated, objects are recursively merged.
 */
export function deepMerge(target: any, source: any): any {
	if (Array.isArray(target) && Array.isArray(source)) {
		return [...target, ...source];
	}

	if (target !== null && typeof target === "object" && source !== null && typeof source === "object") {
		const result = { ...target };
		for (const key of Object.keys(source)) {
			if (key in target) {
				result[key] = deepMerge(target[key], source[key]);
			} else {
				result[key] = source[key];
			}
		}
		return result;
	}

	return source;
}

export function mergeSeeds(seeds: SeedFile[]): SeedFile {
	if (seeds.length === 0) {
		throw new Error("No seeds provided to merge");
	}

	return seeds.reduce((acc, curr) => deepMerge(acc, curr), {} as SeedFile);
}

export function readJsonFilesRecursivelySync(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...readJsonFilesRecursivelySync(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".json")) {
			files.push(fullPath);
		}
	}

	return files.sort();
}

export function loadSeedFromDirectorySync(dirPath: string): SeedFile {
	const files = readJsonFilesRecursivelySync(dirPath);
	if (files.length === 0) {
		throw new Error(`No .json files found in directory: ${dirPath}`);
	}

	const seeds: SeedFile[] = [];
	for (const file of files) {
		const content = readFileSync(file, "utf-8");
		try {
			seeds.push(JSON.parse(content));
		} catch (error) {
			throw new Error(`Failed to parse seed file ${file}: ${error}`);
		}
	}

	return mergeSeeds(seeds);
}
