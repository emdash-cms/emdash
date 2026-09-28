import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getIcon } from "../../../src/astro/routes/api/admin/plugins/marketplace/[id]/icon.js";
import { GET as getThumbnail } from "../../../src/astro/routes/api/admin/themes/marketplace/[id]/thumbnail.js";

const MARKETPLACE = "https://marketplace.example.com";

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
});
