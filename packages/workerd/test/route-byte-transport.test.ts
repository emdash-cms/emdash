import { afterEach, describe, expect, it } from "vitest";

import { MiniflareDevRunner } from "../src/sandbox/dev-runner.js";
import { parseRouteTransport, stringifyRouteTransport } from "../src/sandbox/wrapper.js";

const INVALID_UTF8 = new Uint8Array([0, 255, 195, 40]);

const RAW_ROUTE_PLUGIN = `
export default {
	routes: {
		bytes: {
			handler: async ({ input }) => ({
				__emdashPluginResponse: true,
				status: 206,
				headers: [["content-type", "application/octet-stream"]],
				body: { kind: "bytes", value: input }
			})
		},
		multipart: {
			handler: async ({ input }) => ({
				__emdashPluginResponse: true,
				status: 200,
				headers: [],
				body: { kind: "bytes", value: input.entries[1].bytes }
			})
		},
		ordinary: {
			handler: async () => ({
				status: 201,
				headers: [["x-test", "ordinary"]],
				body: { kind: "text", value: "not raw" }
			})
		},
		reserved: {
			handler: async () => ({
				bytes: { __emdashBytes: "ordinary" },
				escaped: { __emdashEscapedObject: [["key", "ordinary"]] }
			})
		}
	}
};
`;

function request() {
	return { method: "POST", url: "/api/raw", headers: {} };
}

describe("workerd route byte transport", () => {
	it("recursively round-trips bytes without changing ordinary objects", () => {
		const value = {
			input: INVALID_UTF8,
			multipart: { entries: [{ kind: "file", bytes: INVALID_UTF8 }] },
			ordinary: { status: 201, headers: [], body: { kind: "text", value: "not raw" } },
		};

		expect(parseRouteTransport(stringifyRouteTransport(value))).toEqual(value);
	});

	it("preserves ordinary objects that use reserved transport keys", () => {
		const value = {
			bytes: { __emdashBytes: "ordinary" },
			escaped: { __emdashEscapedObject: [["key", "ordinary"]] },
		};
		expect(parseRouteTransport(stringifyRouteTransport(value))).toEqual(value);
	});

	describe("Miniflare runner", () => {
		let runner: MiniflareDevRunner | null = null;

		afterEach(async () => {
			await runner?.terminateAll();
		});

		it("preserves raw response bytes and multipart file bytes through the wrapper", async () => {
			runner = new MiniflareDevRunner({ db: null as never });
			const plugin = await runner.load(
				{
					id: "raw-route-transport",
					version: "1.0.0",
					capabilities: [],
					allowedHosts: [],
					storage: {},
					hooks: [],
					routes: [],
					admin: {},
				},
				RAW_ROUTE_PLUGIN,
			);

			await expect(plugin.invokeRoute("bytes", INVALID_UTF8, request())).resolves.toEqual({
				__emdashPluginResponse: true,
				status: 206,
				headers: [["content-type", "application/octet-stream"]],
				body: { kind: "bytes", value: INVALID_UTF8 },
			});

			const multipart = {
				entries: [
					{ name: "caption", kind: "text", value: "binary" },
					{
						name: "upload",
						kind: "file",
						filename: "invalid.bin",
						contentType: "application/octet-stream",
						bytes: INVALID_UTF8,
					},
				],
			};
			const result = await plugin.invokeRoute("multipart", multipart, request());
			expect(result).toMatchObject({
				__emdashPluginResponse: true,
				body: { kind: "bytes", value: INVALID_UTF8 },
			});

			await expect(plugin.invokeRoute("ordinary", {}, request())).resolves.toEqual({
				status: 201,
				headers: [["x-test", "ordinary"]],
				body: { kind: "text", value: "not raw" },
			});
			await expect(plugin.invokeRoute("reserved", {}, request())).resolves.toEqual({
				bytes: { __emdashBytes: "ordinary" },
				escaped: { __emdashEscapedObject: [["key", "ordinary"]] },
			});
		}, 30_000);
	});
});
