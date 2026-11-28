// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { editorFixtures } from "../../utils/admin-portable-text-round-trip.js";
import { destroyInlineEditors, roundTripInline } from "../../utils/inline-portable-text.js";

afterEach(destroyInlineEditors);

describe("inline editor round trip", () => {
	it.each(editorFixtures)("saves $name unchanged", ({ blocks }) => {
		expect(roundTripInline(blocks)).toEqual(blocks);
	});
});
