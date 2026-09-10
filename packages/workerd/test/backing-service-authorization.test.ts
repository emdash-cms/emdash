import type { Server } from "node:http";
import { createServer, request } from "node:http";

import DatabaseDriver from "better-sqlite3";
import type { Database, PluginCapability, PluginManifest } from "emdash";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBackingServiceHandler } from "../src/sandbox/backing-service.js";
import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

type BridgeResponse = {
	status: number;
	result?: unknown;
	error?: string;
};

function manifest(
	version: string,
	options: {
		capabilities?: PluginCapability[];
		allowedHosts?: string[];
		storage?: PluginManifest["storage"];
	} = {},
): PluginManifest {
	return {
		id: "policy-plugin",
		version,
		capabilities: options.capabilities ?? [],
		allowedHosts: options.allowedHosts ?? [],
		storage: options.storage ?? {},
		hooks: [],
		routes: [],
		admin: {},
	};
}

function getActiveToken(runner: WorkerdSandboxRunner, version: string): string {
	const plugin = runner["plugins"].get(`policy-plugin:${version}`);
	if (!plugin) throw new Error(`Plugin version ${version} is not loaded`);
	return plugin.token;
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Backing service did not bind to a TCP port");
	}
	return address.port;
}

async function close(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function callBridge(
	port: number,
	token: string,
	method: string,
	body: Record<string, unknown>,
	beforeBodyEnd?: () => Promise<void>,
): Promise<BridgeResponse> {
	const payload = JSON.stringify(body);
	return new Promise<BridgeResponse>((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path: `/${method}`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					try {
						const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
							reject(new Error("Backing service returned a non-object response"));
							return;
						}
						const bridgeResponse: BridgeResponse = {
							status: response.statusCode ?? 0,
						};
						if ("result" in parsed) bridgeResponse.result = parsed.result;
						if ("error" in parsed && typeof parsed.error === "string") {
							bridgeResponse.error = parsed.error;
						}
						resolve(bridgeResponse);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.on("error", reject);
		if (beforeBodyEnd) {
			req.write(payload.slice(0, 1));
			void beforeBodyEnd().then(() => req.end(payload.slice(1)), reject);
		} else {
			req.end(payload);
		}
	});
}

describe("backing service authorization", () => {
	let sqlite: DatabaseDriver.Database;
	let db: Kysely<Database>;
	let runner: WorkerdSandboxRunner;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		sqlite = new DatabaseDriver(":memory:");
		db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await db.schema
			.createTable("_plugin_storage")
			.addColumn("plugin_id", "text", (column) => column.notNull())
			.addColumn("collection", "text", (column) => column.notNull())
			.addColumn("id", "text", (column) => column.notNull())
			.addColumn("data", "text", (column) => column.notNull())
			.addColumn("created_at", "text", (column) => column.notNull())
			.addColumn("updated_at", "text", (column) => column.notNull())
			.addPrimaryKeyConstraint("pk_plugin_storage", ["plugin_id", "collection", "id"])
			.execute();

		runner = new WorkerdSandboxRunner({ db });
		vi.spyOn(runner, "ensureRunning").mockResolvedValue();
		const backingService = createBackingServiceHandler(runner);
		runner["backingService"] = backingService;
		server = createServer(backingService.handler);
		port = await listen(server);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await close(server);
		await runner.terminateAll();
		vi.restoreAllMocks();
		await db.destroy();
		if (sqlite.open) sqlite.close();
	});

	it("uses each active version's exact security contract", async () => {
		const sendEmail = vi.fn(async () => {});
		runner.setEmailSend(sendEmail);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok")),
		);

		await runner.load(
			manifest("1.0.0", {
				capabilities: ["email:send", "network:fetch"],
				allowedHosts: ["v1.example"],
				storage: { logs: {} },
			}),
			"export default {};",
		);
		await runner.load(
			manifest("2.0.0", {
				capabilities: ["network:fetch"],
				allowedHosts: ["v2.example"],
			}),
			"export default {};",
		);

		const versionOneToken = getActiveToken(runner, "1.0.0");
		const versionTwoToken = getActiveToken(runner, "2.0.0");

		const primed = await callBridge(port, versionOneToken, "storage/get", {
			collection: "logs",
			id: "entry-1",
		});
		expect(primed.error).toBeUndefined();

		const email = await callBridge(port, versionTwoToken, "email/send", {
			message: { to: "reader@example.com", subject: "Subject", text: "Body" },
		});
		expect.soft(email.error ?? "").toContain("Missing capability: email:send");
		expect.soft(sendEmail).not.toHaveBeenCalled();

		const network = await callBridge(port, versionTwoToken, "http/fetch", {
			url: "https://v1.example/resource",
		});
		expect.soft(network.error ?? "").toContain('not allowed to fetch from host "v1.example"');

		const storage = await callBridge(port, versionTwoToken, "storage/get", {
			collection: "logs",
			id: "entry-1",
		});
		expect.soft(storage.error ?? "").toContain("Storage collection not declared: logs");
	});

	it("accepts only the active token and preserves a sibling version on unload", async () => {
		const versionOne = manifest("1.0.0");
		const versionTwo = manifest("2.0.0");
		await runner.load(versionOne, "export default {};");
		await runner.load(versionTwo, "export default {};");

		const versionOneToken = getActiveToken(runner, "1.0.0");
		const versionTwoToken = getActiveToken(runner, "2.0.0");
		const inactiveToken = runner["generatePluginToken"](
			manifest("1.0.0", { capabilities: ["email:send"] }),
		);

		expect.soft(runner.validateToken(inactiveToken)).toBeNull();
		expect(runner.validateToken(versionOneToken)?.version).toBe("1.0.0");
		expect(runner.validateToken(versionTwoToken)?.version).toBe("2.0.0");
		const primed = await callBridge(port, versionOneToken, "kv/get", { key: "health" });
		expect(primed.status).toBe(200);

		runner.unloadPlugin("policy-plugin:1.0.0");

		expect.soft(runner.validateToken(versionOneToken)).toBeNull();
		expect(runner.validateToken(versionTwoToken)?.version).toBe("2.0.0");
		const stale = await callBridge(port, versionOneToken, "kv/get", { key: "health" });
		expect.soft(stale).toMatchObject({ status: 401, error: "Invalid auth token" });
		const sibling = await callBridge(port, versionTwoToken, "kv/get", { key: "health" });
		expect(sibling).toMatchObject({ status: 200, result: null });

		await runner.load(versionOne, "export default {};");
		const reloadedToken = getActiveToken(runner, "1.0.0");
		expect(reloadedToken).not.toBe(versionOneToken);
		const stillStale = await callBridge(port, versionOneToken, "kv/get", { key: "health" });
		expect.soft(stillStale).toMatchObject({ status: 401, error: "Invalid auth token" });
		const reloaded = await callBridge(port, reloadedToken, "kv/get", { key: "health" });
		expect(reloaded).toMatchObject({ status: 200, result: null });
	});

	it("rejects a token revoked while the request body is still arriving", async () => {
		await runner.load(manifest("1.0.0"), "export default {};");
		const token = getActiveToken(runner, "1.0.0");
		const received = new Promise<void>((resolve) => {
			server.prependOnceListener("request", () => resolve());
		});

		const response = await callBridge(
			port,
			token,
			"kv/set",
			{ key: "pending", value: "blocked" },
			async () => {
				await received;
				runner.unloadPlugin("policy-plugin:1.0.0");
			},
		);
		expect(response).toMatchObject({ status: 401, error: "Invalid auth token" });

		await runner.load(manifest("1.0.0"), "export default {};");
		const reloaded = await callBridge(port, getActiveToken(runner, "1.0.0"), "kv/get", {
			key: "pending",
		});
		expect(reloaded).toMatchObject({ status: 200, result: null });
	});

	it("includes plugins loaded during startup before reporting ready", async () => {
		let finishFirstStart = () => {};
		const firstStart = new Promise<void>((resolve) => {
			finishFirstStart = resolve;
		});
		let runningPlugins: string[] = [];
		let starts = 0;
		runner["restart"] = async () => {
			const configuredPlugins = [...runner["plugins"].keys()];
			if (starts++ === 0) await firstStart;
			runningPlugins = configuredPlugins;
		};

		await runner.load(manifest("1.0.0"), "export default {};");
		vi.mocked(runner.ensureRunning).mockRestore();
		const ready = runner.ensureRunning();
		await runner.load(manifest("2.0.0"), "export default {};");
		finishFirstStart();
		await ready;

		expect(runningPlugins).toEqual(["policy-plugin:1.0.0", "policy-plugin:2.0.0"]);
	});
});
