import { beforeEach, expect, it, vi } from "vitest";

type MaintenanceContinuation =
	| { kind: "none" }
	| { kind: "immediate" }
	| { kind: "delayed"; delaySeconds: 30 };

const scheduled = vi.hoisted(() => {
	const general = vi.fn(async (_options?: unknown) => ({ published: [] }));
	const mediaUsageSlice = vi.fn<() => Promise<MaintenanceContinuation>>(async () => ({
		kind: "none",
	}));
	return {
		general,
		mediaUsageSlice,
	};
});
const astro = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@astrojs/cloudflare/entrypoints/server", () => ({ default: { fetch: astro.fetch } }));
vi.mock("astro/app/entrypoint", () => ({
	createApp: () => ({ pipeline: { getCacheProvider: async () => null } }),
}));
vi.mock("emdash/middleware", () => ({
	runScheduledTasks: scheduled.general,
	runMediaUsageMaintenanceSlice: scheduled.mediaUsageSlice,
}));
vi.mock("../src/sandbox/index.js", () => ({ PluginBridge: vi.fn() }));

import {
	createMediaUsageFetchHandler,
	createMediaUsageQueueHandler,
	createScheduledHandler,
	type MediaUsageWakeMessage,
} from "../src/worker.js";

beforeEach(() => {
	vi.restoreAllMocks();
	astro.fetch.mockReset();
	astro.fetch.mockResolvedValue(new Response(null, { status: 204 }));
	scheduled.general.mockClear();
	scheduled.mediaUsageSlice.mockClear();
	scheduled.mediaUsageSlice.mockResolvedValue({ kind: "none" });
});

it("runs general maintenance for the configured Cron", async () => {
	const handler = createScheduledHandler({ generalCron: "* * * * *" });

	await invoke(handler, "* * * * *");

	expect(scheduled.general).toHaveBeenCalledOnce();
	expect(scheduled.mediaUsageSlice).not.toHaveBeenCalled();
});

it("ignores unexpected Cron expressions", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const handler = createScheduledHandler({ generalCron: "* * * * *" });

	await invoke(handler, "0 * * * *");

	expect(scheduled.general).not.toHaveBeenCalled();
	expect(scheduled.mediaUsageSlice).not.toHaveBeenCalled();
	expect(warning).toHaveBeenCalledExactlyOnceWith(
		"[scheduled] Ignoring unexpected Cron expression: 0 * * * *",
	);
});

it("runs any configured trigger when no expression is specified", async () => {
	const handler = createScheduledHandler();

	await invoke(handler, "custom expression");
	expect(scheduled.general).toHaveBeenCalledOnce();
	expect(scheduled.mediaUsageSlice).not.toHaveBeenCalled();
});

it("rejects an empty configured expression", () => {
	expect(() => createScheduledHandler({ generalCron: "" })).toThrow(/non-empty/i);
	expect(createScheduledHandler({ generalCron: " * * * * * " })).toBeTypeOf("function");
});

it("queues one immediate wake after a successful activation response", async () => {
	const send = vi.fn(async () => {});
	const handler = createMediaUsageFetchHandler({ fetch: astro.fetch }, () => queueBinding(send));

	await invokeFetch(
		handler,
		new Request("https://example.com/_emdash/api/admin/media-usage/activation", {
			method: "POST",
		}),
		{},
	);

	expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1 });
});

it("does not queue activation wakes for another route or an unsuccessful response", async () => {
	const send = vi.fn(async () => {});
	const handler = createMediaUsageFetchHandler({ fetch: astro.fetch }, () => queueBinding(send));

	await invokeFetch(handler, new Request("https://example.com/_emdash/api/content"), {});
	astro.fetch.mockResolvedValueOnce(new Response(null, { status: 409 }));
	await invokeFetch(
		handler,
		new Request("https://example.com/_emdash/api/admin/media-usage/activation", {
			method: "POST",
		}),
		{},
	);

	expect(send).not.toHaveBeenCalled();
});

it("redacts an activation wake failure without changing the successful response", async () => {
	const send = vi.fn(async () => {
		throw new Error("private queue detail");
	});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const handler = createMediaUsageFetchHandler({ fetch: astro.fetch }, () => queueBinding(send));

	const response = await invokeFetch(
		handler,
		new Request("https://example.com/_emdash/api/admin/media-usage/activation", {
			method: "POST",
		}),
		{},
	);

	expect(response.status).toBe(204);
	expect(error).toHaveBeenCalledExactlyOnceWith(
		"[activation] Failed to queue Media Usage maintenance wake",
	);
	expect(JSON.stringify(error.mock.calls)).not.toContain("private queue detail");
});

