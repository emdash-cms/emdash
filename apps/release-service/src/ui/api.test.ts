import { describe, expect, it } from "vitest";

import { parseApprovalResource } from "./api.js";

describe("approval UI response validation", () => {
	it("accepts the sanitized immutable review shape", () => {
		expect(
			parseApprovalResource({
				intent: {
					id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
					packageSlug: "gallery",
					version: "1.2.3",
					state: "awaiting_approval",
					expiresAt: 1_800_000_000_000,
				},
				evidence: { profileCid: "bafyprofile" },
				evidenceDigest: "D".repeat(43),
				review: {
					source: {
						repository: "example/gallery",
						workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
						commitSha: "a".repeat(40),
						runId: "100",
						actor: "release-bot",
					},
					artifact: { url: "https://example.com/gallery.tgz", checksum: "sha256:artifact" },
					provenance: {
						url: "https://example.com/provenance.json",
						checksum: "sha256:provenance",
						predicateType: "https://slsa.dev/provenance/v1",
						sourceRepository: "https://github.com/example/gallery",
						builderId:
							"https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
					},
					accessDiff: {
						escalation: true,
						changes: [
							{
								kind: "operation-added",
								category: "network",
								operation: "request",
								path: ["network", "request"],
								escalation: true,
							},
						],
					},
				},
			}),
		).toMatchObject({ review: { source: { repository: "example/gallery" } } });
	});
});
