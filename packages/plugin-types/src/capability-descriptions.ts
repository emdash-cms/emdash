import { normalizeCapability } from "./index.js";
import type { CurrentPluginCapability } from "./index.js";

/** English copy describing a capability to someone deciding whether to grant it. */
export interface CapabilityDescription {
	label: string;
	description: string;
}

export const CAPABILITY_DESCRIPTIONS: Readonly<
	Record<CurrentPluginCapability, CapabilityDescription>
> = {
	"content:read": {
		label: "Read content",
		description: "Read entries from your site’s content collections.",
	},
	"content:revisions:read": {
		label: "Read revision history",
		description: "Read retained earlier versions of content entries.",
	},
	"content:write": {
		label: "Manage content",
		description: "Create, update, and delete content entries.",
	},
	"content:publish": {
		label: "Publish content",
		description: "Publish, unpublish, schedule, and unschedule content entries.",
	},
	"content:restore": {
		label: "Restore trashed content",
		description: "Read entries in the trash and restore them.",
	},
	"comments:read": {
		label: "Read comments",
		description:
			"Read comment text, author names and email addresses, IP hashes, user agents, and moderation details.",
	},
	"comments:moderate": {
		label: "Moderate comments",
		description: "Approve comments and mark them as pending or spam.",
	},
	"schema:read": {
		label: "Read content structure",
		description: "Read the collections and fields defined on your site.",
	},
	"admin.editor-draft:read": {
		label: "Read unsaved edits",
		description: "Read selected unsaved editor fields when you run the plugin from the editor.",
	},
	"admin.editor-draft:patch": {
		label: "Suggest edits",
		description: "Propose changes to selected editor fields for you to review.",
	},
	"hooks.content-policy:register": {
		label: "Block publishing",
		description: "Review content and stop it from being published, scheduled, or unpublished.",
	},
	"taxonomies:read": {
		label: "Read taxonomies",
		description: "Read taxonomy definitions, terms, and content assignments.",
	},
	"taxonomies:write": {
		label: "Manage taxonomy terms",
		description: "Create terms and change which terms are assigned to content.",
	},
	"bylines:read": {
		label: "Read bylines",
		description: "Read public byline profiles and the bylines credited on content entries.",
	},
	"redirects:read": {
		label: "Read redirects",
		description: "Read your site’s redirect rules.",
	},
	"redirects:write": {
		label: "Manage redirects",
		description: "Create, update, and delete redirect rules, changing where visitors are sent.",
	},
	"media:read": {
		label: "Read media",
		description: "Read media metadata from your library.",
	},
	"media:bytes:read": {
		label: "Read media files",
		description: "Read the contents of files in your media library.",
	},
	"media:metadata:write": {
		label: "Edit media details",
		description: "Change alt text, captions, and focal points on media.",
	},
	"media:write": {
		label: "Manage media",
		description: "Upload and delete media in your library.",
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

/**
 * Look up the copy for a capability. Deprecated names resolve to their
 * replacement; strings outside the vocabulary return `undefined`.
 */
export function describeCapability(capability: string): CapabilityDescription | undefined {
	const descriptions: Record<string, CapabilityDescription | undefined> = CAPABILITY_DESCRIPTIONS;
	const current = normalizeCapability(capability);
	return Object.hasOwn(descriptions, current) ? descriptions[current] : undefined;
}
