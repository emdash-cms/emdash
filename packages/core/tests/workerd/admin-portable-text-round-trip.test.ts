import { describe, expect, it } from "vitest";

import {
	editorFixtures,
	roundTripThroughSharedDocument,
} from "../utils/admin-portable-text-round-trip.js";

describe("admin Portable Text through a shared document in workerd", () => {
	it.each(editorFixtures)("keeps $name unchanged", ({ blocks, pluginTypes }) => {
		expect(roundTripThroughSharedDocument(blocks, pluginTypes)).toEqual(blocks);
	});
});
