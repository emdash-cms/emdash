import { describe, it, expect, vi } from "vitest";

vi.mock("virtual:emdash/config", () => ({ default: { siteUrl: "https://cms.example.com" } }));

import { GET } from "../src/routes/client-metadata.js";

function makeContext(requestUrl: string, locals: Record<string, unknown>) {
	const url = new URL(requestUrl);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the route only reads url and locals
	return { url, request: new Request(url), locals } as unknown as Parameters<typeof GET>[0];
}

interface Metadata {
	client_id: string;
	redirect_uris: string[];
}

describe("GET /.well-known/atproto-client-metadata.json", () => {
	it("uses the configured siteUrl instead of the request host", async () => {
		const response = await GET(
			makeContext("https://other-host.example/.well-known/atproto-client-metadata.json", {}),
		);
		const body = (await response.json()) as Metadata;

		expect(body.client_id).toBe("https://cms.example.com/.well-known/atproto-client-metadata.json");
		expect(body.redirect_uris).toEqual([
			"https://cms.example.com/_emdash/api/auth/atproto/callback",
		]);
	});

	it("prefers the runtime config when it is available", async () => {
		const response = await GET(
			makeContext("http://localhost:4321/.well-known/atproto-client-metadata.json", {
				emdash: { config: { siteUrl: "https://runtime.example.com" } },
			}),
		);
		const body = (await response.json()) as Metadata;

		expect(body.client_id).toBe(
			"https://runtime.example.com/.well-known/atproto-client-metadata.json",
		);
	});
});
