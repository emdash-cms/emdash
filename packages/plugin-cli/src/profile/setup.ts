import { ClientResponseError } from "@atcute/client";
import { safeParse } from "@atcute/lexicons";
import { isDid } from "@atcute/lexicons/syntax";
import { isPluginSlug } from "@emdash-cms/plugin-types";
import type { PublishingClient } from "@emdash-cms/registry-client";
import { NSID, PackageProfile, PackageProfileExtension } from "@emdash-cms/registry-lexicons";

import type { ProfileInput } from "../publish/api.js";

const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const GIT_SUFFIX = /\.git$/i;

export type PackageProfileSetupErrorCode =
	| "INVALID_INPUT"
	| "INVALID_REPOSITORY"
	| "PROFILE_CHANGED"
	| "PROFILE_EXTENSION_INVALID"
	| "PROFILE_INVALID"
	| "REPOSITORY_MISMATCH";

export class PackageProfileSetupError extends Error {
	override readonly name = "PackageProfileSetupError";

	constructor(
		readonly code: PackageProfileSetupErrorCode,
		message: string,
	) {
		super(message);
	}
}

export type PackageProfilePublisher = Pick<
	PublishingClient,
	"applyWrites" | "did" | "getRecord" | "unsafePutRecord"
>;

export interface SetupPackageProfileOptions {
	publisher: PackageProfilePublisher;
	slug: string;
	profile: ProfileInput;
	repository: string;
	requireProvenance?: boolean;
	confirmation?: "always" | "escalation-only";
	approvers?: readonly string[];
	apply?: boolean;
	now?: () => Date;
}

export interface SetupPackageProfileResult {
	status: "created" | "ready" | "updated";
	profileUri: string;
	candidate: Record<string, unknown>;
	written: boolean;
	cid?: string;
}

export interface CurrentPackageProfilePolicy {
	requireProvenance: boolean;
	confirmation: "always" | "escalation-only";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalGitHubRepository(value: string): string | null {
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.hostname.toLowerCase() !== "github.com" ||
			url.username ||
			url.password ||
			url.port ||
			url.search ||
			url.hash
		) {
			return null;
		}
		const segments = url.pathname.split("/").filter(Boolean);
		if (
			segments.length !== 2 ||
			!segments.every((segment) => GITHUB_REPOSITORY_SEGMENT.test(segment))
		) {
			return null;
		}
		const repository = segments[1]!.replace(GIT_SUFFIX, "");
		if (!repository) return null;
		return `https://github.com/${segments[0]!.toLowerCase()}/${repository.toLowerCase()}`;
	} catch {
		return null;
	}
}

function profileExtension(
	options: SetupPackageProfileOptions,
	repository: string,
	existing?: PackageProfileExtension.Main,
) {
	const existingPolicy = existing?.releasePolicy;
	const approvers = [
		...(options.approvers ?? existingPolicy?.approvers ?? [options.publisher.did]),
	].toSorted();
	if (
		approvers.length === 0 ||
		approvers.length > 32 ||
		new Set(approvers).size !== approvers.length ||
		approvers.some((approver) => !isDid(approver))
	) {
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			"Approvers must be one to 32 unique Atmosphere account DIDs.",
		);
	}
	return {
		$type: NSID.packageProfileExtension,
		repository,
		releasePolicy: {
			$type: `${NSID.packageProfileExtension}#releasePolicy`,
			requireProvenance:
				options.requireProvenance ??
				(existing === undefined ? true : (existingPolicy?.requireProvenance ?? false)),
			confirmation: options.confirmation ?? existingPolicy?.confirmation ?? "escalation-only",
			approvers,
		},
	};
}

function sameExtensionPolicy(
	current: PackageProfileExtension.Main,
	desired: ReturnType<typeof profileExtension>,
): boolean {
	const currentPolicy = current.releasePolicy;
	return (
		current.repository === desired.repository &&
		(currentPolicy?.requireProvenance ?? false) === desired.releasePolicy.requireProvenance &&
		(currentPolicy?.confirmation ?? "escalation-only") === desired.releasePolicy.confirmation &&
		JSON.stringify([...(currentPolicy?.approvers ?? [])].toSorted()) ===
			JSON.stringify(desired.releasePolicy.approvers)
	);
}

