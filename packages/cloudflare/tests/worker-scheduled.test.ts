import { beforeEach, expect, it, vi } from "vitest";

const scheduled = vi.hoisted(() => ({
	general: vi.fn(async (_options?: unknown) => ({ published: [] })),
}));
const cache = vi.hoisted(() => ({
	invalidate: vi.fn(async (_options?: unknown) => {}),
}));

vi.mock("@astrojs/cloudflare/entrypoints/server", () => ({ default: {} }));
vi.mock("astro/app/entrypoint", () => ({
	createApp: () => ({
		manifest: {
			cacheConfig: { options: {} },
			cacheProvider: async () => ({ default: () => cache }),
		},
	}),
}));
vi.mock("emdash/middleware", () => ({ runScheduledTasks: scheduled.general }));
vi.mock("../src/sandbox/index.js", () => ({ PluginBridge: vi.fn() }));

import { createScheduledHandler } from "../src/worker.js";

beforeEach(() => {
	vi.restoreAllMocks();
	scheduled.general.mockClear();
	cache.invalidate.mockClear();
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
