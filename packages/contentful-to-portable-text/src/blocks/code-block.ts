import type { ArbitraryTypedObject } from "@portabletext/types";

import type { ContentfulEntry } from "../types.js";

export function transformCodeBlock(entry: ContentfulEntry, key: string): ArbitraryTypedObject {
	return {
		_type: "code",
		_key: key,
		code: (entry.fields.code as string) ?? "",
		language: (entry.fields.language as string) ?? "",
	};
}
