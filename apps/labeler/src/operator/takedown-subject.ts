import { PROFILE_COLLECTION } from "@emdash-cms/registry-moderation";

export type HandleDidResolver = (handle: string) => Promise<string | null>;

export type TakedownSubjectResolution =
	| { success: true; uri: string }
	| { success: false; code: "INVALID_SUBJECT" | "HANDLE_NOT_RESOLVED" };

/**
 * Accepts a DID, an `at://` URI, `@handle` (every listing from the publisher),
 * or `@handle/slug` (one package profile), and returns a DID-based subject URI.
 */
export async function resolveTakedownSubject(
	input: string,
	resolveHandleDid: HandleDidResolver,
): Promise<TakedownSubjectResolution> {
	const value = input.trim();
	if (value.startsWith("did:")) return { success: true, uri: value };

	let authority: string;
	let path: string;
	if (value.startsWith("at://")) {
		const rest = value.slice("at://".length);
		const slash = rest.indexOf("/");
		authority = slash === -1 ? rest : rest.slice(0, slash);
		if (authority.startsWith("did:")) return { success: true, uri: value };
		path = slash === -1 ? "" : rest.slice(slash);
		if (path.length <= 1) return { success: false, code: "INVALID_SUBJECT" };
	} else {
		const rest = value.startsWith("@") ? value.slice(1) : value;
		const slash = rest.indexOf("/");
		authority = slash === -1 ? rest : rest.slice(0, slash);
		const slug = slash === -1 ? "" : rest.slice(slash + 1);
		if (slash !== -1 && !slug) return { success: false, code: "INVALID_SUBJECT" };
		if (slug.includes("/")) return { success: false, code: "INVALID_SUBJECT" };
		path = slug ? `/${PROFILE_COLLECTION}/${slug}` : "";
	}
	if (!authority) return { success: false, code: "INVALID_SUBJECT" };

	const did = await resolveHandleDid(authority);
	if (!did) return { success: false, code: "HANDLE_NOT_RESOLVED" };
	return { success: true, uri: path ? `at://${did}${path}` : did };
}
