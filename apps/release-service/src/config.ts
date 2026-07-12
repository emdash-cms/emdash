export type ConfigurationBindings = Record<
	keyof Pick<Env, "PUBLIC_ORIGIN" | "ALLOWED_ORIGINS" | "ALLOWED_PUBLISHERS" | "DEPLOYMENT_POLICY">,
	string
>;

export type DeploymentPolicy = "hosted" | "self-hosted";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

interface AllowAllPublishers {
	mode: "all";
}

interface AllowlistedPublishers {
	mode: "allowlist";
	dids: ReadonlySet<string>;
}

type AllowedPublisherPolicy = AllowAllPublishers | AllowlistedPublishers;

export interface ServiceConfiguration {
	publicOrigin: string;
	allowedOrigins: ReadonlySet<string>;
	deploymentPolicy: DeploymentPolicy;
	isPublisherAllowed(did: string): boolean;
}

export class ConfigurationError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super("Invalid release-service configuration");
		this.name = "ConfigurationError";
		this.issues = issues;
	}
}

function parseOrigin(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.origin !== value) return null;
		return url.origin;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAllowedOrigins(value: string): ReadonlySet<string> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const origins = parsed.map(parseOrigin);
		if (origins.some((origin) => origin === null)) return null;
		const validOrigins = new Set<string>();
		for (const origin of origins) {
			if (origin) validOrigins.add(origin);
		}
		return validOrigins;
	} catch {
		return null;
	}
}

function parseAllowedPublishers(value: string): AllowedPublisherPolicy | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) return null;
		const record = parsed;
		if (record["mode"] === "all" && Object.keys(record).length === 1) return { mode: "all" };
		const dids = record["dids"];
		if (
			record["mode"] !== "allowlist" ||
			Object.keys(record).some((key) => key !== "mode" && key !== "dids") ||
			!Array.isArray(dids) ||
			!dids.every((did) => typeof did === "string" && DID_PATTERN.test(did))
		) {
			return null;
		}
		return { mode: "allowlist", dids: new Set(dids) };
	} catch {
		return null;
	}
}

export function loadConfiguration(bindings: ConfigurationBindings): ServiceConfiguration {
	const issues: string[] = [];
	const publicOrigin = parseOrigin(bindings.PUBLIC_ORIGIN);
	if (!publicOrigin) issues.push("PUBLIC_ORIGIN_INVALID");
	const allowedOrigins = parseAllowedOrigins(bindings.ALLOWED_ORIGINS);
	if (!allowedOrigins) issues.push("ALLOWED_ORIGINS_INVALID");
	else if (publicOrigin && !allowedOrigins.has(publicOrigin))
		issues.push("PUBLIC_ORIGIN_NOT_ALLOWED");
	const publisherPolicy = parseAllowedPublishers(bindings.ALLOWED_PUBLISHERS);
	if (!publisherPolicy) issues.push("ALLOWED_PUBLISHERS_INVALID");
	const deploymentPolicy: DeploymentPolicy | null =
		bindings.DEPLOYMENT_POLICY === "hosted" || bindings.DEPLOYMENT_POLICY === "self-hosted"
			? bindings.DEPLOYMENT_POLICY
			: null;
	if (!deploymentPolicy) {
		issues.push("DEPLOYMENT_POLICY_INVALID");
	}
	if (
		!publicOrigin ||
		!allowedOrigins ||
		!publisherPolicy ||
		!deploymentPolicy ||
		issues.length > 0
	) {
		throw new ConfigurationError(issues);
	}
	return {
		publicOrigin,
		allowedOrigins,
		deploymentPolicy,
		isPublisherAllowed: (did) => publisherPolicy.mode === "all" || publisherPolicy.dids.has(did),
	};
}