function createProfile(
	options: SetupPackageProfileOptions,
	profileUri: string,
	extension: ReturnType<typeof profileExtension>,
): Record<string, unknown> {
	const profile = options.profile;
	if (!profile.license || !profile.authors?.length || !profile.security?.length) {
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			"The plugin manifest must include a license, at least one author, and at least one security contact.",
		);
	}
	if (profile.security.some((contact) => !contact.email && !contact.url)) {
		throw new PackageProfileSetupError(
			"INVALID_INPUT",
			"Each security contact must include an email address or URL.",
		);
	}
	return {
		$type: NSID.packageProfile,
		id: profileUri,
		type: "emdash-plugin",
		license: profile.license,
		authors: profile.authors,
		security: profile.security,
		slug: options.slug,
		lastUpdated: (options.now ?? (() => new Date()))().toISOString(),
		...(profile.name === undefined ? {} : { name: profile.name }),
		...(profile.description === undefined ? {} : { description: profile.description }),
		...(profile.keywords === undefined || profile.keywords.length === 0
			? {}
			: { keywords: profile.keywords }),
		...(profile.sections === undefined || Object.keys(profile.sections).length === 0
			? {}
			: { sections: profile.sections }),
		extensions: { [NSID.packageProfileExtension]: extension },
	};
}

function validateCandidate(
	candidate: Record<string, unknown>,
	extension: unknown,
): PackageProfile.Main {
	const profile = safeParse(PackageProfile.mainSchema, candidate);
	if (!profile.ok) {
		throw new PackageProfileSetupError(
			"PROFILE_INVALID",
			"The package profile does not match the registry profile format.",
		);
	}
	if (!safeParse(PackageProfileExtension.mainSchema, extension).ok) {
		throw new PackageProfileSetupError(
			"PROFILE_EXTENSION_INVALID",
			"The delegated release settings do not match the registry profile format.",
		);
	}
	return profile.value;
}

export async function readPackageProfilePolicy(
	publisher: PackageProfilePublisher,
	slug: string,
): Promise<CurrentPackageProfilePolicy | null> {
	let existing: { value: unknown };
	try {
		existing = await publisher.getRecord({ collection: NSID.packageProfile, rkey: slug });
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "RecordNotFound") return null;
		throw error;
	}
	const profile = safeParse(PackageProfile.mainSchema, existing.value);
	if (!profile.ok) {
		throw new PackageProfileSetupError(
			"PROFILE_INVALID",
			"The existing package profile is invalid and was not changed.",
		);
	}
	const rawExtensions = profile.value.extensions;
	if (rawExtensions !== undefined && !isRecord(rawExtensions)) {
		throw new PackageProfileSetupError(
			"PROFILE_EXTENSION_INVALID",
			"The existing package profile has invalid extension data and was not changed.",
		);
	}
	const rawExtension = rawExtensions?.[NSID.packageProfileExtension];
	if (rawExtension === undefined) {
		return null;
	}
	const extension = safeParse(PackageProfileExtension.mainSchema, rawExtension);
	if (!extension.ok) {
		throw new PackageProfileSetupError(
			"PROFILE_EXTENSION_INVALID",
			"The existing delegated release settings are invalid and were not changed.",
		);
	}
	const confirmation = extension.value.releasePolicy?.confirmation ?? "escalation-only";
	const normalizedConfirmation =
		confirmation === "always"
			? "always"
			: confirmation === "escalation-only"
				? "escalation-only"
				: null;
	if (normalizedConfirmation === null) {
		throw new PackageProfileSetupError(
			"PROFILE_EXTENSION_INVALID",
			"The existing delegated release settings are invalid and were not changed.",
		);
	}
	return {
		requireProvenance: extension.value.releasePolicy?.requireProvenance ?? false,
		confirmation: normalizedConfirmation,
	};
}

