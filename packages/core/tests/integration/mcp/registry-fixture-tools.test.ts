import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Role, type RoleLevel } from "@emdash-cms/auth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildPlugin } from "../../../../plugin-cli/src/build/api.js";
import { WorkerdSandboxRunner } from "../../../../workerd/src/sandbox/runner.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { createMcpServer, type PluginMcpRegistration } from "../../../src/mcp/server.js";
import type { RouteCallerInput } from "../../../src/plugins/routes.js";

class AuthInjectingTransport extends InMemoryTransport {
	constructor(private authInfo: Record<string, unknown>) {
		super();
	}

	override async send(
		message: Parameters<InMemoryTransport["send"]>[0],
		options?: Parameters<InMemoryTransport["send"]>[1],
	): Promise<void> {
		return super.send(message, {
			...options,
			authInfo: {
				token: "",
				clientId: "registry-fixture-test",
				scopes: [],
				extra: this.authInfo,
			},
		});
	}
}

function authenticatedPair(authInfo: {
	emdash: EmDashHandlers;
	userId: string;
	userRole: RoleLevel;
	user: RouteCallerInput;
	tokenScopes: string[];
}): [AuthInjectingTransport, InMemoryTransport] {
	const clientTransport = new AuthInjectingTransport(authInfo);
	const serverTransport = new InMemoryTransport();
	(clientTransport as unknown as Record<string, unknown>)._otherTransport = serverTransport;
	(serverTransport as unknown as Record<string, unknown>)._otherTransport = clientTransport;
	return [clientTransport, serverTransport];
}

describe("registry fixture MCP tools", () => {
	let client: Client | undefined;
	let server: ReturnType<typeof createMcpServer> | undefined;
	let runner: WorkerdSandboxRunner | undefined;
	let db: Kysely<Database> | undefined;
	let sqlite: BetterSqlite3.Database | undefined;

	afterEach(async () => {
		await client?.close();
		await server?.close();
		await runner?.terminateAll();
		await db?.destroy();
		sqlite?.close();
	});

	it("validates and invokes the installed read-only and destructive tools", async () => {
		const pluginDir = fileURLToPath(
			new URL("../../../../plugins/marketplace-test", import.meta.url),
		);
		const built = await buildPlugin({ dir: pluginDir });
		const manifest = built.wireManifest;
		sqlite = new BetterSqlite3(":memory:");
		db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);
		runner = new WorkerdSandboxRunner({ db });
		const plugin = await runner.load(manifest, await readFile(built.files.runtime, "utf8"));
		await db
			.insertInto("_plugin_storage")
			.values({
				plugin_id: manifest.id,
				collection: "records",
				id: "delete-me",
				data: JSON.stringify({ externalId: "delete-me", status: "pending", score: 1 }),
				revision: crypto.randomUUID(),
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			})
			.execute();

		const registrations: PluginMcpRegistration[] = (manifest.mcp?.tools ?? []).map((tool) => ({
			pluginId: manifest.id,
			name: tool.name,
			description: tool.description,
			route: tool.route,
			permission: tool.permission,
			destructive: tool.destructive,
			inputSchema: z.fromJSONSchema({ ...tool.inputSchema }),
			outputSchema: tool.outputSchema ? z.fromJSONSchema({ ...tool.outputSchema }) : undefined,
		}));
		const handlePluginMcpTool = vi.fn(
			async (_pluginId: string, _tool: string, route: string, input: unknown) => ({
				success: true as const,
				data: await plugin.invokeRoute(route, input, {
					url: `https://plugin.test/${route}`,
					method: "POST",
					headers: { "content-type": "application/json" },
				}),
			}),
		);
		const handlers = {
			handlePluginMcpTool,
			handlePluginMcpDenied: vi.fn().mockResolvedValue(undefined),
		} as unknown as EmDashHandlers;
		server = createMcpServer(
			registrations,
			new Request("https://plugin.test/_emdash/api/mcp", { method: "POST" }),
		);
		const user: RouteCallerInput = {
			id: "registry-admin",
			email: "registry-admin@example.test",
			name: "Registry Admin",
			role: Role.ADMIN,
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		const [clientTransport, serverTransport] = authenticatedPair({
			emdash: handlers,
			userId: user.id,
			userRole: Role.ADMIN,
			user,
			tokenScopes: [`mcp:tools:${manifest.id}`],
		});
		client = new Client({ name: "registry-fixture-test", version: "1.0.0" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const listed = await client.listTools();
		expect(listed.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: `${manifest.id}__runDiagnostics`,
					annotations: expect.objectContaining({ destructiveHint: false }),
				}),
				expect.objectContaining({
					name: `${manifest.id}__deleteRecord`,
					annotations: expect.objectContaining({ destructiveHint: true }),
				}),
			]),
		);

		const invalid = await client.callTool({
			name: `${manifest.id}__deleteRecord`,
			arguments: { id: "" },
		});
		expect(invalid.isError).toBe(true);
		expect(handlePluginMcpTool).not.toHaveBeenCalled();

		const diagnostics = await client.callTool({
			name: `${manifest.id}__runDiagnostics`,
			arguments: {},
		});
		expect(diagnostics.isError).toBeFalsy();
		expect(diagnostics.structuredContent).toMatchObject({
			plugin: { id: manifest.id, version: manifest.version },
			authority: { content: true, media: true, users: true },
		});

		const deleted = await client.callTool({
			name: `${manifest.id}__deleteRecord`,
			arguments: { id: "delete-me" },
		});
		expect(deleted.isError).toBeFalsy();
		expect(deleted.structuredContent).toEqual({ deleted: true });
		expect(handlePluginMcpTool.mock.calls.map((call) => call.slice(0, 4))).toEqual([
			[manifest.id, "runDiagnostics", "diagnostics", {}],
			[manifest.id, "deleteRecord", "records/delete", { id: "delete-me" }],
		]);
		await expect(
			db
				.selectFrom("_plugin_storage")
				.select("id")
				.where("id", "=", "delete-me")
				.executeTakeFirst(),
		).resolves.toBeUndefined();
	}, 30_000);
});
