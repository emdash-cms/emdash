import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
	createListingLabelSigner,
	InvalidListingLabelSignatureError,
	isVerifiedListingLabel,
	parseListingLabel,
	verifyListingLabel,
	type LabelDidDocument,
	type ListingLabelEvent,
	type SignedListingLabel,
} from "../src/index.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/label-crypto.json", import.meta.url), "utf8"),
) as {
	privateKey: string;
	multikey: string;
	label: ListingLabelEvent;
};

function document(): LabelDidDocument {
	return {
		id: fixture.label.src,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: fixture.label.src,
				publicKeyMultibase: fixture.multikey,
			},
		],
	};
}

async function signedLabel(): Promise<SignedListingLabel> {
	const signer = await createListingLabelSigner({
		issuerDid: fixture.label.src,
		privateKey: fixture.privateKey,
		resolveDid: async () => document(),
	});
	const { src: _src, ...unsigned } = fixture.label;
	return signer.sign(unsigned);
}

describe("listing label verification", () => {
	it("signs, verifies, freezes, and non-enumerably brands a canonical label", async () => {
		const verified = await verifyListingLabel({
			label: await signedLabel(),
			resolveDid: async () => document(),
		});

		const { neg: _neg, ...canonicalFixture } = fixture.label;
		expect(verified).toEqual(expect.objectContaining(canonicalFixture));
		expect(isVerifiedListingLabel(verified)).toBe(true);
		expect(Object.isFrozen(verified)).toBe(true);
		const symbols = Object.getOwnPropertySymbols(verified);
		expect(symbols).toHaveLength(1);
		expect(Object.getOwnPropertyDescriptor(verified, symbols[0]!)?.enumerable).toBe(false);
		expect(isVerifiedListingLabel({ ...verified })).toBe(false);
	});

	it("rejects signature and signed-field tampering", async () => {
		const signed = await signedLabel();
		const alteredSignature = Uint8Array.from(signed.sig);
		alteredSignature[0] ^= 0xff;

		for (const label of [
			{ ...signed, sig: alteredSignature },
			{ ...signed, val: "listing-pending" },
			{ ...signed, cid: "bafyreihf4k3kf5j7dmvclqmk3ypfopgcrf5jm5k4mls3tcbnkj2xszc3da" },
		]) {
			await expect(
				verifyListingLabel({ label, resolveDid: async () => document() }),
			).rejects.toBeInstanceOf(InvalidListingLabelSignatureError);
		}
	});

	it("rejects wrong URI schemes, malformed record URIs, CIDs, DIDs, and timestamps", () => {
		for (const label of [
			{ ...fixture.label, uri: "https://publisher.test/plugin" },
			{
				...fixture.label,
				uri: "at://did:example:publisher/com.emdashcms.experimental.package.profile",
			},
			{
				...fixture.label,
				uri: "at://did:example:publisher/com.emdashcms.experimental.package.profile/..",
			},
			{ ...fixture.label, cid: "bafy-not-a-cid" },
			{ ...fixture.label, src: "did:Example:labeler" },
			{ ...fixture.label, cts: "2026-02-30T12:00:00Z" },
		]) {
			expect(() => parseListingLabel(label)).toThrow(TypeError);
		}
	});

	it("rejects unsupported fields and accessor-backed label fields", () => {
		expect(() => parseListingLabel({ ...fixture.label, extra: true })).toThrow("unsupported field");
		let accessed = false;
		const accessor = { ...fixture.label };
		Object.defineProperty(accessor, "val", {
			enumerable: true,
			get() {
				accessed = true;
				return fixture.label.val;
			},
		});
		expect(() => parseListingLabel(accessor)).toThrow("label.val");
		expect(accessed).toBe(false);
	});
});
