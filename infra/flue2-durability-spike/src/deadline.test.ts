import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withDeadline } from "./deadline.js";

describe("withDeadline", () => {
	it("preserves a completed operation", async () => {
		await assert.doesNotReject(withDeadline(Promise.resolve("done"), 100, "probe"));
		assert.equal(await withDeadline(Promise.resolve("done"), 100, "probe"), "done");
	});

	it("rejects an operation that never settles", async () => {
		await assert.rejects(
			withDeadline(new Promise(() => {}), 10, "probe"),
			new Error("probe timed out after 10ms"),
		);
	});
});
