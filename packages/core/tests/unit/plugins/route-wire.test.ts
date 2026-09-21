import {
	PLUGIN_ROUTE_MAX_BODY_BYTES,
	PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES,
	PLUGIN_ROUTE_MAX_MULTIPART_PARTS,
} from "@emdash-cms/plugin-types";
import { describe, expect, it } from "vitest";

import { pluginResponse } from "../../../src/plugin-types.js";
import {
	parseDeclaredPluginRouteInput,
	pluginRouteResponseFromWire,
	pluginRouteResponseToWire,
} from "../../../src/plugins/route-wire.js";

function request(body: BodyInit, contentType = "application/octet-stream") {
	return new Request("https://example.com/plugin", {
		method: "POST",
		headers: { "content-type": contentType },
		body,
	});
}

describe("declared plugin route requests", () => {
	it("preserves invalid UTF-8 bytes for signature verification", async () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0, 13, 10, 128]);
		await expect(parseDeclaredPluginRouteInput(request(bytes), { body: "bytes" })).resolves.toEqual(
			bytes,
		);
	});

	it("rejects invalid UTF-8 in text mode", async () => {
		await expect(
			parseDeclaredPluginRouteInput(request(new Uint8Array([0xff])), { body: "text" }),
		).rejects.toMatchObject({ status: 400 });
	});

	it("parses declared JSON and rejects malformed JSON", async () => {
		await expect(
			parseDeclaredPluginRouteInput(request('{ "value": 1 }', "application/json"), {
				body: "json",
			}),
		).resolves.toEqual({ value: 1 });
		await expect(
			parseDeclaredPluginRouteInput(request("not-json", "application/json"), { body: "json" }),
		).rejects.toMatchObject({ status: 400 });
	});

	it("enforces the declared decoded byte limit while reading", async () => {
		await expect(
			parseDeclaredPluginRouteInput(request(new Uint8Array([1, 2, 3, 4])), {
				body: "bytes",
				maxBytes: 3,
			}),
		).rejects.toMatchObject({ status: 413 });
	});

	it("rejects a body when the route declares none", async () => {
		await expect(
			parseDeclaredPluginRouteInput(request("unexpected"), { body: "none" }),
		).rejects.toMatchObject({ status: 413 });
	});

	it("normalizes multipart text and file parts without losing bytes", async () => {
		const form = new FormData();
		form.append("title", "Report");
		form.append(
			"attachment",
			new File([new Uint8Array([0, 255, 128])], "report.bin", {
				type: "application/octet-stream",
			}),
		);
		const input = await parseDeclaredPluginRouteInput(
			new Request("https://example.com/plugin", { method: "POST", body: form }),
			{ body: "form-data", maxBytes: 2048 },
		);
		expect(input).toEqual({
			entries: [
				{ name: "title", kind: "text", value: "Report" },
				{
					name: "attachment",
					kind: "file",
					filename: "report.bin",
					contentType: "application/octet-stream",
					bytes: new Uint8Array([0, 255, 128]),
				},
			],
		});
	});

	it("bounds multipart part size and count", async () => {
		const large = new FormData();
		large.append(
			"attachment",
			new File([new Uint8Array(PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES + 1)], "large.bin"),
		);
		await expect(
			parseDeclaredPluginRouteInput(
				new Request("https://example.com/plugin", { method: "POST", body: large }),
				{ body: "form-data", maxBytes: PLUGIN_ROUTE_MAX_BODY_BYTES },
			),
		).rejects.toMatchObject({ status: 413 });

		const many = new URLSearchParams();
		for (let index = 0; index <= PLUGIN_ROUTE_MAX_MULTIPART_PARTS; index++) {
			many.append(`field-${index}`, "value");
		}
		await expect(
			parseDeclaredPluginRouteInput(
				request(many, "application/x-www-form-urlencoded;charset=UTF-8"),
				{ body: "form-data" },
			),
		).rejects.toMatchObject({ status: 413 });
	});
});

describe("raw plugin route responses", () => {
	it("preserves status and bytes while stripping host-controlled headers", async () => {
		const wire = await pluginRouteResponseToWire(
			pluginResponse({
				status: 201,
				headers: {
					"clear-site-data": '"cookies"',
					"content-type": "text/csv",
					"content-disposition": 'attachment; filename="report.csv"',
					"cloudflare-cdn-cache-control": "public, max-age=9999",
					"set-cookie": "session=secret",
					connection: "keep-alive",
					"cache-control": "public, max-age=9999",
					nel: '{"report_to":"plugin"}',
					"report-to": '{"group":"plugin"}',
					"x-plugin": "report",
				},
				body: { kind: "bytes", value: new Uint8Array([0, 255, 10]) },
			}),
		);
		const response = pluginRouteResponseFromWire(wire, "GET");
		expect(response.status).toBe(201);
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("connection")).toBeNull();
		expect(response.headers.get("cache-control")).toBeNull();
		expect(response.headers.get("clear-site-data")).toBeNull();
		expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
		expect(response.headers.get("nel")).toBeNull();
		expect(response.headers.get("report-to")).toBeNull();
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.csv"');
		expect(response.headers.get("x-plugin")).toBeNull();
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 10]));
	});

	it.each([
		"text/html",
		"application/javascript",
		"text/jscript",
		"text/livescript",
		"application/xhtml+xml",
		"image/svg+xml",
		"text/css",
		"application/wasm",
	])("rejects active same-origin content type %s", async (contentType) => {
		await expect(
			pluginRouteResponseToWire(
				pluginResponse({
					headers: { "content-type": contentType },
					body: { kind: "text", value: "x" },
				}),
			),
		).rejects.toThrow("not allowed");
	});

	it("requires the explicit response builder and bounds response bytes", async () => {
		await expect(pluginRouteResponseToWire({ status: 200, body: "plain" })).rejects.toThrow(
			"pluginResponse",
		);
		await expect(
			pluginRouteResponseToWire(
				pluginResponse({
					body: { kind: "bytes", value: new Uint8Array(PLUGIN_ROUTE_MAX_BODY_BYTES + 1) },
				}),
			),
		).rejects.toThrow("exceeds");
	});

	it("suppresses bodies for HEAD and bodyless statuses", async () => {
		const wire = await pluginRouteResponseToWire(
			pluginResponse({ body: { kind: "text", value: "hidden" } }),
		);
		expect(await pluginRouteResponseFromWire(wire, "HEAD").text()).toBe("");
		const noContent = await pluginRouteResponseToWire(pluginResponse({ status: 204 }));
		expect(await pluginRouteResponseFromWire(noContent, "GET").text()).toBe("");
	});
});
