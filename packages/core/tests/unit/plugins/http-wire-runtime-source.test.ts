import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

import { build } from "vite";
import { describe, expect, it } from "vitest";

import {
	generatePluginHttpWireRuntimeSource,
	PLUGIN_HTTP_MAX_REQUEST_BYTES,
} from "../../../src/plugins/http-wire.js";
import { bytesOverLimit, INVALID_PLUGIN_HTTP_BYTES } from "../../fixtures/plugin-http.js";

type RuntimeHelpers = {
	bufferPluginHttpRequest(init: RequestInit): Promise<RequestInit>;
	pluginHttpResponseFromWire(wire: {
		status: number;
		statusText: string;
		headers: Array<[string, string]>;
		finalUrl: string;
		redirected: boolean;
		body: Uint8Array;
	}): Response;
};

function runtimeHelpers(source = generatePluginHttpWireRuntimeSource()): RuntimeHelpers {
	// eslint-disable-next-line no-implied-eval -- executes the generated isolate helper module in a local scope
	return new Function(
		`${source}\nreturn { bufferPluginHttpRequest, pluginHttpResponseFromWire };`,
	)();
}

async function bundledRuntimeSource(): Promise<string> {
	const entryId = "virtual:plugin-http-wire-entry";
	const resolvedEntryId = `\0${entryId}`;
	const httpWirePath = fileURLToPath(new URL("../../../src/plugins/http-wire.ts", import.meta.url));
	const output = await build({
		logLevel: "silent",
		plugins: [
			{
				name: "plugin-http-wire-runtime-test",
				resolveId(id) {
					return id === entryId ? resolvedEntryId : undefined;
				},
				load(id) {
					if (id !== resolvedEntryId) return undefined;
					return `
						import { generatePluginHttpWireRuntimeSource } from ${JSON.stringify(httpWirePath)};
						const PLUGIN_HTTP_MAX_REQUEST_BYTES = 1;
						export const collision = PLUGIN_HTTP_MAX_REQUEST_BYTES;
						export const source = generatePluginHttpWireRuntimeSource();
					`;
				},
			},
		],
		build: {
			write: false,
			minify: true,
			ssr: true,
			rollupOptions: { input: entryId },
		},
	});
	if ("on" in output) throw new Error("Expected a completed Vite build");
	const builds = Array.isArray(output) ? output : [output];
	const chunk = builds.flatMap((result) => result.output).find((item) => item.type === "chunk");
	if (!chunk || chunk.type !== "chunk") throw new Error("Generated runtime bundle is missing");
	const bundled: unknown = await import(
		`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
	);
	if (!bundled || typeof bundled !== "object") throw new Error("Generated bundle is invalid");
	const source = Reflect.get(bundled, "source");
	if (typeof source !== "string") throw new Error("Generated bundle did not export source");
	return source;
}

describe("generated plugin HTTP wire runtime", () => {
	it("uses the canonical request limit", async () => {
		const { bufferPluginHttpRequest } = runtimeHelpers();
		await expect(
			bufferPluginHttpRequest({ body: bytesOverLimit(PLUGIN_HTTP_MAX_REQUEST_BYTES) }),
		).rejects.toThrow(`request body exceeds the ${PLUGIN_HTTP_MAX_REQUEST_BYTES} byte limit`);
	});

	it("preserves response bytes, metadata, and clone decoration", async () => {
		const { pluginHttpResponseFromWire } = runtimeHelpers();
		const response = pluginHttpResponseFromWire({
			status: 206,
			statusText: "Partial Content",
			headers: [["content-type", "application/octet-stream"]],
			finalUrl: "https://cdn.example.com/final",
			redirected: true,
			body: INVALID_PLUGIN_HTTP_BYTES,
		});
		const clone = response.clone();

		expect(response.status).toBe(206);
		expect(response.statusText).toBe("Partial Content");
		expect(response.url).toBe("https://cdn.example.com/final");
		expect(response.redirected).toBe(true);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(INVALID_PLUGIN_HTTP_BYTES);
		expect(new Uint8Array(await clone.arrayBuffer())).toEqual(INVALID_PLUGIN_HTTP_BYTES);
		expect(clone.url).toBe("https://cdn.example.com/final");
	});

	it("survives production bundling, minification, and identifier collisions", async () => {
		const { bufferPluginHttpRequest } = runtimeHelpers(await bundledRuntimeSource());
		const buffered = await bufferPluginHttpRequest({ body: "payload" });
		expect(await new Response(buffered.body).text()).toBe("payload");
	});
});