it("coalesces a delivered batch into one slice and one successor", async () => {
	const send = vi.fn(async () => {});
	const handler = createMediaUsageQueueHandler(() => queueBinding(send));
	scheduled.mediaUsageSlice.mockResolvedValue({ kind: "immediate" });

	await invokeQueue(handler, [wakeMessage(), wakeMessage()], {});

	expect(scheduled.mediaUsageSlice).toHaveBeenCalledOnce();
	expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1 });
});

it("lets the Queue drain when the durable database is idle", async () => {
	const send = vi.fn(async () => {});
	const handler = createMediaUsageQueueHandler(() => queueBinding(send));

	await invokeQueue(handler, [wakeMessage()], {});

	expect(scheduled.mediaUsageSlice).toHaveBeenCalledOnce();
	expect(send).not.toHaveBeenCalled();
});

it("acknowledges invalid wakes without logging their body or running work", async () => {
	const send = vi.fn(async () => {});
	const handler = createMediaUsageQueueHandler(() => queueBinding(send));
	const invalid = wakeMessage({ version: 2, secret: "do-not-log" });
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

	await invokeQueue(handler, [invalid], {});

	expect(invalid.ack).toHaveBeenCalledOnce();
	expect(warning).toHaveBeenCalledWith("[queue] Ignoring invalid Media Usage wake");
	expect(JSON.stringify(warning.mock.calls)).not.toContain("do-not-log");
	expect(scheduled.mediaUsageSlice).not.toHaveBeenCalled();
	expect(send).not.toHaveBeenCalled();
});

it("retries valid wakes if a delayed successor cannot be sent", async () => {
	const send = vi.fn(async () => {
		throw new Error("send failed");
	});
	const handler = createMediaUsageQueueHandler(() => queueBinding(send));
	const invalid = wakeMessage({ version: 9 });
	const valid = wakeMessage();
	scheduled.mediaUsageSlice.mockResolvedValue({ kind: "delayed", delaySeconds: 30 });
	vi.spyOn(console, "warn").mockImplementation(() => {});

	await expect(invokeQueue(handler, [invalid, valid], {})).rejects.toThrow("send failed");

	expect(invalid.ack).toHaveBeenCalledOnce();
	expect(valid.ack).not.toHaveBeenCalled();
	expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1 }, { delaySeconds: 30 });
});

it("fails before database work when the required Queue binding is missing", async () => {
	type MissingQueueEnv = { MEDIA_USAGE_QUEUE?: Queue<MediaUsageWakeMessage> };
	const handler = createMediaUsageQueueHandler<MissingQueueEnv>((env) => env.MEDIA_USAGE_QUEUE!);
	const invalid = wakeMessage({ version: 4 });
	const valid = wakeMessage();
	vi.spyOn(console, "warn").mockImplementation(() => {});

	await expect(invokeQueue(handler, [invalid, valid], {})).rejects.toThrow(/binding/i);
	expect(invalid.ack).toHaveBeenCalledOnce();
	expect(valid.ack).not.toHaveBeenCalled();
	expect(scheduled.mediaUsageSlice).not.toHaveBeenCalled();
});

async function invoke<Env>(
	handler: ExportedHandlerScheduledHandler<Env>,
	cron: string,
	env: Env,
): Promise<void>;
async function invoke(handler: ExportedHandlerScheduledHandler, cron: string): Promise<void>;
async function invoke(
	handler: ExportedHandlerScheduledHandler,
	cron: string,
	env: unknown = {},
): Promise<void> {
	const pending: Promise<unknown>[] = [];
	const context = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
	};
	Reflect.apply(handler, undefined, [{ cron }, env, context]);
	await Promise.all(pending);
}

async function invokeQueue<Env>(
	handler: ExportedHandlerQueueHandler<Env, MediaUsageWakeMessage>,
	messages: Message[],
	env: Env,
): Promise<void> {
	const batch: MessageBatch = {
		messages,
		queue: "media-usage",
		retryAll: vi.fn(),
		ackAll: vi.fn(),
	};
	await Reflect.apply(handler, undefined, [batch, env, {}]);
}

async function invokeFetch<Env>(
	handler: ExportedHandlerFetchHandler<Env>,
	request: Request,
	env: Env,
): Promise<Response> {
	const pending: Promise<unknown>[] = [];
	const context = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
	};
	const response = await Reflect.apply(handler, undefined, [request, env, context]);
	await Promise.all(pending);
	return response;
}

function wakeMessage(body: unknown = { version: 1 }): Message {
	return {
		id: crypto.randomUUID(),
		timestamp: new Date(),
		body,
		attempts: 1,
		retry: vi.fn(),
		ack: vi.fn(),
	};
}

function queueBinding(send: Queue<MediaUsageWakeMessage>["send"]): Queue<MediaUsageWakeMessage> {
	return { send, sendBatch: vi.fn(async () => {}) };
}
