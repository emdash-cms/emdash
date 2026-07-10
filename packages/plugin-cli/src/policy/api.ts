import { ClientResponseError } from "@atcute/client";
import { isDid } from "@atcute/lexicons/syntax";
import { safeParse } from "@atcute/lexicons/validations";
import type { PublishingClient } from "@emdash-cms/registry-client";
import { NSID, PackageProfile, PackageProfileExtension } from "@emdash-cms/registry-lexicons";

export type ProfilePolicyErrorCode =
	| "PROFILE_NOT_FOUND"
	| "PROFILE_INVALID"
	| "PROFILE_EXTENSION_INVALID"
	| "REPOSITORY_REQUIRED"
	| "REPOSITORY_ALREADY_SET"
	| "INVALID_REPOSITORY"
	| "INVALID_CONFIRMATION"
	| "INVALID_APPROVERS"
	| "STALE_RECORD"
	| "LEXICON_VALIDATION_FAILED";

export class ProfilePolicyError extends Error {
	override readonly name = "ProfilePolicyError";

	constructor(
		readonly code: ProfilePolicyErrorCode,
		message: string,
		readonly detail?: Record<string, unknown>,
	) {
		super(message);
	}
}

export interface ProfilePolicyInput {
	repository?: string;
	requireProvenance?: boolean;
	confirmation?: string;
	approvers?: string[];
}

export interface SetProfilePolicyOptions {
	publisher: PublishingClient;
	slug: string;
	input: ProfilePolicyInput;
	apply?: boolean;
	now?: () => Date;
}

export interface PolicyFieldDiff {
	field: "repository" | "requireProvenance" | "confirmation" | "approvers";
	before: unknown;
	after: unknown;
}

export interface SetProfilePolicyResult {
	profileUri: string;
	diffs: PolicyFieldDiff[];
	candidate: Record<string, unknown>;
	written: boolean;
	cid?: string;
}

const CONFIRMATIONS = new Set(["escalation-only", "always"]);
const TRAILING_SLASHES_RE = /\/+$/;

export async function setProfilePolicy(
	options: SetProfilePolicyOptions,
): Promise<SetProfilePolicyResult> {
	const profileUri = `at://${options.publisher.did}/${NSID.packageProfile}/${options.slug}`;
	const policyInput = {
		...options.input,
		repository:
			options.input.repository === undefined
				? undefined
				: canonicaliseRepository(options.input.repository),
		approvers: normaliseApprovers(options.input.approvers),
	};
	validateInput(policyInput);

	let existing: { cid: string; value: unknown };
	try {
		existing = await options.publisher.getRecord({
			collection: NSID.packageProfile,
			rkey: options.slug,
		});
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "RecordNotFound") {
			throw new ProfilePolicyError(
				"PROFILE_NOT_FOUND",
				`No package profile exists at ${profileUri}. Publish the package before setting its release policy.`,
				{ slug: options.slug },
			);
		}
		throw error;
	}

	if (!isPlainObject(existing.value) || !safeParse(PackageProfile.mainSchema, existing.value).ok) {
		throw new ProfilePolicyError(
			"PROFILE_INVALID",
			`Existing profile at ${profileUri} does not match the package profile lexicon. Refusing to overwrite it.`,
			{ slug: options.slug },
		);
	}

	const { candidate, diffs } = buildProfilePolicyCandidate({
		existing: existing.value,
		input: policyInput,
		now: (options.now ?? (() => new Date()))(),
	});

	if (options.apply !== true || diffs.length === 0) {
		return { profileUri, diffs, candidate, written: false };
	}

	const profileValidation = safeParse(PackageProfile.mainSchema, candidate);
	const extension = getKnownExtension(candidate);
	const extensionValidation = extension && safeParse(PackageProfileExtension.mainSchema, extension);
	if (!profileValidation.ok || !extensionValidation?.ok || !isValidExtension(extension)) {
		throw new ProfilePolicyError(
			"LEXICON_VALIDATION_FAILED",
			"The edited package profile or profile extension did not pass local validation. Nothing was written.",
			{ profile: profileValidation, extension: extensionValidation },
		);
	}

	try {
		const put = await options.publisher.unsafePutRecord({
			collection: NSID.packageProfile,
			rkey: options.slug,
			record: candidate,
			skipValidation: true,
			swapRecord: existing.cid,
		});
		return { profileUri, diffs, candidate, written: true, cid: put.cid };
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "InvalidSwap") {
			throw new ProfilePolicyError(
				"STALE_RECORD",
				`The package profile at ${profileUri} changed before the policy could be written. Re-run the command to review and apply the latest policy.`,
				{ slug: options.slug, expectedCid: existing.cid },
			);
		}
		throw error;
	}
}

