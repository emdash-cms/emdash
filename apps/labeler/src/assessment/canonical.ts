import { NSID, REGISTRY_CUMULUS_ORIGIN } from "@emdash-cms/registry-lexicons";
import {
	CanonicalProfileModerationInputSchema,
	CanonicalReleaseModerationInputSchema,
	RENDERED_PROFILE_SECTION_KEYS,
	type CanonicalMediaDescriptor,
	type CanonicalProfileModerationInput,
	type CanonicalReleaseModerationInput,
} from "@emdash-cms/registry-moderation";
import { recordScopedBlobCacheUrl } from "@emdash-cms/registry-verification/artifact";
import { marked } from "marked";

import type {
	VerifiedProfileRecord,
	VerifiedRegistryRecord,
	VerifiedReleaseRecord,
} from "./records.js";
import { parseSubjectUri } from "./run-key.js";

const ENV_REQUIREMENT_RE = /^env:[a-z][a-z0-9_-]{0,63}$/;
const DID_REQUIREMENT_RE = /^did:(?:plc|web):[A-Za-z0-9._:%-]+$/;

export interface ModerationTextField {
	ref: string;
	value: string;
	format: "plain" | "markdown";
}

export interface ModerationLinkField {
	ref: string;
	url: string;
	usage: "author" | "security" | "repository" | "sbom" | "markdown";
}

const MAX_RENDERED_MARKDOWN_LINKS = 128;

export interface CanonicalProfileAssessmentInput {
	kind: "profile";
	input: CanonicalProfileModerationInput;
	text: readonly ModerationTextField[];
	links: readonly ModerationLinkField[];
	media: readonly [];
	neverFetchUrls: readonly [];
}

export interface CanonicalReleaseAssessmentInput {
	kind: "release";
	input: CanonicalReleaseModerationInput;
	text: readonly ModerationTextField[];
	links: readonly ModerationLinkField[];
	media: readonly CanonicalMediaDescriptor[];
	neverFetchUrls: readonly string[];
}

export type CanonicalAssessmentInput =
	| CanonicalProfileAssessmentInput
	| CanonicalReleaseAssessmentInput;

export function buildCanonicalAssessmentInput(
	verified: VerifiedRegistryRecord,
): CanonicalAssessmentInput {
	return verified.kind === "profile"
		? buildCanonicalProfileInput(verified)
		: buildCanonicalReleaseInput(verified);
}

export function buildCanonicalProfileInput(
	verified: VerifiedProfileRecord,
): CanonicalProfileAssessmentInput {
	const record = verified.record;
	const subjectUri = parseSubjectUri(verified.uri);
	const sections = record.sections
		? Object.fromEntries(
				Object.entries(record.sections).filter(
					(entry): entry is [string, string] =>
						(RENDERED_PROFILE_SECTION_KEYS as readonly string[]).includes(entry[0]) &&
						typeof entry[1] === "string",
				),
			)
		: {};
	const input = CanonicalProfileModerationInputSchema.parse({
		schemaVersion: 1,
		subject: { uri: verified.uri, cid: verified.cid, kind: "profile" },
		publisherDid: subjectUri.publisherDid,
		slug: record.slug ?? subjectUri.rkey,
		name: record.name,
		description: record.description,
		keywords: record.keywords ?? [],
		license: record.license,
		sections,
		authors: record.authors.map(({ name, url, email }) => ({ name, url, email })),
		security: record.security.map(({ url, email }) => ({ url, email })),
		lastUpdated: record.lastUpdated,
	});
	return canonicalProfileFromInput(input);
}

function canonicalProfileFromInput(
	input: CanonicalProfileModerationInput,
): CanonicalProfileAssessmentInput {
	const text: ModerationTextField[] = [
		{ ref: "profile.slug", value: input.slug, format: "plain" },
		...(input.name ? [{ ref: "profile.name", value: input.name, format: "plain" as const }] : []),
		...(input.description
			? [{ ref: "profile.description", value: input.description, format: "plain" as const }]
			: []),
		...input.keywords.map((value, index) => ({
			ref: `profile.keywords[${index}]`,
			value,
			format: "plain" as const,
		})),
		{ ref: "profile.license", value: input.license, format: "plain" },
		...Object.entries(input.sections).map(([key, value]) => ({
			ref: `profile.sections.${key}`,
			value,
			format: "markdown" as const,
		})),
		...input.authors.flatMap((author, index) => [
			{ ref: `profile.authors[${index}].name`, value: author.name, format: "plain" as const },
			...(author.email
				? [
						{
							ref: `profile.authors[${index}].email`,
							value: author.email,
							format: "plain" as const,
						},
					]
				: []),
		]),
		...input.security.flatMap((contact, index) =>
			contact.email
				? [
						{
							ref: `profile.security[${index}].email`,
							value: contact.email,
							format: "plain" as const,
						},
					]
				: [],
		),
	];
	const links: ModerationLinkField[] = [
		...input.authors.flatMap((author, index) =>
			author.url
				? [
						{
							ref: `profile.authors[${index}].url`,
							url: author.url,
							usage: "author" as const,
						},
					]
				: [],
		),
		...input.security.flatMap((contact, index) =>
			contact.url
				? [
						{
							ref: `profile.security[${index}].url`,
							url: contact.url,
							usage: "security" as const,
						},
					]
				: [],
		),
		...Object.entries(input.sections).flatMap(([key, markdown]) =>
			extractRenderedMarkdownLinks(markdown).map((url, index) => ({
				ref: `profile.sections.${key}.links[${index}]`,
				url,
				usage: "markdown" as const,
			})),
		),
	];
	return { kind: "profile", input, text, links, media: [], neverFetchUrls: [] };
}

