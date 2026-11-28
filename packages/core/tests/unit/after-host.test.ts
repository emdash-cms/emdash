import { afterEach, expect, it, vi } from "vitest";

import { waitForDeferredTasks } from "../../src/deferred-tasks.js";

afterEach(async () => {
	await waitForDeferredTasks();
	vi.doUnmock("virtual:emdash/wait-until");
	vi.doUnmock("cloudflare:workers");
	vi.resetModules();
});

async function expectAnchoredTask(waitUntil: ReturnType<typeof vi.fn>): Promise<void> {
	const { after } = await import("../../src/after.js");
	let settle!: () => void;
	let completed = false;
	after(async () => {
		await new Promise<void>((resolve) => {
			settle = resolve;
		});
		completed = true;
	});

	try {
		await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledTimes(1));
		expect(completed).toBe(false);
		const anchored = waitUntil.mock.calls[0][0] as Promise<unknown>;
		settle();
		await anchored;
		expect(completed).toBe(true);
	} finally {
		settle();
	}
}

it("anchors deferred work through the adapter binding when provided", async () => {
	const waitUntil = vi.fn();
	const platformImport = vi.fn(() => {
		throw new Error("platform should not be probed");
	});
	vi.doMock("virtual:emdash/wait-until", () => ({ waitUntil }));
	vi.doMock("cloudflare:workers", platformImport);
	await expectAnchoredTask(waitUntil);
	expect(platformImport).not.toHaveBeenCalled();
});

it.each(["stub", "missing"])(
	"anchors deferred work on workerd when the adapter virtual module is %s",
	async (mode) => {
		const waitUntil = vi.fn();
		vi.doMock("virtual:emdash/wait-until", () => {
			if (mode === "missing") throw new Error("no integration");
			return { waitUntil: undefined };
		});
		vi.doMock("cloudflare:workers", () => ({ waitUntil }));
		await expectAnchoredTask(waitUntil);
	},
);

it("runs deferred work without a host binding on Node", async () => {
	vi.doMock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }));
	vi.doMock("cloudflare:workers", () => {
		throw new Error("unsupported module scheme");
	});
	const { after } = await import("../../src/after.js");
	let completed = false;
	after(() => {
		completed = true;
	});
	await waitForDeferredTasks();
	expect(completed).toBe(true);
});

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

function setVercelWaitUntil(waitUntil: ReturnType<typeof vi.fn> | undefined): void {
	(globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] = waitUntil
		? { get: () => ({ waitUntil }) }
		: undefined;
}

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT];
});

function mockHost(waitUntil: ReturnType<typeof vi.fn> | undefined, longLivedProcess = false) {
	vi.doMock("virtual:emdash/wait-until", () => ({ waitUntil, longLivedProcess }));
	vi.doMock("cloudflare:workers", () => {
		throw new Error("unsupported module scheme");
	});
}

it("prefers the request's waitUntil over the Vercel context and the adapter binding", async () => {
	const fromRequest = vi.fn();
	const fromVercel = vi.fn();
	const fromAdapter = vi.fn();
	mockHost(fromAdapter);
	setVercelWaitUntil(fromVercel);
	const { runWithContext } = await import("../../src/request-context.js");

	await runWithContext({ editMode: false, hostWaitUntil: () => fromRequest }, () =>
		expectAnchoredTask(fromRequest),
	);
	expect(fromVercel).not.toHaveBeenCalled();
	expect(fromAdapter).not.toHaveBeenCalled();
});

it("uses the Vercel request context before the adapter binding", async () => {
	const fromVercel = vi.fn();
	const fromAdapter = vi.fn();
	mockHost(fromAdapter);
	setVercelWaitUntil(fromVercel);

	await expectAnchoredTask(fromVercel);
	expect(fromAdapter).not.toHaveBeenCalled();
});

it("reports whether deferred work can run after the response", async () => {
	mockHost(undefined);
	let { canRunAfterResponse } = await import("../../src/after.js");
	expect(await canRunAfterResponse()).toBe(false);

	setVercelWaitUntil(vi.fn());
	expect(await canRunAfterResponse()).toBe(true);
	setVercelWaitUntil(undefined);

	const { runWithContext } = await import("../../src/request-context.js");
	expect(
		await runWithContext({ editMode: false, hostWaitUntil: () => vi.fn() }, () =>
			canRunAfterResponse(),
		),
	).toBe(true);

	vi.resetModules();
	mockHost(vi.fn());
	({ canRunAfterResponse } = await import("../../src/after.js"));
	expect(await canRunAfterResponse()).toBe(true);

	vi.resetModules();
	mockHost(undefined, true);
	({ canRunAfterResponse } = await import("../../src/after.js"));
	expect(await canRunAfterResponse()).toBe(true);
});
