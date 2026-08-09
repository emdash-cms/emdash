import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@flue/runtime", () => ({ init: vi.fn() }));

import { init } from "@flue/runtime";

import { classifyComment, resolveClassification } from "../../.flue/lib/classifier-client.js";
import { classifierCommands } from "../../.flue/lib/router.js";

const commands = classifierCommands("working");
const mockedInit = vi.mocked(init);

function mockHandle(handle: {
	dispatch: (input: unknown) => Promise<unknown>;
	read: (receipt: unknown, options?: unknown) => Promise<unknown>;
}) {
	mockedInit.mockReturnValue(handle as unknown as ReturnType<typeof init>);
}

const input = { issueNumber: 42, state: "working" as const, comment: "@emdashbot retry" };

describe("classifyComment", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetAllMocks();
		vi.useRealTimers();
	});

	test("returns no-commands without dispatching when the state offers none", async () => {
		expect(await classifyComment({ ...input, state: null })).toEqual({ kind: "no-commands" });
		expect(mockedInit).not.toHaveBeenCalled();
	});

	test("dispatches and resolves the last classification write", async () => {
		const event = commands[0];
		expect(event).toBeDefined();
		if (!event) return;
		const dispatched: unknown[] = [];
		mockHandle({
			dispatch: async (dispatchInput) => {
				dispatched.push(dispatchInput);
				return { id: "receipt" };
			},
			read: async () => ({
				data: {
					classification: [
						{ event: "none", arg: null, reasoning: "first pass was undecided" },
						{ event: event.event, arg: "try SQLite", reasoning: "the comment asks for a retry" },
					],
				},
			}),
		});

		expect(await classifyComment(input)).toEqual({
			kind: "event",
			event: event.event,
			arg: "try SQLite",
			reasoning: "the comment asks for a retry",
		});
		expect(dispatched).toHaveLength(1);
	});

	test("returns an error when dispatch admission stalls past the budget", async () => {
		vi.useFakeTimers();
		mockHandle({
			dispatch: () => new Promise(() => {}),
			read: async () => ({ data: { classification: [] } }),
		});

		const pending = classifyComment(input);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(await pending).toEqual({
			kind: "error",
			error: "Classifier dispatch timed out after 10000ms",
		});
	});

	test("fails deterministically when dispatch consumes the whole budget", async () => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		let read = 0;
		mockHandle({
			dispatch: async () => {
				now = 10_000;
				return { id: "receipt" };
			},
			read: async () => {
				read += 1;
				return { data: { classification: [] } };
			},
		});

		expect(await classifyComment(input)).toEqual({
			kind: "error",
			error: "Classifier read timed out after 10000ms",
		});
		expect(read).toBe(0);
	});

	test("maps a rejected read to an error result", async () => {
		mockHandle({
			dispatch: async () => ({ id: "receipt" }),
			read: async () => {
				throw new Error("durable response lost");
			},
		});

		expect(await classifyComment(input)).toEqual({
			kind: "error",
			error: "durable response lost",
		});
	});
});

describe("resolveClassification", () => {
	test("rejects a missing structured result", () => {
		expect(resolveClassification(undefined, commands)).toEqual({
			kind: "error",
			error: "classifier returned no structured result",
		});
	});

	test("maps none without guessing an event", () => {
		expect(
			resolveClassification(
				{ event: "none", arg: null, reasoning: "The comment only asks a question" },
				commands,
			),
		).toEqual({ kind: "none", reasoning: "The comment only asks a question" });
	});

	test("rejects events outside the available command set", () => {
		expect(
			resolveClassification(
				{ event: "confirm", arg: null, reasoning: "The comment says confirm" },
				commands,
			),
		).toEqual({ kind: "error", error: 'classifier returned unknown event "confirm"' });
	});

	test("maps a known event and directive", () => {
		const event = commands[0];
		expect(event).toBeDefined();
		if (!event) return;
		expect(
			resolveClassification(
				{
					event: event.event,
					arg: "try SQLite",
					reasoning: "The comment asks for another attempt",
				},
				commands,
			),
		).toEqual({
			kind: "event",
			event: event.event,
			arg: "try SQLite",
			reasoning: "The comment asks for another attempt",
		});
	});
});
