import { createHash, createPublicKey, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { INITIAL_LISTING_POLICY_FIXTURE } from "../src/fixtures/index.js";
import { ListingModerationPolicySchema } from "../src/policy.js";
import cryptoVector from "./fixtures/p256-label-v1.json" with { type: "json" };

describe("listing policy contract", () => {
	it("keeps positive, state, and redaction authorities independent", () => {
		const policy = ListingModerationPolicySchema.parse(INITIAL_LISTING_POLICY_FIXTURE);

		expect(policy.requiredPositiveSources).not.toEqual(policy.acceptedStateSources);
		expect(policy.redactionSources).not.toEqual(policy.requiredPositiveSources);
	});

	it("rejects a policy without a required positive source", () => {
		expect(() =>
			ListingModerationPolicySchema.parse({
				...INITIAL_LISTING_POLICY_FIXTURE,
				requiredPositiveSources: [],
			}),
		).toThrow(/must not be empty/);
	});

	it("rejects duplicate prohibited categories", () => {
		expect(() =>
			ListingModerationPolicySchema.parse({
				...INITIAL_LISTING_POLICY_FIXTURE,
				prohibitedCategories: ["scam-or-spam", "scam-or-spam"],
			}),
		).toThrow(/must not contain duplicates/);
	});

	it("retains the independently generated P-256 interoperability vector", () => {
		const canonical = Buffer.from(cryptoVector.canonicalCborHex, "hex");
		const spki = Buffer.from(
			`3039301306072a8648ce3d020106082a8648ce3d030107032200${cryptoVector.key.publicKeyRawHex}`,
			"hex",
		);
		const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
		expect(cryptoVector.provenance.independentSource).toContain("bluesky-social/atproto");
		expect(createHash("sha256").update(canonical).digest("hex")).toBe(cryptoVector.sha256Hex);
		for (const signature of Object.values(cryptoVector.signatures)) {
			expect(
				verify(
					"sha256",
					canonical,
					{ key: publicKey, dsaEncoding: "ieee-p1363" },
					Buffer.from(signature, "hex"),
				),
			).toBe(true);
		}
		expect(cryptoVector.signatures.atcuteWebcryptoHex).not.toBe(
			cryptoVector.signatures.atprotoReferenceHex,
		);
	});
});
