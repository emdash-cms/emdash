import { safeParse } from "@atcute/lexicons/validations";
import { declaredAccessToCapabilities, describeCapability } from "@emdash-cms/plugin-types";
import type { CapabilityDescription } from "@emdash-cms/plugin-types";
import { RECORD_SCOPED_BLOB_CACHE_TYPE } from "@emdash-cms/registry-lexicons";
import { PackageReleaseExtension } from "@emdash-cms/registry-lexicons";
import type { RegistryEntryData } from "@emdash-cms/registry-loader";
import {
	recordScopedImageCacheUrl,
	type RecordScopedImagePreset,
} from "@emdash-cms/registry-verification/artifact";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";
const OFFICIAL_PUBLISHER_DID = "did:plc:xyraubanwc5fwemkduw3upi6";
const COMMENT_OR_HEADING_TAG = /<!--[\s\S]*?-->|<h([1-6])[\s>]/gi;

export const REGISTRY_PAGE_CACHE = {
	maxAge: 60,
	swr: 300,
} as const;

export function publisherHandle(
	plugin: Pick<RegistryEntryData["package"], "did" | "handle">,
): string | undefined {
	if (plugin.handle) return plugin.handle;
	return plugin.did === OFFICIAL_PUBLISHER_DID ? "plugins.emdashcms.com" : undefined;
}

export function publisherPath(
	plugin: Pick<RegistryEntryData["package"], "did" | "handle">,
): string {
	const handle = publisherHandle(plugin);
	return `/plugins/${handle ? `@${handle}` : plugin.did}`;
}

export function pluginPath(
	plugin: Pick<RegistryEntryData["package"], "did" | "handle" | "slug">,
): string {
	return `${publisherPath(plugin)}/${plugin.slug}`;
}

export interface PermissionSummary {
	declared: boolean;
	capabilities: string[];
	allowedHosts: string[];
}

export function requestedPermissions(data: RegistryEntryData): PermissionSummary {
	const extensions = data.latestRelease?.release?.extensions;
	if (!isRecord(extensions)) return { declared: false, capabilities: [], allowedHosts: [] };
	const extension = extensions["com.emdashcms.experimental.package.releaseExtension"];
	const parsed = safeParse(PackageReleaseExtension.mainSchema, extension);
	if (!parsed.ok) return { declared: false, capabilities: [], allowedHosts: [] };
	const summary = declaredAccessToCapabilities(parsed.value.declaredAccess);
	const capabilities = summary.capabilities.filter(
		(capability) =>
			capability !== "network:request" ||
			!summary.capabilities.includes("network:request:unrestricted"),
	);
	return { declared: true, capabilities, allowedHosts: summary.allowedHosts };
}

export function permissionCopy(capability: string): CapabilityDescription {
	return (
		describeCapability(capability) ?? {
			label: capability,
			description: "Use this publisher-declared capability.",
		}
	);
}

export function isLiveEntryNotFoundError(error: unknown): boolean {
	return error instanceof Error && error.name === "LiveEntryNotFoundError";
}

/**
 * The lookup itself was invalid, such as an over-long handle, DID, slug, or
 * query: the registry client refused to send it, or the registry answered 400.
 * Anything else means the registry is unreachable or failing.
 */
export function isRegistryRequestRejected(error: unknown): boolean {
	const cause = error instanceof Error ? error.cause : undefined;
	if (!isRecord(cause)) return false;
	return (
		(cause.name === "ClientValidationError" && cause.target === "params") ||
		(cause.name === "ClientResponseError" && cause.status === 400)
	);
}

export function safeExternalUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function repositoryUrl(
	profile: RegistryEntryData["package"]["profile"],
): string | undefined {
	if (!profile || !isRecord(profile.extensions)) return undefined;
	const extension = profile.extensions["com.emdashcms.experimental.package.profileExtension"];
	return isRecord(extension) ? safeExternalUrl(extension.repository) : undefined;
}

/**
 * Renders publisher Markdown for a page section whose heading is an `h2`. The
 * shallowest publisher heading becomes an `h3` and deeper ones an `h4`, so they
 * nest under the section whatever level the publisher started at.
 */
