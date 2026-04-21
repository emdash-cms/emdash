/**
 * blogCodeBlock → PT codeBlock
 *
 * Contentful fields: { code: string, language?: string }
 * PT output: { _type: "codeBlock", language: string, code: string }
 */
import type { ContentfulEntry, PTBlock } from "../types.js";

export function transformCodeBlock(entry: ContentfulEntry, key: string): PTBlock {
	return {
		_type: "codeBlock",
		_key: key,
		code: (entry.fields.code as string) ?? "",
		language: (entry.fields.language as string) ?? "",
	};
}
