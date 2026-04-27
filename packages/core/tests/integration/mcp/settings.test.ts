/**
 * MCP settings tools — integration tests.
 *
 * Covers:
 *   - settings_get
 *   - settings_update
 *
 * Plus regression for bug #16 (no MCP tool for site settings).
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const EDITOR_ID = "user_editor";
const SUBSCRIBER_ID = "user_subscriber";

interface SiteSettingsResponse {
	title?: string;
	tagline?: string;
	logo?: { mediaId: string; alt?: string; url?: string };
	favicon?: { mediaId: string; alt?: string; url?: string };
	url?: string;
	postsPerPage?: number;
	dateFormat?: string;
	timezone?: string;
	social?: Record<string, string | undefined>;
	seo?: Record<string, unknown>;
}

async function seedMedia(db: Kysely<Database>, opts?: { id?: string }): Promise<string> {
	const id = opts?.id ?? ulid();
	const now = new Date().toISOString();
	await db
		.insertInto("media" as never)
		.values({
			id,
			filename: "logo.png",
			mime_type: "image/png",
			size: 1024,
			storage_key: `media/${id}.png`,
			created_at: now,
		} as never)
		.execute();
	return id;
}

// ---------------------------------------------------------------------------
// Tool registration — bug #16 regression.
// ---------------------------------------------------------------------------

describe("settings tools registered (bug #16)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("MCP exposes settings_get and settings_update", async () => {
		const tools = await harness.client.listTools();
		const names = new Set(tools.tools.map((t) => t.name));
		expect(names.has("settings_get")).toBe(true);
		expect(names.has("settings_update")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// settings_get
// ---------------------------------------------------------------------------

describe("settings_get", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns an empty object when no settings are set", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "settings_get",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<SiteSettingsResponse>(result);
		expect(data).toEqual({});
	});

	it("returns previously-set settings", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		await harness.client.callTool({
			name: "settings_update",
			arguments: { title: "My Site", tagline: "Welcome" },
		});

		const result = await harness.client.callTool({
			name: "settings_get",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<SiteSettingsResponse>(result);
		expect(data.title).toBe("My Site");
		expect(data.tagline).toBe("Welcome");
	});

	it("resolves logo media reference URL", async () => {
		const mediaId = await seedMedia(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		await harness.client.callTool({
			name: "settings_update",
			arguments: { logo: { mediaId, alt: "Site logo" } },
		});

		const result = await harness.client.callTool({
			name: "settings_get",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<SiteSettingsResponse>(result);
		expect(data.logo?.mediaId).toBe(mediaId);
		expect(data.logo?.alt).toBe("Site logo");
		// URL is resolved to the media file route
		expect(data.logo?.url).toMatch(/^\/_emdash\/api\/media\/file\//);
	});

	it("editor can read settings", async () => {
		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "settings_get",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("subscriber cannot read settings (INSUFFICIENT_PERMISSIONS)", async () => {
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "settings_get",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
	});

	it("rejects token without settings:read scope (INSUFFICIENT_SCOPE)", async () => {
		harness = await connectMcpHarness({
			db,
			userId: ADMIN_ID,
			userRole: Role.ADMIN,
			tokenScopes: ["content:read"],
		});
		const result = await harness.client.callTool({
			name: "settings_get",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("INSUFFICIENT_SCOPE");
	});

	it("settings:read token is sufficient for settings_get", async () => {
		harness = await connectMcpHarness({
			db,
			userId: ADMIN_ID,
			userRole: Role.ADMIN,
			tokenScopes: ["settings:read"],
		});
		const result = await harness.client.callTool({
			name: "settings_get",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("admin scope grants settings_get access", async () => {
		harness = await connectMcpHarness({
			db,
			userId: ADMIN_ID,
			userRole: Role.ADMIN,
			tokenScopes: ["admin"],
		});
		const result = await harness.client.callTool({
			name: "settings_get",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// settings_update
// ---------------------------------------------------------------------------

describe("settings_update", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("updates title and tagline", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: { title: "EmDash Demo", tagline: "Hello" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<SiteSettingsResponse>(result);
		expect(data.title).toBe("EmDash Demo");
		expect(data.tagline).toBe("Hello");
	});

	it("partial update preserves other fields", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		await harness.client.callTool({
			name: "settings_update",
			arguments: { title: "First", tagline: "Original tagline" },
		});

		// Update only tagline; title should be preserved
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: { tagline: "Updated tagline" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<SiteSettingsResponse>(result);
		expect(data.title).toBe("First");
		expect(data.tagline).toBe("Updated tagline");
	});

	it("accepts an http url and rejects javascript: scheme", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const ok = await harness.client.callTool({
			name: "settings_update",
			arguments: { url: "https://example.com" },
		});
		expect(ok.isError, extractText(ok)).toBeFalsy();

		const bad = await harness.client.callTool({
			name: "settings_update",
			// eslint-disable-next-line no-script-url -- intentional for validation test
			arguments: { url: "javascript:alert(1)" },
		});
		expect(bad.isError).toBe(true);
	});

	it("accepts empty string for url (clears it)", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: { url: "" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("rejects out-of-range postsPerPage", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: { postsPerPage: 9999 },
		});
		expect(result.isError).toBe(true);
	});

	it("accepts nested seo and social objects", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: {
				social: { twitter: "@emdash", github: "emdash-cms" },
				seo: { titleSeparator: " | ", googleVerification: "abc123" },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<SiteSettingsResponse>(result);
		expect(data.social?.twitter).toBe("@emdash");
		expect(data.social?.github).toBe("emdash-cms");
		expect((data.seo as { titleSeparator?: string }).titleSeparator).toBe(" | ");
	});

	it("editor cannot update settings (INSUFFICIENT_PERMISSIONS — admin only)", async () => {
		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: { title: "Nope" },
		});
		expect(result.isError).toBe(true);
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
	});

	it("subscriber cannot update settings", async () => {
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: { title: "Nope" },
		});
		expect(result.isError).toBe(true);
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
	});

	it("settings:read token cannot call settings_update (INSUFFICIENT_SCOPE)", async () => {
		harness = await connectMcpHarness({
			db,
			userId: ADMIN_ID,
			userRole: Role.ADMIN,
			tokenScopes: ["settings:read"],
		});
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: { title: "x" },
		});
		expect(result.isError).toBe(true);
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("INSUFFICIENT_SCOPE");
	});

	it("settings:manage token can call settings_update", async () => {
		harness = await connectMcpHarness({
			db,
			userId: ADMIN_ID,
			userRole: Role.ADMIN,
			tokenScopes: ["settings:manage"],
		});
		const result = await harness.client.callTool({
			name: "settings_update",
			arguments: { title: "x" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});
