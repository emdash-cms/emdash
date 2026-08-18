import { describe, expect, test } from "vitest";

import { withDeadline } from "../../.flue/lib/sandbox-deadline.js";

describe("withDeadline", () => {
	test("preserves a completed operation", async () => {
		await expect(withDeadline(Promise.resolve("done"), 100, "probe")).resolves.toBe("done");
	});

	test("rejects an operation that never settles", async () => {
		await expect(withDeadline(new Promise(() => {}), 10, "probe")).rejects.toThrow(
			"probe timed out after 10ms",
		);
	});
});
