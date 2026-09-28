import { describe, expect, it, vi } from "vitest";

import { createDohHostnameResolver } from "../src/runtime-network.js";

describe("runtime DNS resolution", () => {
	it("combines bounded Cloudflare DNS A and AAAA answers", async () => {
		const fetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			const type = url.searchParams.get("type");
			return Response.json({
				Status: 0,
				Answer:
					type === "A"
						? [{ type: 1, data: "93.184.216.34" }]
						: [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }],
			});
		});
		const resolve = createDohHostnameResolver(fetch);
		await expect(resolve("example.com")).resolves.toEqual([
			"93.184.216.34",
			"2606:2800:220:1:248:1893:25c8:1946",
		]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("accepts a successful DNS response with no records for one address family", async () => {
		const resolve = createDohHostnameResolver(async (input, init) => {
			if (init?.redirect !== "manual") throw new TypeError("unsupported redirect mode");
			const url = new URL(input instanceof Request ? input.url : input);
			return url.searchParams.get("type") === "A"
				? Response.json({ Status: 0, Answer: [{ type: 1, data: "3.20.120.138" }] })
				: Response.json({ Status: 0 });
		});

		await expect(resolve("plc.directory")).resolves.toEqual(["3.20.120.138"]);
	});

	it("fails closed on a malformed or unsuccessful DNS response", async () => {
		const resolve = createDohHostnameResolver(async () => Response.json({ Status: 2 }));
		await expect(resolve("example.com")).rejects.toThrow(/DNS query failed/);
	});
});