export function buildProfilePolicyCandidate(input: {
	existing: Record<string, unknown>;
	input: ProfilePolicyInput;
	now: Date;
}): { candidate: Record<string, unknown>; diffs: PolicyFieldDiff[] } {
	const existingExtensions = input.existing.extensions;
	if (existingExtensions !== undefined && !isPlainObject(existingExtensions)) {
		throw new ProfilePolicyError(
			"PROFILE_INVALID",
			"Existing profile extensions must be an object. Refusing to overwrite an unknown shape.",
		);
	}

	const extensions = { ...existingExtensions };
	const current = extensions[NSID.packageProfileExtension];
	let extension: Record<string, unknown>;
	if (current === undefined) {
		if (input.input.repository === undefined) {
			throw new ProfilePolicyError(
				"REPOSITORY_REQUIRED",
				`This package profile has no ${NSID.packageProfileExtension} extension. Pass --repository <https-uri> to create its required repository anchor.`,
			);
		}
		extension = { $type: NSID.packageProfileExtension, repository: input.input.repository };
	} else {
		if (!isPlainObject(current) || !isValidExistingExtension(current)) {
			throw new ProfilePolicyError(
				"PROFILE_EXTENSION_INVALID",
				"The existing package profile extension must have a valid HTTPS repository anchor before its policy can be edited.",
			);
		}
		if (input.input.repository !== undefined) {
			throw new ProfilePolicyError(
				"REPOSITORY_ALREADY_SET",
				"The package profile extension already has a repository anchor. Policy edits preserve it and cannot replace it.",
			);
		}
		extension = { ...current, $type: NSID.packageProfileExtension };
	}

	const currentPolicy = extension.releasePolicy;
	if (currentPolicy !== undefined && !isPlainObject(currentPolicy)) {
		throw new ProfilePolicyError(
			"PROFILE_EXTENSION_INVALID",
			"The existing package profile release policy must be an object. Refusing to overwrite an unknown shape.",
		);
	}
	const policy = { ...currentPolicy };
	const diffs: PolicyFieldDiff[] = [];

	if (current === undefined) {
		diffs.push({ field: "repository", before: undefined, after: input.input.repository });
	}
	if (
		input.input.requireProvenance !== undefined &&
		policy.requireProvenance !== input.input.requireProvenance
	) {
		diffs.push({
			field: "requireProvenance",
			before: policy.requireProvenance,
			after: input.input.requireProvenance,
		});
		policy.requireProvenance = input.input.requireProvenance;
	}
	if (input.input.confirmation !== undefined && policy.confirmation !== input.input.confirmation) {
		diffs.push({
			field: "confirmation",
			before: policy.confirmation,
			after: input.input.confirmation,
		});
		policy.confirmation = input.input.confirmation;
	}
	if (
		input.input.approvers !== undefined &&
		!sameStringSet(policy.approvers, input.input.approvers)
	) {
		diffs.push({ field: "approvers", before: policy.approvers, after: input.input.approvers });
		policy.approvers = input.input.approvers;
	}

	if (Object.keys(policy).length > 0) extension.releasePolicy = policy;
	extensions[NSID.packageProfileExtension] = extension;
	const candidate: Record<string, unknown> = { ...input.existing, extensions };
	if (diffs.length > 0) candidate.lastUpdated = input.now.toISOString();
	return { candidate, diffs };
}

function validateInput(input: ProfilePolicyInput): void {
	if (input.confirmation !== undefined && !CONFIRMATIONS.has(input.confirmation)) {
		throw new ProfilePolicyError(
			"INVALID_CONFIRMATION",
			"--confirmation must be either escalation-only or always.",
		);
	}
	if (input.approvers !== undefined) {
		if (input.approvers.length > 32) {
			throw new ProfilePolicyError("INVALID_APPROVERS", "--approver accepts at most 32 DIDs.");
		}
		const seen = new Set<string>();
		for (const did of input.approvers) {
			if (!isDid(did)) {
				throw new ProfilePolicyError("INVALID_APPROVERS", `Invalid approver DID: ${did}`);
			}
			if (seen.has(did)) {
				throw new ProfilePolicyError("INVALID_APPROVERS", `Duplicate approver DID: ${did}`);
			}
			seen.add(did);
		}
	}
}

function normaliseApprovers(approvers: string[] | undefined): string[] | undefined {
	return approvers?.map((did) => did.trim());
}

function getKnownExtension(profile: Record<string, unknown>): Record<string, unknown> | null {
	const extensions = profile.extensions;
	if (!isPlainObject(extensions)) return null;
	const extension = extensions[NSID.packageProfileExtension];
	return isPlainObject(extension) ? extension : null;
}

function isValidExistingExtension(extension: Record<string, unknown>): boolean {
	return (
		safeParse(PackageProfileExtension.mainSchema, extension).ok &&
		typeof extension.repository === "string" &&
		canonicaliseExistingRepository(extension.repository)
	);
}

function isValidExtension(extension: Record<string, unknown> | null): boolean {
	if (!extension || !isValidExistingExtension(extension)) return false;
	const policy = extension.releasePolicy;
	if (policy === undefined) return true;
	if (!isPlainObject(policy)) return false;
	if (
		policy.confirmation !== undefined &&
		(typeof policy.confirmation !== "string" || !CONFIRMATIONS.has(policy.confirmation))
	) {
		return false;
	}
	if (policy.approvers !== undefined) {
		if (
			!Array.isArray(policy.approvers) ||
			new Set(policy.approvers).size !== policy.approvers.length
		) {
			return false;
		}
	}
	return true;
}

/**
 * Canonical form for the signed profile repository anchor. This deliberately
 * leaves path case and a `.git` suffix alone: both can be meaningful to the
 * source host, unlike the host name and trailing path separators.
 */
export function canonicaliseRepository(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
			throw new Error("not a canonical repository URL");
		}
		if (url.port) throw new Error("not a canonical repository URL");
		let path = url.pathname;
		if (path !== "/") {
			path = path.replace(TRAILING_SLASHES_RE, "");
			if (path === "") path = "/";
		}
		return `https://${url.hostname.toLowerCase()}${path}`;
	} catch {
		throw new ProfilePolicyError(
			"INVALID_REPOSITORY",
			"--repository must be an HTTPS URL without userinfo, query, fragment, or a non-default port.",
		);
	}
}

function canonicaliseExistingRepository(value: string): boolean {
	try {
		return canonicaliseRepository(value) === value;
	} catch {
		return false;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameStringSet(existing: unknown, next: string[]): boolean {
	if (!Array.isArray(existing) || existing.length !== next.length) return false;
	return new Set(existing).size === existing.length && existing.every((did) => next.includes(did));
}
