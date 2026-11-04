import { beforeEach, expect, it, vi } from "vitest";

const scheduled = vi.hoisted(() => ({
	general: vi.fn(async (_options?: unknown) => ({ published: [] })),
}));
const cache = vi.hoisted(() => ({
	invalidate: vi.fn(async (_options?: unknown) => {}),
}));
const astro = vi.hoisted(() => ({
	cacheProvider: vi.fn(
		async (): Promise<{ default: (() => typeof cache) | null }> => ({ default: () => cache }),
	),
}));

vi.mock("@astrojs/cloudflare/entrypoints/server", () => ({ default: {} }));
vi.mock("astro/app/entrypoint", () => ({
	createApp: () => ({
		manifest: {
			cacheConfig: { options: {} },
			cacheProvider: astro.cacheProvider,
		},
	}),
}));
vi.mock("emdash/middleware", () => ({ runScheduledTasks: scheduled.general }));
vi.mock("../src/sandbox/bridge.js", () => ({ PluginBridge: vi.fn() }));

import { createScheduledHandler } from "../src/worker.js";

beforeEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("@emdash-cms/cloudflare:astro-app")];
	delete (globalThis as Record<symbol, unknown>)[
		Symbol.for("@emdash-cms/cloudflare:cache-provider")
	];
	scheduled.general.mockClear();
	cache.invalidate.mockClear();
	astro.cacheProvider.mockReset();
	astro.cacheProvider.mockResolvedValue({ default: () => cache });
});

it("runs general maintenance for the configured Cron", async () => {
	const handler = createScheduledHandler({ generalCron: "* * * * *" });

	await invoke(handler, "* * * * *");

	expect(scheduled.general).toHaveBeenCalledOnce();
});

it("ignores unexpected Cron expressions", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const handler = createScheduledHandler({ generalCron: "* * * * *" });

	await invoke(handler, "0 * * * *");

	expect(scheduled.general).not.toHaveBeenCalled();
	expect(warning).toHaveBeenCalledExactlyOnceWith(
		"[scheduled] Ignoring unexpected Cron expression: 0 * * * *",
	);
});

it("runs any configured trigger when no expression is specified", async () => {
	const handler = createScheduledHandler();

	await invoke(handler, "custom expression");

	expect(scheduled.general).toHaveBeenCalledOnce();
});

it("invalidates cache tags after scheduled content is published", async () => {
	scheduled.general.mockImplementationOnce(async (options) => {
		const onPublished = (
			options as {
				onPublished: (published: Array<{ collection: string; id: string }>) => Promise<void>;
			}
		).onPublished;
		await onPublished([
			{ collection: "posts", id: "post-1" },
			{ collection: "posts", id: "post-2" },
		]);
		return { published: [] };
	});
	const handler = createScheduledHandler();

	await invoke(handler, "custom expression");

	expect(cache.invalidate).toHaveBeenCalledExactlyOnceWith({
		tags: ["posts", "post-1", "post-2"],
	});
});

it("provides cache invalidation to plugin actions in scheduled hooks", async () => {
	scheduled.general.mockImplementationOnce(async (options) => {
		const invalidateContentCache = (
			options as {
				invalidateContentCache: (tags: string[]) => Promise<void>;
			}
		).invalidateContentCache;
		await invalidateContentCache(["posts", "post-1"]);
		return { published: [] };
	});
	const handler = createScheduledHandler();

	await invoke(handler, "custom expression");

	expect(cache.invalidate).toHaveBeenCalledExactlyOnceWith({
		tags: ["posts", "post-1"],
	});
});

it("does nothing when no cache provider is configured", async () => {
	astro.cacheProvider.mockResolvedValueOnce({ default: null });
	scheduled.general.mockImplementationOnce(async (options) => {
		const onPublished = (
			options as {
				onPublished: (published: Array<{ collection: string; id: string }>) => Promise<void>;
			}
		).onPublished;
		await onPublished([{ collection: "posts", id: "post-1" }]);
		return { published: [] };
	});
	const handler = createScheduledHandler();

	await invoke(handler, "custom expression");

	expect(cache.invalidate).not.toHaveBeenCalled();
});

it("retries cache provider loading after a transient failure", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	astro.cacheProvider.mockRejectedValueOnce(new Error("provider unavailable"));
	scheduled.general.mockImplementation(async (options) => {
		const onPublished = (
			options as {
				onPublished: (published: Array<{ collection: string; id: string }>) => Promise<void>;
			}
		).onPublished;
		await onPublished([{ collection: "posts", id: "post-1" }]);
		return { published: [] };
	});
	const handler = createScheduledHandler();

	await invoke(handler, "custom expression");
	await invoke(handler, "custom expression");

	expect(astro.cacheProvider).toHaveBeenCalledTimes(2);
	expect(cache.invalidate).toHaveBeenCalledExactlyOnceWith({ tags: ["posts", "post-1"] });
	expect(error).toHaveBeenCalledOnce();
});

it("rejects an empty configured expression", () => {
	expect(() => createScheduledHandler({ generalCron: "" })).toThrow(/non-empty/i);
	expect(createScheduledHandler({ generalCron: " * * * * * " })).toBeTypeOf("function");
});

async function invoke(handler: ExportedHandlerScheduledHandler, cron: string): Promise<void> {
	const pending: Promise<unknown>[] = [];
	const context = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
	};
	Reflect.apply(handler, undefined, [{ cron }, {}, context]);
	await Promise.all(pending);
}
