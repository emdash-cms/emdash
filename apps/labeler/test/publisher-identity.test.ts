import type { DidDocument } from "@atcute/identity";
import { describe, expect, it, vi } from "vitest";

import {
	publisherHandleFromDidDocument,
	verifiedHandleDid,
} from "../src/assessment/publisher-identity.js";

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

describe("verified handle DID", () => {
	const DID = "did:plc:publisher";

	function resolvers(
		document: { id: string; alsoKnownAs?: string[] } | Error,
		resolvedDid: string | Error = DID,
	) {
		const handleResolver = {
			resolve: vi.fn(async () => {
				if (resolvedDid instanceof Error) throw resolvedDid;
				return resolvedDid as `did:plc:${string}`;
			}),
		};
		const didResolver = {
			resolve: vi.fn(async () => {
				if (document instanceof Error) throw document;
				return document as unknown as DidDocument;
			}),
		};
		return { handleResolver, didResolver };
	}

	it("returns the DID when its document claims the handle back", async () => {
		const { handleResolver, didResolver } = resolvers({
			id: DID,
			alsoKnownAs: ["at://publisher.example"],
		});

		expect(await verifiedHandleDid("Publisher.Example", handleResolver, didResolver)).toBe(DID);
		expect(handleResolver.resolve).toHaveBeenCalledWith("publisher.example");
		expect(didResolver.resolve).toHaveBeenCalledWith(DID);
	});

	it.each([
		["a different handle", { id: DID, alsoKnownAs: ["at://other.example"] }],
		["no handle", { id: DID }],
		["a different document id", { id: "did:plc:other", alsoKnownAs: ["at://publisher.example"] }],
	])("rejects a DID document that claims %s", async (_case, document) => {
		const { handleResolver, didResolver } = resolvers(document);

		expect(await verifiedHandleDid("publisher.example", handleResolver, didResolver)).toBeNull();
	});

	it("returns null when handle or DID resolution fails", async () => {
		const handleFailure = resolvers({ id: DID }, new Error("no handle"));
		expect(
			await verifiedHandleDid(
				"publisher.example",
				handleFailure.handleResolver,
				handleFailure.didResolver,
			),
		).toBeNull();

		const documentFailure = resolvers(new Error("no document"));
		expect(
			await verifiedHandleDid(
				"publisher.example",
				documentFailure.handleResolver,
				documentFailure.didResolver,
			),
		).toBeNull();
	});

	it("rejects an invalid handle without resolving it", async () => {
		const { handleResolver, didResolver } = resolvers({ id: DID });

		expect(await verifiedHandleDid("not a handle", handleResolver, didResolver)).toBeNull();
		expect(handleResolver.resolve).not.toHaveBeenCalled();
	});
});
