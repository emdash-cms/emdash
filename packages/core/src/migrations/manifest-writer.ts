import { randomUUID } from "node:crypto";
import {
	mkdir as nodeMkdir,
	rename as nodeRename,
	unlink as nodeUnlink,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { MigrationManifestV1 } from "./manifest.js";
import { serializeMigrationManifest, validateMigrationManifest } from "./manifest.js";

export const MIGRATION_MANIFEST_PATH = ".emdash/migrations.json";

export interface ManifestWriterFileSystem {
	mkdir(path: string, options: { recursive: true }): Promise<unknown>;
	writeFile(
		path: string,
		data: string,
		options: { encoding: "utf8"; flag: "wx" },
	): Promise<unknown>;
	rename(from: string, to: string): Promise<unknown>;
	unlink(path: string): Promise<unknown>;
}

const nodeFileSystem: ManifestWriterFileSystem = {
	mkdir: (path, options) => nodeMkdir(path, options),
	writeFile: (path, data, options) => nodeWriteFile(path, data, options),
	rename: (from, to) => nodeRename(from, to),
	unlink: (path) => nodeUnlink(path),
};

export async function writeMigrationManifest(
	projectRoot: string,
	manifest: MigrationManifestV1,
	fileSystem: ManifestWriterFileSystem = nodeFileSystem,
): Promise<string> {
	const validated = await validateMigrationManifest(manifest);
	const outputPath = join(projectRoot, MIGRATION_MANIFEST_PATH);
	const outputDirectory = dirname(outputPath);
	await fileSystem.mkdir(outputDirectory, { recursive: true });

	const temporaryPath = join(
		outputDirectory,
		`.migrations.json.${process.pid}.${randomUUID()}.tmp`,
	);
	let temporaryFileMayExist = false;
	try {
		temporaryFileMayExist = true;
		await fileSystem.writeFile(temporaryPath, serializeMigrationManifest(validated), {
			encoding: "utf8",
			flag: "wx",
		});
		await fileSystem.rename(temporaryPath, outputPath);
		temporaryFileMayExist = false;
		return outputPath;
	} catch (error) {
		if (temporaryFileMayExist) {
			await fileSystem.unlink(temporaryPath).catch(() => undefined);
		}
		throw error;
	}
}
