import { describe, expect, it, vi } from "vitest";

import {
	PLAYGROUND_MEDIA_ASSETS,
	PlaygroundAssetsStorage,
} from "../../src/db/playground-assets-storage.js";

function assetResponse(contentType = "image/jpeg", size = PLAYGROUND_MEDIA_ASSETS[0]!.size) {
	return new Response(new Uint8Array([1]), {
		headers: { "Content-Type": contentType, "Content-Length": String(size) },
	});
}

describe("PlaygroundAssetsStorage", () => {
	it("streams an allowlisted Worker Asset through the media storage contract", async () => {
		const fetch = vi.fn().mockResolvedValue(assetResponse());
		const storage = new PlaygroundAssetsStorage({ fetch });
		const asset = PLAYGROUND_MEDIA_ASSETS[0]!;

		const download = await storage.download(asset.storageKey);

		expect(download).toMatchObject({ contentType: asset.mimeType, size: asset.size });
		expect(fetch).toHaveBeenCalledOnce();
		const request = fetch.mock.calls[0]![0] as Request;
		expect(new URL(request.url).pathname).toBe(`/playground-media/${asset.storageKey}`);
		await download.body.cancel();
	});

	it("rejects keys outside the bundled manifest without calling Worker Assets", async () => {
		const fetch = vi.fn();
		const storage = new PlaygroundAssetsStorage({ fetch });

		await expect(storage.download("../server.js")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects bundled responses whose metadata does not match the manifest", async () => {
		const fetch = vi.fn().mockResolvedValue(assetResponse("text/html"));
		const storage = new PlaygroundAssetsStorage({ fetch });

		await expect(storage.download(PLAYGROUND_MEDIA_ASSETS[0]!.storageKey)).rejects.toMatchObject({
			code: "DOWNLOAD_FAILED",
		});
	});

	it("keeps every mutating storage operation unavailable", async () => {
		const storage = new PlaygroundAssetsStorage({ fetch: vi.fn() });

		await expect(storage.upload()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
		await expect(storage.delete()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
		await expect(storage.getSignedUploadUrl()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
		await expect(storage.list()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
	});
});
