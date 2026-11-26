import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getIcon } from "../../../src/astro/routes/api/admin/plugins/marketplace/[id]/icon.js";
import { GET as getThumbnail } from "../../../src/astro/routes/api/admin/themes/marketplace/[id]/thumbnail.js";

const MARKETPLACE = "https://marketplace.example.com";
const MARKUP = "<script>document.title = location.origin</script>";

function context(): APIContext {
	return {
		params: { id: "test" },
		url: new URL("http://site.test/"),
		locals: {
			emdash: { db: {}, config: { marketplace: MARKETPLACE } },
			user: { id: "editor-1", role: Role.EDITOR },
		},
	} as unknown as APIContext;
}

function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { Location: location } });
}

describe.each([
	["plugin icon", getIcon],
	["theme thumbnail", getThumbnail],
])("marketplace %s proxy", (_name, handler) => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("refuses a redirect to another origin without fetching it", async () => {
		fetchSpy.mockResolvedValueOnce(redirect("http://127.0.0.1:8933/internal-secret"));

		const response = await handler(context());

		expect(response.status).toBe(502);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("PROXY_REDIRECT_UNTRUSTED");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("follows a redirect that stays on the marketplace origin", async () => {
		fetchSpy
			.mockResolvedValueOnce(redirect("/cdn/image.png"))
			.mockResolvedValueOnce(
				new Response("image-bytes", { headers: { "Content-Type": "image/png" } }),
			);

		const response = await handler(context());

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("image-bytes");
		expect(fetchSpy.mock.calls[1]![0]).toBe(`${MARKETPLACE}/cdn/image.png`);
	});

	it("stops a same-origin redirect loop", async () => {
		fetchSpy.mockImplementation(async () => redirect("/loop"));

		const response = await handler(context());

		expect(response.status).toBe(502);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("PROXY_TOO_MANY_REDIRECTS");
	});

	it.each([
		["image/png", "image/png"],
		["image/webp", "image/webp"],
		["IMAGE/JPEG; charset=binary", "image/jpeg"],
	])("relays %s as a download that is never sniffed", async (upstreamType, servedType) => {
		fetchSpy.mockResolvedValueOnce(
			new Response("image-bytes", { headers: { "Content-Type": upstreamType } }),
		);

		const response = await handler(context());

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(servedType);
		expect(response.headers.get("Content-Disposition")).toBe("attachment");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(await response.text()).toBe("image-bytes");
	});

	it.each([
		["text/html; charset=utf-8"],
		["application/xhtml+xml"],
		["image/svg+xml"],
		["text/xml"],
		["application/octet-stream"],
		[null],
	])("refuses a marketplace body served as %s", async (upstreamType) => {
		const upstream = new Response(MARKUP);
		if (upstreamType) upstream.headers.set("Content-Type", upstreamType);
		else upstream.headers.delete("Content-Type");
		fetchSpy.mockResolvedValueOnce(upstream);

		const response = await handler(context());

		expect(response.status).toBe(502);
		expect(response.headers.get("Content-Type")).toContain("application/json");
		const text = await response.text();
		expect(text).not.toContain(MARKUP);
		expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("PROXY_ERROR");
	});

	it.each([
		[404, "text/html", 404, "NOT_FOUND"],
		[404, "image/png", 404, "NOT_FOUND"],
		[500, "text/html", 502, "PROXY_ERROR"],
		[403, "image/png", 502, "PROXY_ERROR"],
	])(
		"does not relay the body of a marketplace %i served as %s",
		async (upstreamStatus, upstreamType, status, code) => {
			fetchSpy.mockResolvedValueOnce(
				new Response(MARKUP, { status: upstreamStatus, headers: { "Content-Type": upstreamType } }),
			);

			const response = await handler(context());

			expect(response.status).toBe(status);
			expect(response.headers.get("Content-Type")).toContain("application/json");
			const text = await response.text();
			expect(text).not.toContain(MARKUP);
			expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(code);
		},
	);
});
