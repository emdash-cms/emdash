/**
 * Regression test for #1604.
 *
 * Integration suites boot a real Astro dev server each and vitest runs
 * test files in parallel. Astro's "another dev server is already running"
 * guard is scoped to the project root (a lockfile at `<root>/.astro/dev.json`),
 * not to the port -- so when every suite shares one fixture directory, the
 * second server to start aborts on the shared lock even though it requested a
 * distinct port.
 *
 * This test reproduces that race inside a single suite: it boots two servers
 * concurrently and asserts both come up and serve seeded content. Before the
 * fix (servers run in-place from the shared fixture) the second server loses
 * the lock and `createTestServer` times out. After the fix (each server gets
 * its own copied fixture root) both succeed.
 */

import { describe, it, expect, afterAll } from "vitest";

import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

const PORT_A = 4402;
const PORT_B = 4403;

describe("Concurrent dev servers (#1604)", () => {
	const contexts: TestServerContext[] = [];

	afterAll(async () => {
		await Promise.all(contexts.map((ctx) => ctx.cleanup()));
	});

	it("boots two servers from the same fixture in parallel without colliding on the Astro lock", async () => {
		assertNodeVersion();

		// Track each server the moment it starts so a partial failure (one boots,
		// the other rejects) still leaves the successful server cleanable in
		// afterAll -- Promise.all would otherwise short-circuit before we push it.
		async function startTracked(port: number): Promise<TestServerContext> {
			const ctx = await createTestServer({ port });
			contexts.push(ctx);
			return ctx;
		}

		// Start both concurrently so they race for the (previously shared) lock.
		const [a, b] = await Promise.all([startTracked(PORT_A), startTracked(PORT_B)]);

		// Distinct roots -- the fix gives each server its own copied fixture.
		expect(a.cwd).not.toBe(b.cwd);

		// Both must actually serve their independently seeded content.
		const [collectionsA, collectionsB] = await Promise.all([
			a.client.collections(),
			b.client.collections(),
		]);
		for (const collections of [collectionsA, collectionsB]) {
			const slugs = collections.map((c: { slug: string }) => c.slug);
			expect(slugs).toContain("posts");
			expect(slugs).toContain("pages");
		}
	});
});
