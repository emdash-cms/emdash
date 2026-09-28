import { computeMultihash } from "@emdash-cms/registry-verification";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
	loadStagedArtifact,
	persistStagedArtifact,
	PublicationStagingError,
} from "../src/publishing/staging.js";

const PUBLISHER_DID = "did:plc:publisher";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);

async function artifact() {
	const checksum = await computeMultihash(BYTES);
	if (!checksum.success) throw new Error(checksum.error.code);
	return {
		metadata: {
			path: "package" as const,
			checksum: checksum.value,
			mimeType: "application/gzip",
			size: BYTES.byteLength,
		},
		bytes: BYTES,
	};
}

describe("publication artifact staging", () => {
	it("writes deterministic create-only objects and replays matching bytes", async () => {
		const input = {
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			sourceUrl: "https://example.com/gallery.tar.gz",
			artifact: await artifact(),
		};
		const first = await persistStagedArtifact(env.PUBLICATION_STAGING, input);
		const replay = await persistStagedArtifact(env.PUBLICATION_STAGING, input);

		expect(replay).toEqual(first);
		await expect(loadStagedArtifact(env.PUBLICATION_STAGING, first)).resolves.toEqual({
			metadata: first.metadata,
			bytes: BYTES,
		});
	});

	it("rejects an existing object whose bytes do not match the staged checksum", async () => {
		const input = {
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			sourceUrl: "https://example.com/gallery.tar.gz",
			artifact: await artifact(),
		};
		const staged = await persistStagedArtifact(env.PUBLICATION_STAGING, input);
		await env.PUBLICATION_STAGING.put(staged.key, new Uint8Array(BYTES.byteLength));

		await expect(persistStagedArtifact(env.PUBLICATION_STAGING, input)).rejects.toMatchObject({
			code: "PUBLICATION_STAGING_CONFLICT",
		});
		await expect(loadStagedArtifact(env.PUBLICATION_STAGING, staged)).rejects.toBeInstanceOf(
			PublicationStagingError,
		);
	});

	it("uses a staging key that remains valid for screenshot slots", async () => {
		const screenshotBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const checksum = await computeMultihash(screenshotBytes);
		if (!checksum.success) throw new Error(checksum.error.code);
		const staged = await persistStagedArtifact(env.PUBLICATION_STAGING, {
			publisherDid: PUBLISHER_DID,
			intentId: "01JABCDEFGHJKMNPQRSTVWXYZ1",
			sourceUrl: "https://example.com/screenshot.png",
			artifact: {
				metadata: {
					path: "screenshots[0]",
					checksum: checksum.value,
					mimeType: "image/png",
					size: screenshotBytes.byteLength,
					width: 1,
					height: 1,
				},
				bytes: screenshotBytes,
			},
		});

		expect(staged.key).toContain("/screenshots-0/");
		expect(staged.key).not.toContain("[");
	});
});
