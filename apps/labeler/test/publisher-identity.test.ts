import type { DidDocument } from "@atcute/identity";
import { describe, expect, it } from "vitest";

import { publisherHandleFromDidDocument } from "../src/assessment/publisher-identity.js";

describe("publisher identity", () => {
	it("extracts the first valid AT Protocol handle alias", () => {
		expect(
			publisherHandleFromDidDocument({
				id: "did:plc:publisher",
				alsoKnownAs: ["https://example.com/about", "at://publisher.example"],
			} as DidDocument),
		).toBe("publisher.example");
	});

	it("ignores missing and invalid handle aliases", () => {
		expect(
			publisherHandleFromDidDocument({
				id: "did:plc:publisher",
				alsoKnownAs: ["at://localhost", "at://bad_handle.example"],
			} as DidDocument),
		).toBeNull();
		expect(publisherHandleFromDidDocument({ id: "did:plc:publisher" } as DidDocument)).toBeNull();
	});
});
