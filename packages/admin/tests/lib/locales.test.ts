import { expect, test } from "vitest";

import { loadMessages, SUPPORTED_LOCALES } from "../../src/locales/index.js";

for (const { code } of SUPPORTED_LOCALES) {
	test(`loadMessages resolves catalog for supported locale "${code}"`, async () => {
		const messages = await loadMessages(code);
		expect(messages).toBeDefined();
		expect(typeof messages).toBe("object");
		expect(Object.keys(messages).length).toBeGreaterThan(0);
	});
}

test("loadMessages falls back to English for unknown locale", async () => {
	const [fallback, english] = await Promise.all([loadMessages("xx"), loadMessages("en")]);
	expect(fallback).toEqual(english);
});
