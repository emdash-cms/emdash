import type { FetchHandlerObject } from "@atcute/client";
import type { PackageRelease } from "@emdash-cms/registry-lexicons";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it, vi } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import { createReleaseRecord, uploadReleaseBlob } from "../src/publishing/create-only.js";

describe("create-only release client", () => {
	it("rejects a create receipt whose CID is not a valid CID", async () => {
		const handle = vi.fn(async () =>
			Response.json({
				uri: `at://did:plc:publisher/${NSID.packageRelease}/gallery:1.2.3`,
				cid: "bafyfakecid",
			}),
		);

		await expect(
			createReleaseRecord(
				{ handle },
				{
					publisherDid: "did:plc:publisher",
					rkey: "gallery:1.2.3",
					record: structuredClone(releaseFixture) as PackageRelease.Main,
				},
			),
		).rejects.toMatchObject({ code: "CREATE_RESPONSE_INVALID" });
	});

	it("calls only createRecord with validation enabled", async () => {
		const handle = vi.fn(async (_pathname: string, _init: RequestInit) =>
			Response.json({
				uri: `at://did:plc:publisher/${NSID.packageRelease}/gallery:1.2.3`,
				cid: "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe",
			}),
		);
		const session: FetchHandlerObject = { handle };
		await expect(
			createReleaseRecord(session, {
				publisherDid: "did:plc:publisher",
				rkey: "gallery:1.2.3",
				record: structuredClone(releaseFixture) as PackageRelease.Main,
			}),
		).resolves.toMatchObject({ cid: expect.any(String) });
		expect(handle).toHaveBeenCalledOnce();
		expect(handle.mock.calls[0]?.[0]).toBe("/xrpc/com.atproto.repo.createRecord");
		const init = handle.mock.calls[0]?.[1];
		expect(init?.method).toBe("post");
		expect(typeof init?.body).toBe("string");
		if (typeof init?.body !== "string") throw new Error("Expected serialized createRecord body");
		expect(JSON.parse(init.body)).toMatchObject({
			repo: "did:plc:publisher",
			collection: NSID.packageRelease,
			rkey: "gallery:1.2.3",
			validate: true,
		});
	});

	it("uploads blob bytes with their verified content type", async () => {
		const bytes = new Uint8Array([0x1f, 0x8b, 0x08]);
		const blob = {
			$type: "blob" as const,
			ref: { $link: "bafkreia6n3lf256wgzhov3k2orn2lreyllrloag5qxl467ycpppsssrt7q" },
			mimeType: "application/gzip",
			size: bytes.byteLength,
		};
		const handle = vi.fn(async (_pathname: string, _init: RequestInit) => Response.json({ blob }));

		await expect(uploadReleaseBlob({ handle }, bytes, "application/gzip")).resolves.toEqual(blob);
		expect(handle).toHaveBeenCalledOnce();
		expect(handle.mock.calls[0]?.[0]).toBe("/xrpc/com.atproto.repo.uploadBlob");
		const init = handle.mock.calls[0]?.[1];
		expect(init?.headers).toEqual({ "content-type": "application/gzip" });
		expect(init?.body).toEqual(bytes);
	});
});
