import { beforeEach, expect, it, vi } from "vitest";

type MaintenanceStepResult = {
	state: "inactive" | "idle" | "blocked" | "progress";
	continuation: { kind: "none" } | { kind: "immediate" } | { kind: "delayed"; delaySeconds: 30 };
	taskClass: "entry_work" | "collection_deletion" | "reconciliation" | null;
	turn: number | null;
};

const scheduled = vi.hoisted(() => ({
	general: vi.fn(async () => ({ published: [] })),
	mediaUsage: vi.fn(async () => ({ outcome: "inactive", taskClass: null, turn: null })),
	mediaUsageStep: vi.fn<() => Promise<MaintenanceStepResult>>(async () => ({
		state: "idle",
		continuation: { kind: "none" },
		taskClass: "entry_work",
		turn: 0,
	})),
}));

vi.mock("@astrojs/cloudflare/entrypoints/server", () => ({ default: { fetch: vi.fn() } }));
vi.mock("astro/app/entrypoint", () => ({
	createApp: () => ({ pipeline: { getCacheProvider: async () => null } }),
}));
vi.mock("emdash/middleware", () => ({
	runScheduledTasks: scheduled.general,
	runScheduledMediaUsageTasks: scheduled.mediaUsage,
	runMediaUsageMaintenanceStep: scheduled.mediaUsageStep,
}));
vi.mock("../src/sandbox/index.js", () => ({ PluginBridge: vi.fn() }));

import {
	createMediaUsageQueueHandler,
	createScheduledHandler,
	type MediaUsageWakeMessage,
	type ScheduledHandlerOptions,
} from "../src/worker.js";

beforeEach(() => {
	scheduled.general.mockClear();
	scheduled.mediaUsage.mockClear();
	scheduled.mediaUsageStep.mockClear();
	scheduled.mediaUsageStep.mockResolvedValue({
		state: "idle",
		continuation: { kind: "none" },
		taskClass: "entry_work",
		turn: 0,
	});
});

it("uses the default Media Usage expression and treats every other expression as general", async () => {
	const handler = createScheduledHandler();

	await invoke(handler, "custom expression");
	expect(scheduled.general).toHaveBeenCalledOnce();
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();

	scheduled.general.mockClear();
	await invoke(handler, "*/2 * * * *");
	expect(scheduled.general).not.toHaveBeenCalled();
	expect(scheduled.mediaUsage).toHaveBeenCalledOnce();
});

it("dispatches distinct configured cron expressions to exactly one lane", async () => {
	const handler = createScheduledHandler({
		generalCron: "* * * * *",
		mediaUsageCron: "*/2 * * * *",
	});

	await invoke(handler, "* * * * *");
	expect(scheduled.general).toHaveBeenCalledOnce();
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();

	scheduled.general.mockClear();
	await invoke(handler, "*/2 * * * *");
	expect(scheduled.general).not.toHaveBeenCalled();
	expect(scheduled.mediaUsage).toHaveBeenCalledOnce();

	scheduled.mediaUsage.mockClear();
	await invoke(handler, "0 0 * * *");
	expect(scheduled.general).not.toHaveBeenCalled();
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();
});

it("allows either default expression to be overridden independently", async () => {
	const customMedia = createScheduledHandler({ mediaUsageCron: "*/5 * * * *" });
	await invoke(customMedia, "*/5 * * * *");
	expect(scheduled.mediaUsage).toHaveBeenCalledOnce();
	expect(scheduled.general).not.toHaveBeenCalled();

	scheduled.mediaUsage.mockClear();
	await invoke(customMedia, "15 * * * *");
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();
	expect(scheduled.general).toHaveBeenCalledOnce();

	scheduled.general.mockClear();
	const customGeneral = createScheduledHandler({ generalCron: "0 * * * *" });
	await invoke(customGeneral, "*/2 * * * *");
	expect(scheduled.mediaUsage).toHaveBeenCalledOnce();
	expect(scheduled.general).not.toHaveBeenCalled();

	scheduled.mediaUsage.mockClear();
	await invoke(customGeneral, "0 * * * *");
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();
	expect(scheduled.general).toHaveBeenCalledOnce();

	scheduled.general.mockClear();
	await invoke(customGeneral, "15 * * * *");
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();
	expect(scheduled.general).not.toHaveBeenCalled();
});

