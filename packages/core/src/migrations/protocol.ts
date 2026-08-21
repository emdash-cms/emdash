import type { I18nConfig } from "../i18n/config.js";

export type MigrationAction = "check" | "apply";

export interface MigrationRequest {
	action: MigrationAction;
	i18n: I18nConfig | null;
	artifact: {
		emdashVersion: string;
		migrationSetFingerprint: string;
	};
}

export interface MigrationTarget {
	kind: string;
	label: string;
	fingerprint: string;
	accountId?: string;
	environment?: string;
	resourceId?: string;
}

export interface MigrationReport {
	target: MigrationTarget;
	knownApplied: string[];
	pending: string[];
	unknownApplied: string[];
	executed: string[];
}

export interface MigrationExecutor {
	target: MigrationTarget;
	execute(request: MigrationRequest): Promise<MigrationReport>;
	dispose?(): Promise<void>;
}

export interface MigrationTargetOverrides {
	database?: string;
	databaseUrlEnv?: string;
	d1?: string;
	accountId?: string;
	wranglerConfig?: string;
	wranglerEnv?: string;
}

export interface MigrationExecutorFactoryContext {
	projectRoot: string;
	env: Readonly<Record<string, string | undefined>>;
	overrides?: Readonly<MigrationTargetOverrides>;
}

export type MigrationExecutorFactory<ManifestConfig = unknown> = (
	manifestConfig: ManifestConfig,
	context: MigrationExecutorFactoryContext,
) => MigrationExecutor | Promise<MigrationExecutor>;

export interface MigrationExecutorModule<ManifestConfig = unknown> {
	createMigrationExecutor: MigrationExecutorFactory<ManifestConfig>;
}
