import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCoreMigrationIdentity } from "../../../src/migrations/identity.js";
import { buildMigrationManifest } from "../../../src/migrations/manifest-builder.js";
import {
	MIGRATION_MANIFEST_PATH,
	writeMigrationManifest,
} from "../../../src/migrations/manifest-writer.js";

describe("writeMigrationManifest", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	async function createManifest() {
		return buildMigrationManifest({
			identity: await createCoreMigrationIdentity("1.2.3", ["001_initial"]),
			i18n: null,
			database: {
				type: "sqlite",
				entrypoint: "emdash/db/sqlite",
				config: {},
				migrations: {
					entrypoint: "emdash/db/sqlite-migrations",
					manifestConfig: { url: "file:./data.db" },
				},
			},
		});
	}

	it("creates .emdash and atomically writes the validated manifest", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "emdash-manifest-writer-"));
		tempDirs.push(projectRoot);
		const manifest = await createManifest();

		const outputPath = await writeMigrationManifest(projectRoot, manifest);

		expect(outputPath).toBe(join(projectRoot, MIGRATION_MANIFEST_PATH));
		expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(manifest);
	});

	it("preserves the previous manifest and cleans up its temp file when rename fails", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "emdash-manifest-writer-failure-"));
		tempDirs.push(projectRoot);
		const manifest = await createManifest();
		const outputPath = join(projectRoot, MIGRATION_MANIFEST_PATH);
		await mkdir(join(projectRoot, ".emdash"), { recursive: true });
		const previousManifest = `${JSON.stringify({ ...manifest, i18n: { defaultLocale: "en", locales: ["en"] } })}\n`;
		await writeFile(outputPath, previousManifest, "utf8");
		let temporaryPath: string | undefined;

		await expect(
			writeMigrationManifest(projectRoot, manifest, {
				mkdir,
				async writeFile(path, data, options) {
					temporaryPath = path;
					await writeFile(path, data, options);
				},
				async rename() {
					throw new Error("simulated interruption");
				},
				unlink,
			}),
		).rejects.toThrow("simulated interruption");

		expect(await readFile(outputPath, "utf8")).toBe(previousManifest);
		expect(temporaryPath).toBeDefined();
		expect(temporaryPath).toMatch(
			new RegExp(`^${join(projectRoot, ".emdash", ".migrations.json.").replaceAll(".", "\\.")}`),
		);
		await expect(access(temporaryPath!)).rejects.toThrow();
	});
});
