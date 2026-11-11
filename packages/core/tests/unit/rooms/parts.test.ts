import { describe, expect, it } from "vitest";

import { COMPACTION_BYTES } from "../../../src/rooms/limits.js";
import { splitText } from "../../../src/rooms/parts.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const utf8Length = (text: string) => encoder.encode(text).byteLength;
/** Whether the text survives UTF-8, which replaces a lone surrogate. */
const wellFormed = (text: string) => decoder.decode(encoder.encode(text)) === text;

describe("splitText", () => {
	it("keeps every part of CJK and emoji text within the limit in UTF-8, and round-trips", () => {
		const text = "漢字のテキスト😀🧑‍💻a".repeat(150_000);
		expect(utf8Length(text)).toBeGreaterThan(3 * COMPACTION_BYTES);

		const parts = splitText(text);

		expect(parts.length).toBeGreaterThan(3);
		for (const part of parts) {
			expect(utf8Length(part)).toBeLessThanOrEqual(COMPACTION_BYTES);
			expect(wellFormed(part)).toBe(true);
		}
		expect(parts.join("")).toBe(text);
	});

	it("moves an emoji that would cross the limit into the next part", () => {
		const head = "a".repeat(COMPACTION_BYTES - 1);

		expect(splitText(`${head}😀b`)).toEqual([head, "😀b"]);
	});

	it("splits ASCII text into parts of the limit", () => {
		const text = "x".repeat(2 * COMPACTION_BYTES + 5);

		expect(splitText(text).map((part) => part.length)).toEqual([
			COMPACTION_BYTES,
			COMPACTION_BYTES,
			5,
		]);
		expect(splitText("")).toEqual([""]);
	});
});
