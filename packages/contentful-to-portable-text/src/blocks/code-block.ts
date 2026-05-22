import type { ArbitraryTypedObject } from "@portabletext/types";

import { getStringField } from "../types.js";
import type { ContentfulEntry } from "../types.js";

export function transformCodeBlock(entry: ContentfulEntry, key: string): ArbitraryTypedObject {
	return {
		_type: "code",
		_key: key,
		code: getStringField(entry.fields, "code") ?? "",
		language: getStringField(entry.fields, "language") ?? "",
	};
}
