/**
 * Uses the real `DiscoveryClient` and platform `fetch`, because a stubbed
 * `fetch` cannot show whether a redirect is followed.
 */

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRegistryInstall } from "../../../src/api/handlers/registry.js";
import { GET } from "../../../src/astro/routes/api/admin/plugins/registry/artifact.js";
import type { Database } from "../../../src/database/types.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const PUBLISHER_DID = "did:plc:abcdefghijklmnopqrstuvwx";
const SLUG = "gallery";

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	server.close();
	await once(server, "close");
}

describe("registry aggregator redirects", () => {
	let db: Kysely<Database>;
	let internalService: Server;
	let aggregator: Server;
	let aggregatorUrl: string;
	let internalRequests: string[];
	let aggregatorRequests: string[];

	beforeEach(async () => {
		db = await setupTestDatabase();

		internalRequests = [];
		internalService = createServer((req, res) => {
			internalRequests.push(req.url ?? "");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});
		const internalUrl = await listen(internalService);

		aggregatorRequests = [];
		aggregator = createServer((req, res) => {
			aggregatorRequests.push(req.url ?? "");
			res.writeHead(302, { Location: `${internalUrl}/internal`, "Content-Length": "0" });
			res.end();
		});
		aggregatorUrl = await listen(aggregator);
	});

	afterEach(async () => {
		await close(aggregator);
		await close(internalService);
		await teardownTestDatabase(db);
	});

	it("reports a redirect from the aggregator as an error when verifying a package", async () => {
		const result = await handleRegistryInstall(
			db,
			{} as unknown as Storage,
			{ isAvailable: () => true } as unknown as SandboxRunner,
			aggregatorUrl,
			{ did: PUBLISHER_DID, slug: SLUG },
			{ verifyOnly: true },
		);

		expect(result).toMatchObject({ success: false, error: { code: "AGGREGATOR_HTTP_ERROR" } });
		expect(aggregatorRequests).toHaveLength(1);
		expect(internalRequests).toEqual([]);
	});

	it("reports a redirect from the aggregator as an error in the artifact proxy", async () => {
		const url = new URL("https://site.test/_emdash/api/admin/plugins/registry/artifact");
		url.searchParams.set("did", PUBLISHER_DID);
		url.searchParams.set("slug", SLUG);
		url.searchParams.set("cid", `bafyrei${"a".repeat(52)}`);
		url.searchParams.set("kind", "icon");

		const response = await GET({
			url,
			locals: {
				emdash: { db, config: { registry: aggregatorUrl } },
				user: { id: "u1", role: 50 },
			},
		} as unknown as APIContext);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "ARTIFACT_RESOLVE_FAILED" },
		});
		expect(aggregatorRequests).toHaveLength(1);
		expect(internalRequests).toEqual([]);
	});
});
