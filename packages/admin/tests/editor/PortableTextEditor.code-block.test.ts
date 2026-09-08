import { describe, expect, it } from "vitest";

import {
	_portableTextToProsemirror as portableTextToProsemirror,
	_prosemirrorToPortableText as prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor";

describe("Portable Text code block conversion", () => {
	it("preserves supported and unsupported string languages", () => {
		for (const language of ["javascript", "astro"]) {
			const proseMirror = portableTextToProsemirror([
				{ _type: "code", _key: "code", code: "const value = 1;", language },
			]);
			const codeBlock = proseMirror.content?.[0];

			expect(codeBlock?.attrs?.language).toBe(language);
			expect(prosemirrorToPortableText(proseMirror)[0]).toMatchObject({
				_type: "code",
				code: "const value = 1;",
				language,
			});
		}
	});

	it("treats an invalid non-string language as missing", () => {
		const proseMirror = portableTextToProsemirror([
			{
				_type: "code",
				_key: "code",
				code: "const value = 1;",
				language: 42,
			} as never,
		]);
		const codeBlock = proseMirror.content?.[0];
		const serialized = prosemirrorToPortableText(proseMirror)[0];

		expect(codeBlock?.attrs?.language).toBeNull();
		expect(JSON.stringify(serialized)).not.toContain('"language"');
	});
});
