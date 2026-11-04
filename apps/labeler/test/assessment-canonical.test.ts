import type { RegistryRecords } from "@emdash-cms/registry-lexicons";
import { computeMultihash } from "@emdash-cms/registry-verification/checksum";
import { describe, expect, it } from "vitest";

import { buildCanonicalAssessmentInput } from "../src/assessment/canonical.js";
import { checkModerationLinks } from "../src/assessment/links.js";
import { verifyExactRegistryRecord } from "../src/assessment/records.js";
import {
	PNG_BYTES,
	PROFILE_CID,
	PROFILE_RECORD,
	PROFILE_URI,
	PUBLISHER_DID,
	RELEASE_CID,
	RELEASE_URI,
	createReleaseRecord,
} from "./assessment-fixtures.js";

describe("canonical assessment input", () => {
	it("requires exact URI and CID verification before canonicalization", async () => {
		const verifier = {
			async verifyExactRecord() {
				return {
					uri: PROFILE_URI,
					cid: "bafywrongcid00000000",
					record: PROFILE_RECORD,
					verification: "did-mst-signature" as const,
				};
			},
		};
		await expect(
			verifyExactRegistryRecord(verifier, {
				uri: PROFILE_URI,
				cid: PROFILE_CID,
				kind: "profile",
			}),
		).rejects.toThrow(/does not match/);
	});

	it("projects only rendered profile fields and treats links as inert strings", async () => {
		const verified = await verifyExactRegistryRecord(
			{
				async verifyExactRecord() {
					return {
						uri: PROFILE_URI,
						cid: PROFILE_CID,
						record: {
							...PROFILE_RECORD,
							sections: { ...PROFILE_RECORD.sections, unrendered: "Not shown by admin" },
						},
						verification: "did-mst-signature" as const,
					};
				},
			},
			{ uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
		);
		const canonical = buildCanonicalAssessmentInput(verified);
		expect(canonical).toMatchObject({
			kind: "profile",
			input: {
				publisherDid: PUBLISHER_DID,
				slug: "gallery",
				name: "Gallery",
			},
			media: [],
		});
		expect(canonical.text).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ref: "profile.sections.description", format: "markdown" }),
			]),
		);
		expect(canonical.links.map(({ ref }) => ref)).toEqual([
			"profile.authors[0].url",
			"profile.security[0].url",
			"profile.sections.description.links[0]",
		]);
		expect(canonical.links.at(-1)).toMatchObject({
			usage: "markdown",
			url: "https://trap.invalid/markdown",
		});
		expect(checkModerationLinks(canonical.links).every(({ issues }) => issues.length === 0)).toBe(
			true,
		);
		expect(canonical.text.some(({ ref }) => ref === "profile.sections.unrendered")).toBe(false);
	});

	it("projects release descriptors without package, SBOM, provenance, or source content", async () => {
		const checksum = await computeMultihash(PNG_BYTES);
		if (!checksum.success) throw new Error("test checksum could not be computed");
		const record = createReleaseRecord(checksum.value);
		const verified = await verifyExactRegistryRecord(
			{
				async verifyExactRecord() {
					return {
						uri: RELEASE_URI,
						cid: RELEASE_CID,
						record,
						verification: "did-mst-signature" as const,
					};
				},
			},
			{ uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" },
		);
		const canonical = buildCanonicalAssessmentInput(verified);
		expect(canonical).toMatchObject({
			kind: "release",
			input: {
				packageSlug: "gallery",
				version: "1.2.3",
				repositoryUrl: "https://trap.invalid/repository",
				sbom: { format: "cyclonedx", url: "https://trap.invalid/sbom" },
			},
		});
		expect(canonical.media).toHaveLength(1);
		expect(canonical.media[0]).toMatchObject({
			kind: "icon",
			url: "https://media.example/icon.png",
			checksum: checksum.value,
		});
		const serialized = JSON.stringify(canonical.input);
		expect(serialized).not.toContain("package.tgz");
		expect(serialized).not.toContain("provenance");
		expect(serialized).not.toContain("declaredAccess");
		expect(serialized).not.toContain("bafysbomtrap");
		expect(canonical.links.map(({ ref }) => ref)).toEqual([
			"release.repositoryUrl",
			"release.sbom.url",
		]);
		expect(canonical.text.filter(({ ref }) => ref.startsWith("release.requires"))).toEqual([
			{ ref: "release.requires[0].key", value: "env:astro", format: "plain" },
			{ ref: "release.requires[0].constraint", value: ">=6.0.0", format: "plain" },
			{ ref: "release.requires[1].key", value: "env:emdash", format: "plain" },
			{ ref: "release.requires[1].constraint", value: ">=0.9.0", format: "plain" },
		]);
	});

	it("projects blob-backed display media through the record-scoped Cumulus URL", async () => {
		const checksum = await computeMultihash(PNG_BYTES);
		if (!checksum.success) throw new Error("test checksum could not be computed");
		const record: RegistryRecords["com.emdashcms.experimental.package.release"] =
			createReleaseRecord(checksum.value);
		const icon = record.artifacts.icon;
		if (!icon) throw new Error("test icon is missing");
		icon.blob = {
			$type: "blob",
			ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
			mimeType: "image/png",
			size: PNG_BYTES.byteLength,
		};
		delete icon.url;
		const verified = await verifyExactRegistryRecord(
			{
				async verifyExactRecord() {
					return {
						uri: RELEASE_URI,
						cid: RELEASE_CID,
						record,
						verification: "did-mst-signature" as const,
					};
				},
			},
			{ uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" },
		);

		const canonical = buildCanonicalAssessmentInput(verified);

		expect(canonical.media[0]?.url).toBe(
			`https://cdn.em-da.sh/r/did:plc:assessmentfixture00000000/com.emdashcms.experimental.package.release/gallery:1.2.3/${RELEASE_CID}/bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe`,
		);
	});

	it.each(["package", "sbom", "repository", "provenance", "source"] as const)(
		"rejects display media aliasing the %s never-fetch URL",
		async (source: "package" | "sbom" | "repository" | "provenance" | "source") => {
			const checksum = await computeMultihash(PNG_BYTES);
			if (!checksum.success) throw new Error("test checksum could not be computed");
			const rawRecord = createReleaseRecord(checksum.value);
			const aliases: Record<
				"package" | "sbom" | "repository" | "provenance" | "source",
				`${string}:${string}`
			> = {
				package: rawRecord.artifacts.package.url,
				sbom: rawRecord.sbom.url,
				repository: rawRecord.repo,
				provenance: "https://trap.invalid/provenance",
				source: "https://trap.invalid/source",
			};
			const record: RegistryRecords["com.emdashcms.experimental.package.release"] = rawRecord;
			if (!record.artifacts.icon) throw new Error("test icon is missing");
			record.artifacts.icon.url = `${aliases[source]}#display-fragment`;
			const verified = await verifyExactRegistryRecord(
				{
					async verifyExactRecord() {
						return {
							uri: RELEASE_URI,
							cid: RELEASE_CID,
							record,
							verification: "did-mst-signature" as const,
						};
					},
				},
				{ uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" },
			);
			expect(() => buildCanonicalAssessmentInput(verified)).toThrow(/aliases a non-display/);
		},
	);

	it("rejects malformed and control-character requirement keys before evidence refs are built", async () => {
		const record = {
			...createReleaseRecord("bafymediachecksum"),
			requires: { "env:emdash\u0000trap": ">=0.9.0" },
		};
		const verified = await verifyExactRegistryRecord(
			{
				async verifyExactRecord() {
					return {
						uri: RELEASE_URI,
						cid: RELEASE_CID,
						record,
						verification: "did-mst-signature" as const,
					};
				},
			},
			{ uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" },
		);
		expect(() => buildCanonicalAssessmentInput(verified)).toThrow(/invalid displayed constraint/);
	});

	it("rejects release identities that do not match the verified record key", async () => {
		const record = { ...createReleaseRecord("bafymediachecksum"), version: "2.0.0" };
		await expect(
			verifyExactRegistryRecord(
				{
					async verifyExactRecord() {
						return {
							uri: RELEASE_URI,
							cid: RELEASE_CID,
							record,
							verification: "did-mst-signature" as const,
						};
					},
				},
				{ uri: RELEASE_URI, cid: RELEASE_CID, kind: "release" },
			),
		).rejects.toThrow(/record key/);
	});
});
