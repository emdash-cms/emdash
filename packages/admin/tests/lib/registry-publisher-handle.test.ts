import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDidToHandle } from "../../src/lib/api/registry";

const DID = "did:plc:uwbl4k3tza7eyjv3morkrld2";

function requestedUrls(fetchSpy: { mock: { calls: unknown[][] } }): URL[] {
	return fetchSpy.mock.calls.map(([input]) =>
		input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.href),
	);
}

describe("resolveDidToHandle", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("resolves through the admin API without contacting identity services", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ success: true, data: { status: "ok", handle: "mk.gg" } }));

		await expect(resolveDidToHandle(DID)).resolves.toEqual({ status: "ok", handle: "mk.gg" });

		const urls = requestedUrls(fetchSpy);
		expect(urls.map((url) => url.origin)).toEqual([window.location.origin]);
		expect(urls[0]!.pathname).toBe("/_emdash/api/admin/plugins/registry/publisher-handle");
		expect(urls[0]!.searchParams.get("did")).toBe(DID);
	});

	it("retries after an indeterminate lookup and caches the conclusive answer", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json(
					{ success: false, error: { code: "HANDLE_RESOLUTION_FAILED", message: "failed" } },
					{ status: 502 },
				),
			)
			.mockResolvedValueOnce(Response.json({ success: true, data: { status: "invalid" } }));

		await expect(resolveDidToHandle(DID)).resolves.toEqual({ status: "missing" });
		await expect(resolveDidToHandle(DID)).resolves.toEqual({ status: "invalid" });
		await expect(resolveDidToHandle(DID)).resolves.toEqual({ status: "invalid" });

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
