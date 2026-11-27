import { beforeEach, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({
	default: undefined as { emdashInvalidateCache: (tags: string[]) => Promise<void> } | undefined,
}));
const scheduled = vi.hoisted(() => ({
	general: vi.fn(async (_options?: unknown) => ({ published: [] })),
}));
const cache = vi.hoisted(() => ({
	invalidate: vi.fn(async (_options?: unknown) => {}),
}));
const astro = vi.hoisted(() => ({
	fetch: vi.fn(async (_request: Request, _env: unknown, _ctx: unknown) => new Response("Astro")),
	upgrade: vi.fn((_request: Request, _env: unknown): Promise<Response> | null => null),
	cacheProvider: vi.fn(
		async (): Promise<{ default: (() => typeof cache) | null }> => ({ default: () => cache }),
	),
}));

vi.mock("cloudflare:workers", () => ({
	exports: loopback,
	WorkerEntrypoint: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));
vi.mock("@astrojs/cloudflare/entrypoints/server", () => ({ default: { fetch: astro.fetch } }));
vi.mock("../src/rooms/upgrade.js", () => ({ handleRoomUpgrade: astro.upgrade }));
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
vi.mock("../src/rooms/object.js", () => ({ EmDashRoom: vi.fn() }));
vi.mock("../src/rooms/site.js", () => ({ EmDashRoomSite: vi.fn() }));

import { createScheduledHandler, EmDashWorker } from "../src/worker.js";

beforeEach(() => {
	vi.restoreAllMocks();
	loopback.default = undefined;
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("@emdash-cms/cloudflare:astro-app")];
	delete (globalThis as Record<symbol, unknown>)[
		Symbol.for("@emdash-cms/cloudflare:cache-provider")
	];
	scheduled.general.mockClear();
	cache.invalidate.mockClear();
	astro.fetch.mockClear();
	astro.upgrade.mockClear();
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

async function invoke(
	handler: ExportedHandlerScheduledHandler,
	cron: string,
	entrypoint?: { emdashInvalidateCache: (tags: string[]) => Promise<void> },
): Promise<void> {
	loopback.default = entrypoint;
	const pending: Promise<unknown>[] = [];
	const context = {
		exports: { default: entrypoint },
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
	};
	Reflect.apply(handler, undefined, [{ cron }, {}, context]);
	await Promise.all(pending);
}

it.each(["publishing", "plugin writes"])(
	"evicts cached pages through the default entrypoint after scheduled %s",
	async (source) => {
		const pages = new Map([
			["post-1", "stale"],
			["unrelated", "keep"],
		]);
		let scope = "scheduled";
		cache.invalidate.mockImplementationOnce(async (options) => {
			// Model Workers Cache's entrypoint scoping: a successful cron purge evicts nothing.
			if (scope !== "default") return;
			for (const tag of (options as { tags: string[] }).tags) pages.delete(tag);
		});
		const worker = new EmDashWorker({} as ExecutionContext, {});
		const rpc = {
			async emdashInvalidateCache(tags: string[]) {
				scope = "default";
				try {
					await worker.emdashInvalidateCache(tags);
				} finally {
					scope = "scheduled";
				}
			},
		};
		scheduled.general.mockImplementationOnce(async (options) => {
			const callbacks = options as {
				onPublished: (refs: Array<{ collection: string; id: string }>) => Promise<void>;
				invalidateContentCache: (tags: string[]) => Promise<void>;
			};
			// The handler has returned before this waitUntil work invalidates anything.
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (source === "publishing") {
				await callbacks.onPublished([{ collection: "posts", id: "post-1" }]);
			} else {
				await callbacks.invalidateContentCache(["posts", "post-1"]);
			}
			return { published: [] };
		});

		await invoke(
			(controller, _env, ctx) => new EmDashWorker(ctx, {}).scheduled(controller),
			"* * * * *",
			rpc,
		);

		expect([...pages.entries()]).toEqual([["unrelated", "keep"]]);
	},
);

it("logs RPC failures without attempting an ineffective cron-local purge", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const failure = new Error("RPC unavailable");
	scheduled.general.mockImplementationOnce(async (options) => {
		await (
			options as { invalidateContentCache: (tags: string[]) => Promise<void> }
		).invalidateContentCache(["posts"]);
		return { published: [] };
	});

	await invoke(createScheduledHandler({ invalidateViaDefaultEntrypoint: true }), "* * * * *", {
		emdashInvalidateCache: async () => {
			throw failure;
		},
	});

	expect(cache.invalidate).not.toHaveBeenCalled();
	expect(error).toHaveBeenCalledExactlyOnceWith("[scheduled] runScheduledTasks failed:", failure);
});

it("skips empty invalidations before making an RPC call", async () => {
	const rpc = { emdashInvalidateCache: vi.fn(async () => {}) };
	scheduled.general.mockImplementationOnce(async (options) => {
		const callbacks = options as {
			onPublished: (refs: []) => Promise<void>;
			invalidateContentCache: (tags: string[]) => Promise<void>;
		};
		await callbacks.onPublished([]);
		await callbacks.invalidateContentCache([]);
		return { published: [] };
	});
	await invoke(createScheduledHandler({ invalidateViaDefaultEntrypoint: true }), "* * * * *", rpc);
	expect(rpc.emdashInvalidateCache).not.toHaveBeenCalled();
	expect(astro.cacheProvider).not.toHaveBeenCalled();
});

it("allows the RPC method to run without a configured cache provider", async () => {
	astro.cacheProvider.mockResolvedValueOnce({ default: null });
	await expect(
		new EmDashWorker({} as ExecutionContext, {}).emdashInvalidateCache(["posts"]),
	).resolves.toBeUndefined();
	expect(cache.invalidate).not.toHaveBeenCalled();
});

it("forwards requests, bindings and execution context to Astro from the class entrypoint", async () => {
	const request = new Request("https://example.com/posts");
	const env = { DB: "binding" };
	const ctx = {} as ExecutionContext;
	const response = await new EmDashWorker(ctx, env).fetch(request);
	expect(await response.text()).toBe("Astro");
	expect(astro.fetch).toHaveBeenCalledExactlyOnceWith(request, env, ctx);
});

it("answers room upgrades before running Astro from the class entrypoint", async () => {
	astro.upgrade.mockReturnValueOnce(Promise.resolve(new Response("room")));
	const response = await new EmDashWorker({} as ExecutionContext, {}).fetch(
		new Request("https://example.com/room"),
	);
	expect(await response.text()).toBe("room");
	expect(astro.fetch).not.toHaveBeenCalled();
});

it("keeps legacy handlers local even when every loopback property looks callable", async () => {
	const rpc = vi.fn(async () => {
		throw new Error("RPC receiver does not implement method");
	});
	const entrypoint = new Proxy({ emdashInvalidateCache: rpc }, { get: () => rpc });
	scheduled.general.mockImplementationOnce(async (options) => {
		await (
			options as { invalidateContentCache: (tags: string[]) => Promise<void> }
		).invalidateContentCache(["posts"]);
		return { published: [] };
	});
	await invoke(createScheduledHandler(), "* * * * *", entrypoint);
	expect(cache.invalidate).toHaveBeenCalledExactlyOnceWith({ tags: ["posts"] });
	expect(rpc).not.toHaveBeenCalled();
});

it("keeps legacy invalidation working without ExecutionContext.exports", async () => {
	scheduled.general.mockImplementationOnce(async (options) => {
		await (
			options as { invalidateContentCache: (tags: string[]) => Promise<void> }
		).invalidateContentCache(["posts"]);
		return { published: [] };
	});
	const pending: Promise<unknown>[] = [];
	Reflect.apply(createScheduledHandler(), undefined, [
		{ cron: "* * * * *" },
		{},
		{ waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
	]);
	await Promise.all(pending);
	expect(cache.invalidate).toHaveBeenCalledExactlyOnceWith({ tags: ["posts"] });
});

it("does not retain the scheduled invocation's RPC stub for later plugin actions", async () => {
	let retained: ((tags: string[]) => Promise<void>) | undefined;
	scheduled.general.mockImplementationOnce(async (options) => {
		retained = (options as { invalidateContentCache: (tags: string[]) => Promise<void> })
			.invalidateContentCache;
		return { published: [] };
	});
	const expired = vi.fn(async () => {
		throw new Error("Invocation already ended");
	});
	await invoke(createScheduledHandler({ invalidateViaDefaultEntrypoint: true }), "* * * * *", {
		emdashInvalidateCache: expired,
	});
	const current = vi.fn(async () => {});
	loopback.default = { emdashInvalidateCache: current };
	await retained!(["posts", "later-write"]);
	expect(expired).not.toHaveBeenCalled();
	expect(current).toHaveBeenCalledExactlyOnceWith(["posts", "later-write"]);
});
