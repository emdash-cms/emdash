import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	invalidateRedirectCache,
	loadCachedRedirects,
	type RedirectRuleSet,
	type RedirectSource,
} from "../../../src/redirects/cache.js";

function ruleSet(version: string | null, destination: string): RedirectRuleSet {
	return {
		version,
		exact: [{ id: "exact", source: "/old", destination, type: 301 }],
		patterns: [{ id: "pattern", source: "/blog/[slug]", destination: "/posts/[slug]", type: 301 }],
	};
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

class FakeSource implements RedirectSource {
	current: RedirectRuleSet;
	loads = 0;
	checks = 0;
	loadGate: Promise<void> | null = null;
	onLoad: (() => void) | null = null;
	checkError: Error | null = null;

	constructor(current: RedirectRuleSet) {
		this.current = current;
	}

	async load(): Promise<RedirectRuleSet> {
		this.loads++;
		const snapshot = this.current;
		this.onLoad?.();
		if (this.loadGate) await this.loadGate;
		return snapshot;
	}

	async isCurrent(version: string): Promise<boolean> {
		this.checks++;
		if (this.checkError) throw this.checkError;
		return this.current.version === version;
	}
}

async function destinationOf(source: RedirectSource): Promise<string | undefined> {
	return (await loadCachedRedirects(source)).exact.get("/old")?.destination;
}

describe("redirect cache", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });
		invalidateRedirectCache();
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		invalidateRedirectCache();
		vi.useRealTimers();
	});

	it("compiles exact and pattern rules from one load", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));

		const cached = await loadCachedRedirects(source);

		expect(cached.version).toBe("v1");
		expect(cached.exact.get("/old")?.destination).toBe("/new");
		expect(cached.patterns.map((rule) => rule.redirect.id)).toEqual(["pattern"]);
		expect(source.loads).toBe(1);
	});

	it("skips pattern rules that do not validate", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const source = new FakeSource({
			version: "v1",
			exact: [],
			patterns: [{ id: "bad", source: "/[...rest]/after", destination: "/x", type: 301 }],
		});

		const cached = await loadCachedRedirects(source);

		expect(cached.patterns).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping redirect bad"));
		warn.mockRestore();
	});

	it("coalesces concurrent cold loads into one source load", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));
		const loadGate = gate();
		source.loadGate = loadGate.promise;

		const first = destinationOf(source);
		const second = destinationOf(source);
		loadGate.release();

		await expect(Promise.all([first, second])).resolves.toEqual(["/new", "/new"]);
		expect(source.loads).toBe(1);
	});

	it("does not install rules loaded before an invalidation", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));
		const loadGate = gate();
		source.loadGate = loadGate.promise;
		source.onLoad = () => {
			source.onLoad = null;
			source.loadGate = null;
			source.current = ruleSet("v2", "/newer");
			invalidateRedirectCache();
			loadGate.release();
		};

		await expect(destinationOf(source)).resolves.toBe("/newer");
		expect(source.loads).toBe(2);
	});

	it("bounds cold-load retries when writes keep invalidating the cache", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));
		let invalidationsRemaining = 3;
		source.onLoad = () => {
			if (invalidationsRemaining-- > 0) invalidateRedirectCache();
		};

		await expect(destinationOf(source)).resolves.toBe("/new");
		expect(source.loads).toBe(3);

		await expect(destinationOf(source)).resolves.toBe("/new");
		expect(source.loads).toBe(4);
	});

	it("serves warm rules without consulting the source until they expire", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));
		await destinationOf(source);

		vi.advanceTimersByTime(29_999);
		await expect(destinationOf(source)).resolves.toBe("/new");
		await waitForDeferredTasks();

		expect(source.loads).toBe(1);
		expect(source.checks).toBe(0);
	});

	it("extends expired rules that are still current without reloading them", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));
		await destinationOf(source);

		vi.advanceTimersByTime(30_000);
		await expect(destinationOf(source)).resolves.toBe("/new");
		await waitForDeferredTasks();
		expect(source.checks).toBe(1);

		vi.advanceTimersByTime(29_999);
		await destinationOf(source);
		await waitForDeferredTasks();

		expect(source.checks).toBe(1);
		expect(source.loads).toBe(1);
	});

	it("keeps serving expired rules while it reloads a changed source in the background", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));
		await destinationOf(source);
		source.current = ruleSet("v2", "/newer");

		vi.advanceTimersByTime(30_000);
		await expect(destinationOf(source)).resolves.toBe("/new");
		await waitForDeferredTasks();

		await expect(destinationOf(source)).resolves.toBe("/newer");
		expect(source.checks).toBe(1);
		expect(source.loads).toBe(2);
	});

	it("reloads expired rules that have no version", async () => {
		const source = new FakeSource(ruleSet(null, "/new"));
		await destinationOf(source);
		source.current = ruleSet(null, "/newer");

		vi.advanceTimersByTime(30_000);
		await destinationOf(source);
		await waitForDeferredTasks();

		await expect(destinationOf(source)).resolves.toBe("/newer");
		expect(source.checks).toBe(0);
		expect(source.loads).toBe(2);
	});

	it("starts one background revalidation for concurrent requests", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));
		await destinationOf(source);
		source.current = ruleSet("v2", "/newer");

		vi.advanceTimersByTime(30_000);
		await Promise.all([destinationOf(source), destinationOf(source), destinationOf(source)]);
		await waitForDeferredTasks();

		expect(source.checks).toBe(1);
		expect(source.loads).toBe(2);
	});

	it("waits a full cache period before retrying a failed revalidation", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const source = new FakeSource(ruleSet("v1", "/new"));
		await destinationOf(source);
		source.checkError = new Error("database unavailable");

		vi.advanceTimersByTime(30_000);
		await expect(destinationOf(source)).resolves.toBe("/new");
		await waitForDeferredTasks();
		expect(error).toHaveBeenCalledWith(
			"[emdash:redirects] revalidating redirects failed:",
			source.checkError,
		);

		vi.advanceTimersByTime(29_999);
		await expect(destinationOf(source)).resolves.toBe("/new");
		await waitForDeferredTasks();
		expect(source.checks).toBe(1);

		vi.advanceTimersByTime(1);
		await destinationOf(source);
		await waitForDeferredTasks();
		expect(source.checks).toBe(2);
		error.mockRestore();
	});

	it("does not install a background reload that an invalidation overtook", async () => {
		const source = new FakeSource(ruleSet("v1", "/new"));
		await destinationOf(source);
		source.current = ruleSet("v2", "/stale");
		const loadGate = gate();
		source.loadGate = loadGate.promise;
		source.onLoad = () => {
			source.onLoad = null;
			source.current = ruleSet("v3", "/newest");
			invalidateRedirectCache();
		};

		vi.advanceTimersByTime(30_000);
		await destinationOf(source);
		await vi.waitFor(() => expect(source.loads).toBe(2));
		source.loadGate = null;
		loadGate.release();
		await waitForDeferredTasks();

		await expect(destinationOf(source)).resolves.toBe("/newest");
	});
});