export function renderRegistryMarkdown(markdown: string): string {
	const rendered = marked.parse(markdown, { async: false });
	// Sanitizing drops comments, so a comment matches whole and the headings inside it don't count.
	const shallowest = Math.min(
		...[...rendered.matchAll(COMMENT_OR_HEADING_TAG)].flatMap((match) =>
			match[1] ? [Number(match[1])] : [],
		),
	);
	// The pattern can miss a heading the sanitizer still parses, such as `<h2/>`.
	const nestHeading = (tagName: string) => ({
		tagName: `h${Math.max(3, Math.min(4, 3 + Number(tagName.slice(1)) - shallowest))}`,
		attribs: {},
	});
	return sanitizeHtml(rendered, {
		allowedTags: [
			"a",
			"blockquote",
			"br",
			"code",
			"em",
			"h3",
			"h4",
			"hr",
			"li",
			"ol",
			"p",
			"pre",
			"strong",
			"ul",
		],
		allowedAttributes: { a: ["href", "title", "target", "rel"] },
		allowedSchemes: ["https", "mailto"],
		allowProtocolRelative: false,
		transformTags: {
			h1: nestHeading,
			h2: nestHeading,
			h3: nestHeading,
			h4: nestHeading,
			h5: nestHeading,
			h6: nestHeading,
			a: (_tagName, attribs) => {
				const href = safeMarkdownHref(attribs.href);
				return {
					tagName: "a",
					attribs: {
						...(href ? { ...attribs, href } : {}),
						target: "_blank",
						rel: "noreferrer noopener",
					},
				};
			},
		},
	});
}

function safeMarkdownHref(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "mailto:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function listingImageUrl(
	data: RegistryEntryData,
	kind: "icon" | "banner" | "screenshot",
	index = 0,
): string | undefined {
	const releaseView = data.latestRelease;
	const release = releaseView?.release;
	if (!releaseView || !release || release.auth !== undefined) return undefined;

	const artifacts = release.artifacts;
	const artifact =
		kind === "icon"
			? artifacts.icon
			: kind === "banner"
				? artifacts.banner
				: artifacts.screenshots?.[index];
	if (!artifact || artifact.requiresAuth === true) return undefined;

	const blobCid = artifact.blob && "ref" in artifact.blob ? artifact.blob.ref.$link : undefined;
	if (blobCid) {
		const serviceEndpoint = releaseView.artifactCaches
			.map(recordScopedCacheEndpoint)
			.find((endpoint) => endpoint !== undefined);
		if (serviceEndpoint) {
			const preset: RecordScopedImagePreset =
				kind === "icon" ? "avatar" : kind === "banner" ? "banner" : "feed_fullsize";
			const result = recordScopedImageCacheUrl(
				serviceEndpoint,
				preset,
				{
					did: releaseView.did,
					collection: RELEASE_COLLECTION,
					rkey: `${releaseView.package}:${releaseView.version}`,
					cid: releaseView.cid,
				},
				blobCid,
			);
			if (result.success) return result.value.href;
		}
	}

	return safeExternalUrl(artifact.url);
}

function recordScopedCacheEndpoint(value: unknown): string | undefined {
	if (!isRecord(value) || value.$type !== RECORD_SCOPED_BLOB_CACHE_TYPE) return undefined;
	return safeExternalUrl(value.serviceEndpoint);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOfficialPublisher(plugin: Pick<RegistryEntryData["package"], "did">): boolean {
	return plugin.did === OFFICIAL_PUBLISHER_DID;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const NEW_PLUGIN_DAYS = 14;

/**
 * A first release (mirroring `isProvenFirstRelease` in registry-client: only a complete
 * history proves one) that the registry indexed recently.
 */
export function isNewPlugin(
	plugin: Pick<
		RegistryEntryData["package"],
		"historicalReleaseCount" | "releaseHistoryComplete" | "indexedAt"
	>,
	now: Date = new Date(),
): boolean {
	const age = now.getTime() - Date.parse(plugin.indexedAt);
	return (
		plugin.releaseHistoryComplete === true &&
		Number.isSafeInteger(plugin.historicalReleaseCount) &&
		plugin.historicalReleaseCount === 1 &&
		age >= 0 &&
		age < NEW_PLUGIN_DAYS * DAY_MS
	);
}

export function permissionCountLabel(count: number): string {
	if (count === 0) return "No permissions";
	return count === 1 ? "1 permission" : `${count} permissions`;
}

/** "5 hr. ago" or "3 days ago" within a week, otherwise a short date such as "Oct 3" or "Oct 3, 2025". */
export function relativeUpdated(value: string, now: Date = new Date()): string | undefined {
	const time = Date.parse(value);
	if (Number.isNaN(time)) return undefined;
	const elapsed = now.getTime() - time;
	if (elapsed >= 0 && elapsed < 7 * DAY_MS) {
		const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
		if (elapsed < HOUR_MS)
			return relative.format(-Math.max(1, Math.floor(elapsed / MINUTE_MS)), "minute");
		if (elapsed < DAY_MS) return relative.format(-Math.floor(elapsed / HOUR_MS), "hour");
		return relative.format(-Math.floor(elapsed / DAY_MS), "day");
	}
	const date = new Date(time);
	return new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		year: date.getUTCFullYear() === now.getUTCFullYear() ? undefined : "numeric",
		timeZone: "UTC",
	}).format(date);
}