export function buildCanonicalReleaseInput(
	verified: VerifiedReleaseRecord,
): CanonicalReleaseAssessmentInput {
	const record = verified.record;
	const subjectUri = parseSubjectUri(verified.uri);
	const neverFetchUrls = collectNeverFetchUrls(record);
	const input = CanonicalReleaseModerationInputSchema.parse({
		schemaVersion: 1,
		subject: { uri: verified.uri, cid: verified.cid, kind: "release" },
		publisherDid: subjectUri.publisherDid,
		packageSlug: record.package,
		version: record.version,
		repositoryUrl: record.repo,
		requires: parseRequires(record.requires),
		sbom: record.sbom ? { format: record.sbom.format, url: record.sbom.url } : undefined,
		media: selectDisplayMedia(verified, neverFetchUrls),
	});
	return canonicalReleaseFromInput(input, [...neverFetchUrls]);
}

function canonicalReleaseFromInput(
	input: CanonicalReleaseModerationInput,
	neverFetchUrls: readonly string[],
): CanonicalReleaseAssessmentInput {
	const text: ModerationTextField[] = [
		{ ref: "release.packageSlug", value: input.packageSlug, format: "plain" },
		{ ref: "release.version", value: input.version, format: "plain" },
		...Object.entries(input.requires).flatMap(([key, value], index) => [
			{ ref: `release.requires[${index}].key`, value: key, format: "plain" as const },
			{ ref: `release.requires[${index}].constraint`, value, format: "plain" as const },
		]),
		...(input.sbom?.format
			? [{ ref: "release.sbom.format", value: input.sbom.format, format: "plain" as const }]
			: []),
	];
	const links: ModerationLinkField[] = [
		...(input.repositoryUrl
			? [{ ref: "release.repositoryUrl", url: input.repositoryUrl, usage: "repository" as const }]
			: []),
		...(input.sbom?.url
			? [{ ref: "release.sbom.url", url: input.sbom.url, usage: "sbom" as const }]
			: []),
	];
	return { kind: "release", input, text, links, media: input.media, neverFetchUrls };
}

export function parseCanonicalAssessmentProjection(value: unknown): CanonicalAssessmentInput {
	if (!isPlainObject(value))
		throw new TypeError("canonical assessment projection must be an object");
	if (value["kind"] === "profile") {
		return canonicalProfileFromInput(CanonicalProfileModerationInputSchema.parse(value["input"]));
	}
	if (value["kind"] === "release") {
		return canonicalReleaseFromInput(
			CanonicalReleaseModerationInputSchema.parse(value["input"]),
			parseNeverFetchUrls(value["neverFetchUrls"]),
		);
	}
	throw new TypeError("canonical assessment projection kind is invalid");
}

function parseRequires(value: unknown): Record<string, string> {
	if (value === undefined) return {};
	if (!isPlainObject(value)) throw new TypeError("release requires must be an object");
	const entries = Object.entries(value).toSorted(([left], [right]) =>
		compareCodePoints(left, right),
	);
	if (entries.length > 64) throw new TypeError("release requires contains too many entries");
	for (const [key, constraint] of entries) {
		if (
			key.length === 0 ||
			key.length > 128 ||
			containsControlCharacter(key) ||
			!isRequirementKey(key) ||
			typeof constraint !== "string" ||
			containsControlCharacter(constraint)
		) {
			throw new TypeError("release requires contains an invalid displayed constraint");
		}
	}
	const result: Record<string, string> = {};
	for (const [key, constraint] of entries) {
		if (typeof constraint === "string") result[key] = constraint;
	}
	return result;
}

function selectDisplayMedia(
	verified: VerifiedReleaseRecord,
	neverFetch: ReadonlySet<string>,
): CanonicalMediaDescriptor[] {
	const record = verified.record;
	const subject = parseSubjectUri(verified.uri);
	const artifacts = record.artifacts;
	const media = [
		...(artifacts.icon
			? [projectMedia("icon", artifacts.icon, 0, subject.publisherDid, subject.rkey, verified.cid)]
			: []),
		...(artifacts.banner
			? [
					projectMedia(
						"banner",
						artifacts.banner,
						0,
						subject.publisherDid,
						subject.rkey,
						verified.cid,
					),
				]
			: []),
		...(artifacts.screenshots?.map((artifact, index) =>
			projectMedia("screenshot", artifact, index, subject.publisherDid, subject.rkey, verified.cid),
		) ?? []),
	];
	for (const descriptor of media) {
		if (neverFetch.has(normalizeComparableUrl(descriptor.url))) {
			throw new TypeError(`${descriptor.kind} URL aliases a non-display resource`);
		}
	}
	return media;
}

