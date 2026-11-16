import type { DidDocument } from "@atcute/identity";
import type { DidDocumentResolver, HandleResolver } from "@atcute/identity-resolver";
import { isHandle } from "@atcute/lexicons/syntax";

export function publisherHandleFromDidDocument(document: DidDocument): string | null {
	for (const alias of document.alsoKnownAs ?? []) {
		if (!alias.startsWith("at://")) continue;
		const handle = alias.slice("at://".length);
		if (isHandle(handle)) return handle.toLowerCase();
	}
	return null;
}

/**
 * Resolves a handle to a DID and accepts it only when the DID document claims
 * the same handle back, so a handle cannot point at someone else's DID.
 */
export async function verifiedHandleDid(
	handle: string,
	handleResolver: HandleResolver,
	didResolver: DidDocumentResolver,
): Promise<string | null> {
	const normalized = handle.toLowerCase();
	if (!isHandle(normalized)) return null;
	try {
		const did = await handleResolver.resolve(normalized);
		const document = await didResolver.resolve(did);
		if (document.id !== did || publisherHandleFromDidDocument(document) !== normalized) return null;
		return did;
	} catch {
		return null;
	}
}
