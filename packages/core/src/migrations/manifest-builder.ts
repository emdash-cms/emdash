import type { DatabaseDescriptor } from "../db/adapters.js";
import type { I18nConfig } from "../i18n/config.js";
import type { CoreMigrationIdentity } from "./identity.js";
import { fingerprintMigrationSet } from "./identity.js";
import type { MigrationManifestV1 } from "./manifest.js";
import { MigrationManifestValidationError, validateMigrationManifest } from "./manifest.js";

export type ManifestDatabaseDescriptor = Pick<DatabaseDescriptor, "type" | "migrations">;

export interface BuildMigrationManifestOptions {
	identity: CoreMigrationIdentity;
	i18n: I18nConfig | null;
	database: ManifestDatabaseDescriptor;
}

export class UnsupportedMigrationAdapterError extends Error {
	constructor() {
		super("The configured database adapter does not provide a deployment migration executor");
		this.name = "UnsupportedMigrationAdapterError";
	}
}

export async function buildMigrationManifest({
	identity,
	i18n,
	database,
}: BuildMigrationManifestOptions): Promise<MigrationManifestV1> {
	const identityFingerprint = await fingerprintMigrationSet(identity.emdashVersion, identity.names);
	if (identityFingerprint !== identity.fingerprint) {
		throw new MigrationManifestValidationError(
			"loaded identity fingerprint does not match its version and ordered names",
		);
	}
	if (!database.migrations) {
		throw new UnsupportedMigrationAdapterError();
	}

	return validateMigrationManifest(
		{
			schemaVersion: 1,
			emdashVersion: identity.emdashVersion,
			migrationSet: {
				names: [...identity.names],
				fingerprint: identity.fingerprint,
			},
			i18n,
			database: {
				type: database.type,
				executorEntrypoint: database.migrations.entrypoint,
				executorConfig: database.migrations.manifestConfig,
			},
		},
		identity,
	);
}
