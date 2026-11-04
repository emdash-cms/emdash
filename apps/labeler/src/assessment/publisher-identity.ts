import type { DidDocument } from "@atcute/identity";
import { isHandle } from "@atcute/lexicons/syntax";

export function publisherHandleFromDidDocument(document: DidDocument): string | null {
	for (const alias of document.alsoKnownAs ?? []) {
		if (!alias.startsWith("at://")) continue;
		const handle = alias.slice("at://".length);
		if (isHandle(handle)) return handle.toLowerCase();
	}
	return null;
}
