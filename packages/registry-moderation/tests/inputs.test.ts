import { describe, expect, it } from "vitest";

import { NormalizedModerationFindingSchema } from "../src/findings.js";
import {
	MODERATION_INPUT_FIELDS_FIXTURE,
	PROFILE_MODERATION_INPUT_FIXTURE,
	PROHIBITED_ASSESSMENT_INPUTS_FIXTURE,
	RELEASE_MODERATION_INPUT_FIXTURE,
} from "../src/fixtures/index.js";
import {
	CanonicalProfileModerationInputSchema,
	CanonicalReleaseModerationInputSchema,
} from "../src/inputs.js";

describe("canonical moderation inputs", () => {
	it("accepts every rendered profile and release field in the frozen fixtures", () => {
		expect(CanonicalProfileModerationInputSchema.parse(PROFILE_MODERATION_INPUT_FIXTURE)).toEqual(
			PROFILE_MODERATION_INPUT_FIXTURE,
		);
		expect(CanonicalReleaseModerationInputSchema.parse(RELEASE_MODERATION_INPUT_FIXTURE)).toEqual(
			RELEASE_MODERATION_INPUT_FIXTURE,
		);
		expect(MODERATION_INPUT_FIELDS_FIXTURE.profile).toContain("slug");
		expect(MODERATION_INPUT_FIELDS_FIXTURE.release).toEqual(
			expect.arrayContaining([
				"version",
				"repositoryUrl",
				"requires.constraints",
				"sbom.url",
				"media.screenshot",
			]),
		);
	});

	it.each([
		["package artifact", { artifacts: { package: { url: "https://trap.invalid/package" } } }],
		["manifest", { manifest: { backend: "backend.js" } }],
		["declared access", { declaredAccess: { network: true } }],
		["provenance", { provenance: { url: "https://trap.invalid/provenance" } }],
		["source archive", { sourceArchive: { url: "https://trap.invalid/source" } }],
	] as const)("rejects %s from the model input boundary", (_name, extra) => {
		expect(() =>
			CanonicalReleaseModerationInputSchema.parse({
				...RELEASE_MODERATION_INPUT_FIXTURE,
				...extra,
			}),
		).toThrow(/unsupported field/);
	});

	it("allows only SBOM display descriptors", () => {
		expect(() =>
			CanonicalReleaseModerationInputSchema.parse({
				...RELEASE_MODERATION_INPUT_FIXTURE,
				sbom: {
					...RELEASE_MODERATION_INPUT_FIXTURE.sbom,
					checksum: "trap-checksum",
					document: { components: [] },
				},
			}),
		).toThrow(/unsupported field/);
	});

	it("rejects profile sections and media entries that official clients do not render", () => {
		expect(() =>
			CanonicalProfileModerationInputSchema.parse({
				...PROFILE_MODERATION_INPUT_FIXTURE,
				sections: { hiddenPublisherHeading: "This is not rendered" },
			}),
		).toThrow(/do not render/);
		expect(() =>
			CanonicalReleaseModerationInputSchema.parse({
				...RELEASE_MODERATION_INPUT_FIXTURE,
				media: [
					...RELEASE_MODERATION_INPUT_FIXTURE.media,
					{
						kind: "documentation",
						index: 0,
						url: "https://trap.invalid/docs",
						checksum: "bafydocs",
					},
				],
			}),
		).toThrow(/not display media/);
	});

	it("binds the canonical subject URI and CID to the publisher identity", () => {
		for (const subject of [
			{ ...PROFILE_MODERATION_INPUT_FIXTURE.subject, uri: "not-an-at-uri" },
			{ ...PROFILE_MODERATION_INPUT_FIXTURE.subject, cid: "not-a-cid" },
			{
				...PROFILE_MODERATION_INPUT_FIXTURE.subject,
				uri: PROFILE_MODERATION_INPUT_FIXTURE.subject.uri.replace(
					PROFILE_MODERATION_INPUT_FIXTURE.publisherDid,
					"did:plc:anotherpublisher",
				),
			},
		]) {
			expect(() =>
				CanonicalProfileModerationInputSchema.parse({
					...PROFILE_MODERATION_INPUT_FIXTURE,
					subject,
				}),
			).toThrow();
		}
		expect(() =>
			CanonicalProfileModerationInputSchema.parse({
				...PROFILE_MODERATION_INPUT_FIXTURE,
				slug: "different-package",
			}),
		).toThrow();
		expect(() =>
			CanonicalReleaseModerationInputSchema.parse({
				...RELEASE_MODERATION_INPUT_FIXTURE,
				version: "9.9.9",
			}),
		).toThrow();
	});

	it("enumerates package, SBOM, provenance, and source-content prohibitions", () => {
		expect(PROHIBITED_ASSESSMENT_INPUTS_FIXTURE.neverFetch).toEqual(
			expect.arrayContaining([
				"release.artifacts.package.url",
				"release.sbom.url",
				"release.provenance.url",
				"release.sourceArchive.url",
			]),
		);
		expect(PROHIBITED_ASSESSMENT_INPUTS_FIXTURE.neverModel).toEqual(
			expect.arrayContaining([
				"release.artifacts.package",
				"release.sbom.document",
				"release.provenance",
				"release.sourceRepository.content",
			]),
		);
	});

	it("rejects unknown finding categories and label-shaped model output", () => {
		expect(
			NormalizedModerationFindingSchema.safeParse({
				category: "malware",
				recommendation: "review",
				confidence: 0.9,
				summary: "Unexpected category",
				evidenceRefs: ["profile.name"],
			}),
		).toMatchObject({ success: false });
		expect(
			NormalizedModerationFindingSchema.safeParse({
				category: "scam-or-spam",
				recommendation: "review",
				confidence: 0.9,
				summary: "Review this listing",
				evidenceRefs: ["profile.name"],
				label: "listing-blocked",
			}),
		).toMatchObject({ success: false });
	});
});
