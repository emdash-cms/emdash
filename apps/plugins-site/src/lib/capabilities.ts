import { normalizeCapability } from "@emdash-cms/plugin-types";

export type CapabilityGroup =
	| "content"
	| "comments"
	| "schema"
	| "taxonomies"
	| "bylines"
	| "redirects"
	| "media"
	| "network"
	| "email"
	| "page"
	| "users"
	| "other";

const NAMESPACE_GROUPS: Readonly<Record<string, CapabilityGroup>> = {
	content: "content",
	"admin.editor-draft": "content",
	comments: "comments",
	schema: "schema",
	taxonomies: "taxonomies",
	bylines: "bylines",
	redirects: "redirects",
	media: "media",
	network: "network",
	email: "email",
	users: "users",
};

const HOOK_GROUPS: Readonly<Record<string, CapabilityGroup>> = {
	"content-policy": "content",
	"page-fragments": "page",
};

/** The family a capability belongs to, used to pick its icon. Legacy names resolve first. */
export function capabilityGroup(capability: string): CapabilityGroup {
	const current = normalizeCapability(capability);
	const separator = current.indexOf(":");
	if (separator <= 0) return "other";
	const namespace = current.slice(0, separator);

	if (namespace.startsWith("hooks.")) {
		const hook = namespace.slice("hooks.".length);
		if (hook.startsWith("email-")) return "email";
		return Object.hasOwn(HOOK_GROUPS, hook) ? HOOK_GROUPS[hook] : "other";
	}

	return Object.hasOwn(NAMESPACE_GROUPS, namespace) ? NAMESPACE_GROUPS[namespace] : "other";
}
