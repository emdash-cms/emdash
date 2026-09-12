import { isHandle } from "@atcute/lexicons/syntax";

import type { DidHandleResolution } from "./api/registry.js";

const REGISTRY_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export interface RegistryPublicName {
	handle: string;
	slug: string;
}

export type RegistryIdentity =
	| { status: "pending"; did: string; slug: string }
	| { status: "ok"; did: string; slug: string; handle: string; publicName: string }
	| { status: "invalid"; did: string; slug: string }
	| { status: "missing"; did: string; slug: string };

export function formatRegistryPublicName(handle: string, slug: string): string {
	return `@${handle.toLowerCase()}/${slug}`;
}

export function parseRegistryPublicName(value: string): RegistryPublicName | null {
	const trimmed = value.trim();
	if (!trimmed.startsWith("@")) return null;
	const separator = trimmed.indexOf("/");
	if (separator <= 1 || separator !== trimmed.lastIndexOf("/")) return null;

	const handle = trimmed.slice(1, separator).toLowerCase();
	const slug = trimmed.slice(separator + 1);
	if (!isHandle(handle) || !REGISTRY_SLUG_PATTERN.test(slug)) return null;
	return { handle, slug };
}

export function registryIdentity(
	did: string,
	slug: string,
	resolution: DidHandleResolution | undefined,
): RegistryIdentity {
	if (!resolution) return { status: "pending", did, slug };
	if (resolution.status === "ok") {
		const handle = resolution.handle.toLowerCase();
		return {
			status: "ok",
			did,
			slug,
			handle,
			publicName: formatRegistryPublicName(handle, slug),
		};
	}
	return { status: resolution.status, did, slug };
}

export function registryIdentityPublisherParam(identity: RegistryIdentity): string {
	return identity.status === "ok" ? `@${identity.handle}` : identity.did;
}