function projectMedia(
	kind: CanonicalMediaDescriptor["kind"],
	artifact: NonNullable<VerifiedReleaseRecord["record"]["artifacts"]["icon"]>,
	index: number,
	publisherDid: string,
	rkey: string,
	recordCid: string,
): CanonicalMediaDescriptor {
	return {
		kind,
		index,
		id: artifact.id,
		url: displayArtifactUrl(artifact, publisherDid, rkey, recordCid),
		checksum: artifact.checksum,
		contentType: artifact.contentType,
		requiresAuth: artifact.requiresAuth,
		releaseAsset: artifact.releaseAsset,
		width: artifact.width,
		height: artifact.height,
		language: artifact.lang,
	};
}

function displayArtifactUrl(
	artifact: NonNullable<VerifiedReleaseRecord["record"]["artifacts"]["icon"]>,
	publisherDid: string,
	rkey: string,
	recordCid: string,
): string {
	const blob = artifact.blob;
	if (blob && "ref" in blob) {
		const url = recordScopedBlobCacheUrl(
			REGISTRY_CUMULUS_ORIGIN,
			{ did: publisherDid, collection: NSID.packageRelease, rkey, cid: recordCid },
			blob.ref.$link,
		);
		if (!url.success) throw new TypeError(url.error.message);
		return url.value.href;
	}
	if (artifact.url) return artifact.url;
	throw new TypeError("display artifact has no blob or URL source");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectNeverFetchUrls(record: VerifiedReleaseRecord["record"]): Set<string> {
	const urls = new Set<string>();
	for (const value of [record.artifacts.package.url, record.repo, record.sbom?.url]) {
		if (value) urls.add(normalizeComparableUrl(value));
	}
	const traversal = { visited: 0 };
	for (const value of [record.auth, record.extensions, record.provides, record.suggests]) {
		collectNestedUrls(value, urls, traversal, 0);
	}
	return urls;
}

function collectNestedUrls(
	value: unknown,
	urls: Set<string>,
	traversal: { visited: number },
	depth: number,
): void {
	traversal.visited += 1;
	if (traversal.visited > 2048 || depth > 8) {
		throw new TypeError("release opaque metadata exceeds the never-fetch inspection limit");
	}
	if (typeof value === "string") {
		if (value.startsWith("https://") || value.startsWith("http://") || value.startsWith("at://")) {
			urls.add(normalizeComparableUrl(value));
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectNestedUrls(item, urls, traversal, depth + 1);
		return;
	}
	if (!isPlainObject(value)) return;
	for (const item of Object.values(value)) collectNestedUrls(item, urls, traversal, depth + 1);
}

function normalizeComparableUrl(value: string): string {
	try {
		const url = new URL(value);
		url.hash = "";
		return url.toString();
	} catch {
		return value;
	}
}

function parseNeverFetchUrls(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 2048) {
		throw new TypeError("canonical never-fetch URLs must be a bounded array");
	}
	const urls = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || item.length > 2048) {
			throw new TypeError("canonical never-fetch URL is invalid");
		}
		urls.add(normalizeComparableUrl(item));
	}
	return [...urls];
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isRequirementKey(value: string): boolean {
	return ENV_REQUIREMENT_RE.test(value) || DID_REQUIREMENT_RE.test(value);
}

function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function extractRenderedMarkdownLinks(markdown: string): string[] {
	const links: string[] = [];
	const tokens = marked.lexer(markdown);
	collectRenderedMarkdownLinks(tokens, links, { visited: 0 }, 0);
	return links;
}

function collectRenderedMarkdownLinks(
	value: unknown,
	links: string[],
	traversal: { visited: number },
	depth: number,
): void {
	traversal.visited += 1;
	if (traversal.visited > 4096 || depth > 32) {
		throw new RangeError("profile Markdown token tree exceeds its traversal limit");
	}
	if (Array.isArray(value)) {
		for (const item of value) collectRenderedMarkdownLinks(item, links, traversal, depth + 1);
		return;
	}
	if (!isPlainObject(value)) return;
	if (value["type"] === "link" && typeof value["href"] === "string") {
		links.push(value["href"]);
		if (links.length > MAX_RENDERED_MARKDOWN_LINKS) {
			throw new RangeError("profile sections contain too many rendered links");
		}
	}
	for (const item of Object.values(value)) {
		if (typeof item === "object" && item !== null) {
			collectRenderedMarkdownLinks(item, links, traversal, depth + 1);
		}
	}
}
