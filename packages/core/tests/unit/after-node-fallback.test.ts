// @vitest-environment jsdom
import { expect, it } from "vitest";

import { after } from "../../src/after.js";
import { waitForDeferredTasks } from "../../src/deferred-tasks.js";

it("runs deferred work in jsdom tooling without a host lifetime binding", async () => {
	let completed = false;
	after(() => {
		completed = true;
	});
	await waitForDeferredTasks();
	expect(completed).toBe(true);
});
