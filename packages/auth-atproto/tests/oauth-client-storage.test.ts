import type { Store } from "@atcute/oauth-node-client";
import { describe, it, expect, vi } from "vitest";

const captured = vi.hoisted(() => ({
	stores: null as null | Record<string, Store<string, unknown>>,
}));

vi.mock("@atcute/oauth-node-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@atcute/oauth-node-client")>();
	class CapturingOAuthClient extends actual.OAuthClient {
		constructor(options: ConstructorParameters<typeof actual.OAuthClient>[0]) {
			super(options);
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the test only calls get/set on the stores
			captured.stores = options.stores as unknown as Record<string, Store<string, unknown>>;
		}
	}
	return { ...actual, OAuthClient: CapturingOAuthClient };
});

import { getAtprotoOAuthClient } from "../src/oauth-client.js";

function recordingStorage() {
	const rows = new Map<string, unknown>();
	const collection = (name: string) => ({
		get: async (id: string) => rows.get(`${name}/${id}`) ?? null,
		put: async (id: string, data: unknown) => void rows.set(`${name}/${id}`, data),
		delete: async (id: string) => rows.delete(`${name}/${id}`),
		deleteMany: async () => 0,
		query: async () => ({ items: [] }),
	});
	return { rows, storage: { states: collection("states"), sessions: collection("sessions") } };
}

describe("getAtprotoOAuthClient storage", () => {
	it("keeps sign-in states in plugin storage", async () => {
		const { rows, storage } = recordingStorage();
		await getAtprotoOAuthClient("https://example.com", storage);

		await captured.stores!.states!.set("state-id", { expiresAt: Date.now() + 60_000 });

		expect([...rows.keys()]).toEqual(["states/state-id"]);
	});

	it("does not write the account's token set to plugin storage", async () => {
		const { rows, storage } = recordingStorage();
		await getAtprotoOAuthClient("https://example.com", storage);

		// The callback stores the session before the site decides whether to
		// admit the account, so a refused sign-in must not leave it behind.
		await captured.stores!.sessions!.set("did:plc:refused", { tokenSet: {} });

		expect(rows.size).toBe(0);
	});
});
