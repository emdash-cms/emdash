import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
	createAtprotoStateStore,
	createAtprotoSessionStore,
} from "../../../src/auth/atproto/stores.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

// Minimal mock data matching the SDK's NodeSavedState shape
const mockState = {
	iss: "https://bsky.social",
	dpopJwk: { kty: "EC", crv: "P-256", x: "test", y: "test" },
	authMethod: "none" as const,
	verifier: "test-pkce-verifier",
	appState: "test-app-state",
};

// Minimal mock data matching the SDK's NodeSavedSession shape
const mockSession = {
	dpopJwk: { kty: "EC", crv: "P-256", x: "test", y: "test" },
	authMethod: "none" as const,
	tokenSet: {
		iss: "https://bsky.social",
		sub: "did:plc:test123" as `did:${string}`,
		aud: "https://bsky.social",
		scope: "atproto",
		access_token: "test-access-token",
		token_type: "DPoP" as const,
	},
};

describe("ATProto State Store", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("stores and retrieves state", async () => {
		const store = createAtprotoStateStore(db);

		await store.set("state-key-1", mockState);
		const result = await store.get("state-key-1");

		expect(result).toEqual(mockState);
	});

	it("returns undefined for non-existent key", async () => {
		const store = createAtprotoStateStore(db);

		const result = await store.get("does-not-exist");
		expect(result).toBeUndefined();
	});

	it("deletes state", async () => {
		const store = createAtprotoStateStore(db);

		await store.set("to-delete", mockState);
		await store.del("to-delete");

		const result = await store.get("to-delete");
		expect(result).toBeUndefined();
	});

	it("overwrites existing state on conflict", async () => {
		const store = createAtprotoStateStore(db);

		await store.set("overwrite-key", mockState);

		const updated = { ...mockState, verifier: "updated-verifier" };
		await store.set("overwrite-key", updated);

		const result = await store.get("overwrite-key");
		expect(result?.verifier).toBe("updated-verifier");
	});

	it("returns undefined for expired state", async () => {
		vi.useFakeTimers();
		const store = createAtprotoStateStore(db);

		await store.set("expiring-key", mockState);

		// Advance past the 10-minute TTL
		vi.advanceTimersByTime(11 * 60 * 1000);

		const result = await store.get("expiring-key");
		expect(result).toBeUndefined();

		vi.useRealTimers();
	});

	it("does not return session store entries", async () => {
		const stateStore = createAtprotoStateStore(db);
		const sessionStore = createAtprotoSessionStore(db);

		await sessionStore.set("shared-key", mockSession);

		const result = await stateStore.get("shared-key");
		expect(result).toBeUndefined();
	});

	it("does not throw when deleting non-existent key", async () => {
		const store = createAtprotoStateStore(db);
		await expect(store.del("non-existent")).resolves.not.toThrow();
	});
});

describe("ATProto Session Store", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("stores and retrieves session", async () => {
		const store = createAtprotoSessionStore(db);

		await store.set("did:plc:test123", mockSession);
		const result = await store.get("did:plc:test123");

		expect(result).toEqual(mockSession);
	});

	it("returns undefined for non-existent key", async () => {
		const store = createAtprotoSessionStore(db);

		const result = await store.get("did:plc:nonexistent");
		expect(result).toBeUndefined();
	});

	it("deletes session", async () => {
		const store = createAtprotoSessionStore(db);

		await store.set("did:plc:to-delete", mockSession);
		await store.del("did:plc:to-delete");

		const result = await store.get("did:plc:to-delete");
		expect(result).toBeUndefined();
	});

	it("overwrites existing session on conflict", async () => {
		const store = createAtprotoSessionStore(db);

		await store.set("did:plc:overwrite", mockSession);

		const updated = {
			...mockSession,
			tokenSet: { ...mockSession.tokenSet, access_token: "new-token" },
		};
		await store.set("did:plc:overwrite", updated);

		const result = await store.get("did:plc:overwrite");
		expect(result?.tokenSet.access_token).toBe("new-token");
	});

	it("returns undefined for expired session", async () => {
		vi.useFakeTimers();
		const store = createAtprotoSessionStore(db);

		await store.set("did:plc:expiring", mockSession);

		// Advance past the 1-hour TTL
		vi.advanceTimersByTime(61 * 60 * 1000);

		const result = await store.get("did:plc:expiring");
		expect(result).toBeUndefined();

		vi.useRealTimers();
	});

	it("does not return state store entries", async () => {
		const stateStore = createAtprotoStateStore(db);
		const sessionStore = createAtprotoSessionStore(db);

		await stateStore.set("shared-key", mockState);

		const result = await sessionStore.get("shared-key");
		expect(result).toBeUndefined();
	});
});