export async function setupPackageProfile(
	options: SetupPackageProfileOptions,
): Promise<SetupPackageProfileResult> {
	if (!isDid(options.publisher.did) || !isPluginSlug(options.slug)) {
		throw new PackageProfileSetupError("INVALID_INPUT", "Publisher or plugin ID is invalid.");
	}
	const repository = canonicalGitHubRepository(options.repository);
	if (!repository) {
		throw new PackageProfileSetupError(
			"INVALID_REPOSITORY",
			"Repository must be an HTTPS GitHub repository URL.",
		);
	}
	const profileUri = `at://${options.publisher.did}/${NSID.packageProfile}/${options.slug}`;
	let existing: { cid: string; value: unknown } | null;
	try {
		existing = await options.publisher.getRecord({
			collection: NSID.packageProfile,
			rkey: options.slug,
		});
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "RecordNotFound") existing = null;
		else throw error;
	}

	let status: SetupPackageProfileResult["status"];
	let candidate: Record<string, unknown>;
	if (existing === null) {
		const extension = profileExtension(options, repository);
		status = "created";
		candidate = createProfile(options, profileUri, extension);
	} else {
		const parsed = safeParse(PackageProfile.mainSchema, existing.value);
		if (!parsed.ok || parsed.value.id !== profileUri) {
			throw new PackageProfileSetupError(
				"PROFILE_INVALID",
				"The existing package profile is invalid and was not changed.",
			);
		}
		const rawExtensions = parsed.value.extensions;
		if (rawExtensions !== undefined && !isRecord(rawExtensions)) {
			throw new PackageProfileSetupError(
				"PROFILE_EXTENSION_INVALID",
				"The existing package profile has invalid extension data and was not changed.",
			);
		}
		const extensions = rawExtensions ?? {};
		const currentExtension = extensions[NSID.packageProfileExtension];
		if (currentExtension !== undefined) {
			const parsedExtension = safeParse(PackageProfileExtension.mainSchema, currentExtension);
			if (!parsedExtension.ok) {
				throw new PackageProfileSetupError(
					"PROFILE_EXTENSION_INVALID",
					"The existing delegated release settings are invalid and were not changed.",
				);
			}
			const currentRepository = canonicalGitHubRepository(parsedExtension.value.repository);
			if (currentRepository !== repository) {
				throw new PackageProfileSetupError(
					"REPOSITORY_MISMATCH",
					`The package profile is linked to ${parsedExtension.value.repository}, not ${repository}.`,
				);
			}
			const extension = profileExtension(options, repository, parsedExtension.value);
			if (sameExtensionPolicy(parsedExtension.value, extension)) {
				return {
					status: "ready",
					profileUri,
					candidate: parsed.value,
					written: false,
				};
			}
			status = "updated";
			candidate = {
				...parsed.value,
				lastUpdated: (options.now ?? (() => new Date()))().toISOString(),
				extensions: {
					...extensions,
					[NSID.packageProfileExtension]: {
						...extension,
					},
				},
			};
		} else {
			const extension = profileExtension(options, repository);
			status = "updated";
			candidate = {
				...parsed.value,
				lastUpdated: (options.now ?? (() => new Date()))().toISOString(),
				extensions: { ...extensions, [NSID.packageProfileExtension]: extension },
			};
		}
	}
	const candidateExtensions = candidate["extensions"];
	const candidateExtension = isRecord(candidateExtensions)
		? candidateExtensions[NSID.packageProfileExtension]
		: undefined;
	const validatedCandidate = validateCandidate(candidate, candidateExtension);
	if (!options.apply) return { status, profileUri, candidate, written: false };

	let put: { uri: string; cid: string };
	try {
		if (existing) {
			put = await options.publisher.unsafePutRecord({
				collection: NSID.packageProfile,
				rkey: options.slug,
				record: candidate,
				skipValidation: true,
				swapRecord: existing.cid,
			});
		} else {
			const created = await options.publisher.applyWrites({
				writes: [
					{
						op: "create",
						collection: NSID.packageProfile,
						rkey: options.slug,
						record: validatedCandidate,
					},
				],
				skipValidation: true,
			});
			const result = created.results[0];
			if (!result || result.op !== "create") throw new Error("Package profile was not created.");
			put = result;
		}
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "InvalidSwap") {
			throw new PackageProfileSetupError(
				"PROFILE_CHANGED",
				"The package profile changed while it was being prepared. Run the command again.",
			);
		}
		throw error;
	}
	return { status, profileUri, candidate, written: true, cid: put.cid };
}
