/**
 * Plugin settings route (#341): registration, authorization, and the
 * secret-masking contract at the HTTP boundary.
 *
 * Reading settings can reveal plugin configuration and updating can
 * change plugin behaviour, so both methods require `plugins:manage`
 * (admin), not just `plugins:read` (editor).
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import {
	GET as settingsGet,
	PUT as settingsPut,
} from "../../../src/astro/routes/api/admin/plugins/[id]/settings.js";
import type { Database } from "../../../src/database/types.js";
import type { ResolvedPlugin, SettingField } from "../../../src/plugins/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const SCHEMA: Record<string, SettingField> = {
	siteKey: { type: "string", label: "Site Key" },
	secretKey: { type: "secret", label: "Secret Key" },
};

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal test fixture
const PLUGIN = {
	id: "emdash-forms",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	admin: { settingsSchema: SCHEMA },
	hooks: {},
	routes: {},
} as ResolvedPlugin;

describe("plugin settings route registration", () => {
	it("registers /_emdash/api/admin/plugins/[id]/settings", () => {
		const injectRoute = vi.fn();
		injectCoreRoutes(injectRoute);
		const patterns = injectRoute.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);
		expect(patterns).toContain("/_emdash/api/admin/plugins/[id]/settings");
	});
});

describe("plugin settings route", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	const makeLocals = (user: { id: string; role: number } | null) => ({
		emdash: {
			db,
			configuredPlugins: [PLUGIN],
			sandboxedPluginEntries: [],
			getRuntimePluginSettingsSchema: () => null,
		},
		user,
	});

	const makeContext = (user: { id: string; role: number } | null, request?: Request) =>
		({
			params: { id: "emdash-forms" },
			request:
				request ?? new Request("http://localhost/_emdash/api/admin/plugins/emdash-forms/settings"),
			locals: makeLocals(user),
		}) as unknown as Parameters<typeof settingsGet>[0];

	it("GET returns 401 for anonymous users", async () => {
		const response = await settingsGet(makeContext(null));
		expect(response.status).toBe(401);
	});

	it("GET returns 403 for editors (plugins:manage is admin-only)", async () => {
		const response = await settingsGet(makeContext({ id: "u1", role: Role.EDITOR }));
		expect(response.status).toBe(403);
	});

	it("GET returns 404 for an unknown plugin", async () => {
		const ctx = makeContext({ id: "u1", role: Role.ADMIN });
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test fixture
		(ctx as { params: { id: string } }).params = { id: "nope" };
		const response = await settingsGet(ctx);
		expect(response.status).toBe(404);
	});

	it("GET returns schema and masked secrets for admins", async () => {
		const response = await settingsGet(makeContext({ id: "u1", role: Role.ADMIN }));
		expect(response.status).toBe(200);
		const { data: body } = (await response.json()) as {
			data: {
				schema: Record<string, unknown>;
				values: Record<string, unknown>;
				secretsSet: Record<string, boolean>;
			};
		};
		expect(Object.keys(body.schema)).toEqual(["siteKey", "secretKey"]);
		expect(body.secretsSet).toEqual({ secretKey: false });
		expect("secretKey" in body.values).toBe(false);
	});

	it("GET resolves a runtime-installed (marketplace) plugin via the runtime schema fallback", async () => {
		// The plugin is not in configuredPlugins/sandboxedPluginEntries, so the
		// static lookup misses and the route must fall back to
		// getRuntimePluginSettingsSchema — the fix for runtime-installed plugins.
		const runtimeLocals = {
			emdash: {
				db,
				configuredPlugins: [],
				sandboxedPluginEntries: [],
				getRuntimePluginSettingsSchema: (id: string) => (id === "emdash-forms" ? SCHEMA : null),
			},
			user: { id: "u1", role: Role.ADMIN },
		};
		const ctx = {
			params: { id: "emdash-forms" },
			request: new Request("http://localhost/_emdash/api/admin/plugins/emdash-forms/settings"),
			locals: runtimeLocals,
		} as unknown as Parameters<typeof settingsGet>[0];

		const response = await settingsGet(ctx);
		expect(response.status).toBe(200);
		const { data: body } = (await response.json()) as {
			data: { schema: Record<string, unknown>; secretsSet: Record<string, boolean> };
		};
		expect(Object.keys(body.schema)).toEqual(["siteKey", "secretKey"]);
		expect(body.secretsSet).toEqual({ secretKey: false });
	});

	it("PUT requires plugins:manage and persists values", async () => {
		const put = (user: { id: string; role: number } | null) =>
			settingsPut(
				makeContext(
					user,
					new Request("http://localhost/_emdash/api/admin/plugins/emdash-forms/settings", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ values: { siteKey: "abc", secretKey: "shh" } }),
					}),
				),
			);

		expect((await put(null)).status).toBe(401);
		expect((await put({ id: "u1", role: Role.EDITOR })).status).toBe(403);

		const response = await put({ id: "u1", role: Role.ADMIN });
		expect(response.status).toBe(200);
		const { data: body } = (await response.json()) as {
			data: {
				values: Record<string, unknown>;
				secretsSet: Record<string, boolean>;
			};
		};
		expect(body.values.siteKey).toBe("abc");
		expect(body.secretsSet).toEqual({ secretKey: true });
		// The secret round-trips into storage but never back to the client.
		expect("secretKey" in body.values).toBe(false);
	});
});
