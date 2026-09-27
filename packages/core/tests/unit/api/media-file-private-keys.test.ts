import { describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/media/file/[...key].js";

function invoke(key: string, download = vi.fn()) {
	return {
		download,
		response: GET({
			params: { key },
			locals: { emdash: { storage: { download } } },
			request: new Request("https://example.com"),
		} as never),
	};
}

describe("public media file route refuses private storage prefixes", () => {
	it.each([
		"backups/emdash-backup-2026-07-09T08-45-12-abcd1234.json",
		"transfers/imports/01HZ0000000000000000000000-0123456789abcdef0123456789abcdef/manifest.json",
		"transfers/exports/01HZ0000000000000000000000-0123456789abcdef0123456789abcdef/media/abc",
		"Transfers/imports/x/manifest.json",
		"BACKUPS/archive.json",
		"transfers%2Fimports%2Fx%2Fmanifest.json",
		"backups%2farchive.json",
		"transfers%252Fimports%252Fx",
		"%74ransfers/imports/x",
		"%2574ransfers%252Fimports",
		"./transfers/imports/x",
		"media/../transfers/imports/x",
		"media/%2e%2e/transfers/imports/x",
		"/transfers/imports/x",
		"\\transfers\\imports\\x",
		"transfers\\imports\\x",
		"media//transfers",
		"%25252574ransfers/x",
		"100%.png",
	])("returns 404 for %s without touching storage", async (key) => {
		const { download, response } = invoke(key);
		expect((await response).status).toBe(404);
		expect(download).not.toHaveBeenCalled();
	});

	it.each(["01HZABCDEF.png", "photos/01HZABCDEF.jpg", "my%20photo.png", "transfers-notes.png"])(
		"serves the ordinary key %s",
		async (key) => {
			const download = vi.fn(async () => ({
				body: new Blob(["x"]).stream(),
				contentType: "image/png",
				size: 1,
			}));
			const { response } = invoke(key, download);
			expect((await response).status).toBe(200);
			expect(download).toHaveBeenCalledWith(key);
		},
	);
});
