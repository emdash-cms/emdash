import { IMAGE_PROMPT_HASH, TEXT_PROMPT_HASH } from "./ai/prompts.js";
import type { AssessmentVersionSet } from "./assessment/types.js";

const DID_WEB_HOST_RE = /^did:web:([^:]+)$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LabelerRuntimeConfig {
	labelerDid: string;
	serviceUrl: string;
	privateKey: string;
	publicKeyMultibase: string;
	versions: AssessmentVersionSet;
}

export type PublicLabelerRuntimeConfig = Omit<LabelerRuntimeConfig, "privateKey">;

export async function readLabelerRuntimeConfig(env: object): Promise<LabelerRuntimeConfig> {
	const publicConfig = readPublicLabelerRuntimeConfig(env);
	return { ...publicConfig, privateKey: await readPrivateKey(env) };
}

export function readPublicLabelerRuntimeConfig(env: object): PublicLabelerRuntimeConfig {
	const labelerDid = readString(env, "LABELER_DID");
	const serviceUrl = parseServiceUrl(readString(env, "LABELER_SERVICE_URL"));
	assertDidMatchesService(labelerDid, serviceUrl);
	const versions = readAssessmentVersions(env);
	return {
		labelerDid,
		serviceUrl,
		publicKeyMultibase: readString(env, "LABEL_SIGNING_PUBLIC_KEY"),
		versions,
	};
}

export function readAssessmentVersions(env: object): AssessmentVersionSet {
	return {
		policyVersion: readVersion(env, "LABELER_POLICY_VERSION"),
		parserVersion: readVersion(env, "LABELER_PARSER_VERSION"),
		textModelId: readModelId(env, "LABELER_TEXT_MODEL_ID"),
		textPromptHash: TEXT_PROMPT_HASH,
		imageModelId: readModelId(env, "LABELER_IMAGE_MODEL_ID"),
		imagePromptHash: IMAGE_PROMPT_HASH,
	} satisfies AssessmentVersionSet;
}

function readString(env: object, name: string): string {
	const value: unknown = Reflect.get(env, name);
	if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value;
}

function readVersion(env: object, name: string): string {
	const value = readString(env, name);
	if (!VERSION_RE.test(value)) throw new TypeError(`${name} is invalid`);
	return value;
}

function readModelId(env: object, name: string): string {
	const value = readString(env, name);
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && codePoint <= 0x20) {
			throw new TypeError(`${name} is invalid`);
		}
	}
	return value;
}

async function readPrivateKey(env: object): Promise<string> {
	const binding: unknown = Reflect.get(env, "LABEL_SIGNING_PRIVATE_KEY");
	const value =
		typeof binding === "string"
			? binding
			: isSecretBinding(binding)
				? await binding.get()
				: undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError("LABEL_SIGNING_PRIVATE_KEY is not configured");
	}
	return value;
}

function isSecretBinding(value: unknown): value is { get(): Promise<string> } {
	return (
		typeof value === "object" && value !== null && "get" in value && typeof value.get === "function"
	);
}

function parseServiceUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("LABELER_SERVICE_URL must be an HTTPS origin");
	}
	if (
		url.protocol !== "https:" ||
		url.origin !== value ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new TypeError("LABELER_SERVICE_URL must be an HTTPS origin");
	}
	return url.origin;
}

function assertDidMatchesService(did: string, serviceUrl: string): void {
	const encodedHost = DID_WEB_HOST_RE.exec(did)?.[1];
	let decodedHost: string;
	try {
		decodedHost = decodeURIComponent(encodedHost ?? "");
	} catch {
		throw new TypeError("LABELER_DID must be a host-level did:web identity");
	}
	if (!encodedHost || new URL(serviceUrl).host !== decodedHost) {
		throw new TypeError("LABELER_DID must match LABELER_SERVICE_URL");
	}
}
