import { safeParse } from "@atcute/lexicons/validations";
import { declaredAccessToCapabilities } from "@emdash-cms/plugin-types";
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

const PERMISSION_COPY: Record<string, { label: string; description: string }> = {
	"content:read": {
		label: "Read content",
		description: "Read entries from your site’s content collections.",
	},
	"content:write": {
		label: "Manage content",
		description: "Create, update, and delete content entries.",
	},
	"taxonomies:read": {
		label: "Read taxonomies",
		description: "Read taxonomy definitions, terms, and content assignments.",
	},
	"media:read": {
		label: "Read media",
		description: "Read media metadata and files from your library.",
	},
	"media:write": {
		label: "Manage media",
		description: "Upload, update, and delete media from your library.",
	},
	"network:request": {
		label: "Make network requests",
		description: "Connect to the publisher-declared external hosts.",
	},
	"network:request:unrestricted": {
		label: "Make unrestricted network requests",
		description: "Connect to any external host.",
	},
	"email:send": {
		label: "Send email",
		description: "Send email through your site’s configured mail service.",
	},
	"hooks.email-events:register": {
		label: "Observe outgoing email",
		description: "Observe and modify messages before or after they are sent.",
	},
	"hooks.email-transport:register": {
		label: "Provide the email transport",
		description: "Deliver every message sent by the site, replacing the current transport.",
	},
	"hooks.page-fragments:register": {
		label: "Add page scripts and styles",
		description: "Inject script or style fragments into rendered pages.",
	},
	"users:read": {
		label: "Read user accounts",
		description: "Read user records from your site.",
	},
};

export function permissionCopy(capability: string): {
	label: string;
	description: string;
} {
	return (
		PERMISSION_COPY[capability] ?? {
			label: capability,
			description: "Use this publisher-declared capability.",
		}
	);
}

export function isLiveEntryNotFoundError(error: unknown): boolean {
	return error instanceof Error && error.name === "LiveEntryNotFoundError";
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

export function renderRegistryMarkdown(markdown: string): string {
	const rendered = marked.parse(markdown, { async: false });
	return sanitizeHtml(rendered, {
		allowedTags: [
			"a",
			"blockquote",
			"br",
			"code",
			"em",
			"h2",
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