it("rejects empty or aliased configured expressions", () => {
	expect(() =>
		createScheduledHandler({ generalCron: "* * * * *", mediaUsageCron: "* * * * *" }),
	).toThrow(/must differ/i);
	expect(() => createScheduledHandler({ generalCron: "", mediaUsageCron: "*/2 * * * *" })).toThrow(
		/non-empty/i,
	);
	expect(() => createScheduledHandler({ mediaUsageCron: " " })).toThrow(/non-empty/i);
	expect(() => createScheduledHandler({ generalCron: " */2 * * * * " })).toThrow(/must differ/i);
});

it("keeps the existing non-generic scheduled options type usable", () => {
	const options: ScheduledHandlerOptions = { mediaUsageCron: "*/5 * * * *" };
	expect(createScheduledHandler(options)).toBeTypeOf("function");
});

it("uses configured Cron as a Queue wake without initializing Media Usage", async () => {
	const send = vi.fn(async () => {});
	const queue = queueBinding(send);
	const handler = createScheduledHandler<{ MEDIA_USAGE_QUEUE: Queue<MediaUsageWakeMessage> }>({
		generalCron: "* * * * *",
		mediaUsageCron: "*/2 * * * *",
		resolveMediaUsageQueue: (env) => env.MEDIA_USAGE_QUEUE,
	});

	await invoke(handler, "*/2 * * * *", { MEDIA_USAGE_QUEUE: queue });

	expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1 });
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();
	expect(scheduled.mediaUsageStep).not.toHaveBeenCalled();
});

it("keeps direct scheduled maintenance when the optional Queue is unavailable", async () => {
	const handler = createScheduledHandler({
		resolveMediaUsageQueue: () => undefined,
	});

	await invoke(handler, "*/2 * * * *", {});

	expect(scheduled.mediaUsage).toHaveBeenCalledOnce();
	expect(scheduled.mediaUsageStep).not.toHaveBeenCalled();
});

it("logs a redacted Cron wake failure and leaves recovery to the next trigger", async () => {
	const queue = queueBinding(
		vi.fn(async () => {
			throw new Error("private binding detail");
		}),
	);
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const handler = createScheduledHandler<{ MEDIA_USAGE_QUEUE: Queue<MediaUsageWakeMessage> }>({
		resolveMediaUsageQueue: (env) => env.MEDIA_USAGE_QUEUE,
	});

	await invoke(handler, "*/2 * * * *", { MEDIA_USAGE_QUEUE: queue });

	expect(error).toHaveBeenCalledExactlyOnceWith(
		"[scheduled] Failed to queue Media Usage maintenance wake",
	);
	expect(JSON.stringify(error.mock.calls)).not.toContain("private binding detail");
	expect(scheduled.mediaUsage).not.toHaveBeenCalled();
});

it("coalesces a delivered batch into one step and one successor", async () => {
	const send = vi.fn(async () => {});
	const handler = createMediaUsageQueueHandler(() => queueBinding(send));
	scheduled.mediaUsageStep.mockResolvedValue({
		state: "progress",
		continuation: { kind: "immediate" },
		taskClass: "entry_work",
		turn: 0,
	});

	await invokeQueue(handler, [wakeMessage(), wakeMessage()], {});

	expect(scheduled.mediaUsageStep).toHaveBeenCalledOnce();
	expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1 });
});

it("lets the Queue drain when the durable database is idle", async () => {
	const send = vi.fn(async () => {});
	const handler = createMediaUsageQueueHandler(() => queueBinding(send));

	await invokeQueue(handler, [wakeMessage()], {});

	expect(scheduled.mediaUsageStep).toHaveBeenCalledOnce();
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
	expect(scheduled.mediaUsageStep).not.toHaveBeenCalled();
	expect(send).not.toHaveBeenCalled();
});

it("retries valid wakes if a delayed successor cannot be sent", async () => {
	const send = vi.fn(async () => {
		throw new Error("send failed");
	});
	const handler = createMediaUsageQueueHandler(() => queueBinding(send));
	const invalid = wakeMessage({ version: 9 });
	const valid = wakeMessage();
	scheduled.mediaUsageStep.mockResolvedValue({
		state: "blocked",
		continuation: { kind: "delayed", delaySeconds: 30 },
		taskClass: "entry_work",
		turn: 0,
	});
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
	expect(scheduled.mediaUsageStep).not.toHaveBeenCalled();
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
