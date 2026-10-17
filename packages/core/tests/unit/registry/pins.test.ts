import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRegistryInstall } from "../../../src/api/handlers/registry.js";
import type { Database } from "../../../src/database/types.js";
import { runMigrations } from "../../../src/db/index.js";
import { createDialect } from "../../../src/db/sqlite.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import {
	REGISTRY_PINS_FILE,
	declareRegistryPinsSchema,
	installRegistryPins,
	loadRegistryPins,
	type RegistryPin,
} from "../../../src/registry/pins.js";
import type { Storage } from "../../../src/storage/types.js";

vi.mock("../../../src/api/handlers/registry.js", () => ({
	handleRegistryInstall: vi.fn(),
}));

const mockedHandleRegistryInstall = vi.mocked(handleRegistryInstall);

function makePin(overrides: Partial<RegistryPin> = {}): RegistryPin {
	return {
		did: "did:plc:publisher0000000000000000",
		slug: "gallery",
		version: "1.2.3",
		...overrides,
	};
}

describe("declareRegistryPinsSchema", () => {
	it("accepts a valid pins file shape and tolerates extra keys", () => {
		const result = declareRegistryPinsSchema.safeParse({
			plugins: [makePin(), makePin({ slug: "search", version: "0.1.0" })],
			$schema: "https://example.test/registry-plugins.schema.json",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.plugins).toHaveLength(2);
			expect(result.data.plugins[1]).toEqual(makePin({ slug: "search", version: "0.1.0" }));
		}
	});

	it("rejects a missing version", () => {
		const { version: _version, ...pin } = makePin();
		expect(declareRegistryPinsSchema.safeParse({ plugins: [pin] }).success).toBe(false);
	});

	it("rejects a non-string did", () => {
		expect(
			declareRegistryPinsSchema.safeParse({ plugins: [{ ...makePin(), did: 42 }] }).success,
		).toBe(false);
	});
});

describe("loadRegistryPins", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "emdash-pins-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns empty pins and null source when the file is absent", async () => {
		await expect(loadRegistryPins(dir)).resolves.toEqual({ pins: [], source: null });
	});

	it("reads and validates a pins file", async () => {
		const pins = [makePin(), makePin({ slug: "search", version: "0.1.0" })];
		await writeFile(path.join(dir, REGISTRY_PINS_FILE), JSON.stringify({ plugins: pins }));
		await expect(loadRegistryPins(dir)).resolves.toEqual({
			pins,
			source: path.join(dir, REGISTRY_PINS_FILE),
		});
	});

	it("throws naming the file when the JSON is malformed", async () => {
		await writeFile(path.join(dir, REGISTRY_PINS_FILE), "{ not json");
		await expect(loadRegistryPins(dir)).rejects.toThrow(REGISTRY_PINS_FILE);
	});

	it("throws naming the file when the shape is invalid", async () => {
		await writeFile(
			path.join(dir, REGISTRY_PINS_FILE),
			JSON.stringify({ plugins: [{ did: "did:plc:x", slug: "gallery" }] }),
		);
		await expect(loadRegistryPins(dir)).rejects.toThrow(REGISTRY_PINS_FILE);
	});
});

describe("installRegistryPins", () => {
	let db: Kysely<Database>;
	const storage = {} as Storage;
	const sandboxRunner = {} as SandboxRunner;
	const registryConfig = "https://registry.example.test";

	beforeEach(async () => {
		db = new Kysely<Database>({ dialect: createDialect({ url: "file::memory:" }) });
		await runMigrations(db);
		mockedHandleRegistryInstall.mockReset();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("installs each pin with its exact pinned version", async () => {
		const pins = [makePin(), makePin({ slug: "search", version: "0.1.0" })];
		mockedHandleRegistryInstall.mockResolvedValue({
			success: true,
			data: { pluginId: "plugin-1" },
		} as Awaited<ReturnType<typeof handleRegistryInstall>>);

		const results = await installRegistryPins({
			db,
			storage,
			sandboxRunner,
			registryConfig,
			pins,
		});

		expect(mockedHandleRegistryInstall).toHaveBeenCalledTimes(2);
		expect(mockedHandleRegistryInstall).toHaveBeenNthCalledWith(
			1,
			db,
			storage,
			sandboxRunner,
			registryConfig,
			{ did: pins[0].did, slug: pins[0].slug, version: pins[0].version },
		);
		expect(mockedHandleRegistryInstall).toHaveBeenNthCalledWith(
			2,
			db,
			storage,
			sandboxRunner,
			registryConfig,
			{ did: pins[1].did, slug: pins[1].slug, version: pins[1].version },
		);
		expect(results).toEqual([
			{ pin: pins[0], ok: true, pluginId: "plugin-1" },
			{ pin: pins[1], ok: true, pluginId: "plugin-1" },
		]);
	});

	it("continues installing the remaining pins when one fails, and reports onProgress", async () => {
		const pins = [makePin(), makePin({ slug: "search", version: "0.1.0" })];
		mockedHandleRegistryInstall
			.mockResolvedValueOnce({
				success: false,
				error: { code: "SANDBOX_NOT_AVAILABLE", message: "no sandbox" },
			})
			.mockResolvedValueOnce({
				success: true,
				data: { pluginId: "plugin-2" },
			} as Awaited<ReturnType<typeof handleRegistryInstall>>);
		const onProgress = vi.fn();

		const results = await installRegistryPins({
			db,
			storage,
			sandboxRunner,
			registryConfig,
			pins,
			onProgress,
		});

		expect(mockedHandleRegistryInstall).toHaveBeenCalledTimes(2);
		expect(results).toEqual([
			{ pin: pins[0], ok: false, code: "SANDBOX_NOT_AVAILABLE", message: "no sandbox" },
			{ pin: pins[1], ok: true, pluginId: "plugin-2" },
		]);
		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(onProgress).toHaveBeenNthCalledWith(1, results[0]);
		expect(onProgress).toHaveBeenNthCalledWith(2, results[1]);
	});

	it("threads installOpts through to the handler verbatim", async () => {
		const pins = [makePin()];
		mockedHandleRegistryInstall.mockResolvedValue({
			success: true,
			data: { pluginId: "plugin-1" },
		} as Awaited<ReturnType<typeof handleRegistryInstall>>);
		const installOpts = {
			acknowledgedProfileCid: "bafy…profile",
			acknowledgedReleaseCid: "bafy…release",
			acknowledgedDeclaredAccess: ["media:read"],
			acknowledgedPublicRoutes: ["api/quote"],
			acknowledgedMcpTools: [
				{ name: "search", description: "d", route: "r", permission: "p", destructive: false },
			],
		};

		await installRegistryPins({
			db,
			storage,
			sandboxRunner,
			registryConfig,
			pins,
			installOpts,
		});

		expect(mockedHandleRegistryInstall).toHaveBeenCalledTimes(1);
		expect(mockedHandleRegistryInstall).toHaveBeenNthCalledWith(
			1,
			db,
			storage,
			sandboxRunner,
			registryConfig,
			{ did: pins[0].did, slug: pins[0].slug, version: pins[0].version, ...installOpts },
		);
	});

	it("never throws for per-pin failures, including handler exceptions", async () => {
		const pins = [makePin()];
		mockedHandleRegistryInstall.mockRejectedValue(new Error("boom"));

		const results = await installRegistryPins({ db, storage, sandboxRunner, pins });

		expect(results).toHaveLength(1);
		expect(results[0].ok).toBe(false);
		expect(results[0].pin).toEqual(pins[0]);
		expect(results[0].message).toContain("boom");
	});
});
