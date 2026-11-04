import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createAggregatorReconciliationClient } from "../src/aggregator-reconciliation.js";

describe("aggregator reconciliation service binding", () => {
	it("calls the default Worker fetch entrypoint with reconciliation authentication", async () => {
		const client = createAggregatorReconciliationClient(
			env.AGGREGATOR_RECONCILIATION,
			env.RECONCILIATION_TOKEN,
		);
		await expect(client.listCurrentSubjects(undefined, 25)).resolves.toEqual({ items: [] });
		await expect(
			client.isCurrentSubject("at://did:example:test/collection/rkey", "bafytest"),
		).resolves.toBe(true);
	});

	it("fails closed when the service binding rejects the token", async () => {
		const client = createAggregatorReconciliationClient(
			env.AGGREGATOR_RECONCILIATION,
			"wrong-token",
		);
		await expect(client.listCurrentSubjects()).rejects.toThrow(
			"aggregator reconciliation request failed: 401",
		);
	});
});
