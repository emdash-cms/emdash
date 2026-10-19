import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	addRole,
	editInteractionResponse,
	getRoleState,
	interactionResponse,
	postMessage,
	removeRole,
} from "../src/discord.js";

const testEnv = env as Env;

beforeEach(() => {
	testEnv.DISCORD_APP_ID = "test-application";
	testEnv.DISCORD_GUILD_ID = "test-guild";
	testEnv.DISCORD_BOT_TOKEN = "test-bot-token";
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Discord request timeouts", () => {
	test.each([
		["member lookup", () => getRoleState(testEnv, "member", "contributor")],
		["role grant", () => addRole(testEnv, "member", "contributor")],
		["role removal", () => removeRole(testEnv, "member", "contributor")],
		["channel message", () => postMessage(testEnv, "channel", "Welcome")],
		[
			"interaction response",
			() => editInteractionResponse(testEnv, "token", interactionResponse("Completed", true)),
		],
	] as const)("aborts a stalled %s without retrying it", async (_name, request) => {
		let requestSignal: AbortSignal | undefined;
		const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
					once: true,
				});
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const completed = expect(request()).rejects.toMatchObject({ name: "TimeoutError" });
		await vi.advanceTimersByTimeAsync(5_000);
		await completed;

		expect(requestSignal?.aborted).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("aborts a stalled member response body after receiving headers", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
				requestSignal = init?.signal ?? undefined;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"roles":['));
						requestSignal?.addEventListener(
							"abort",
							() => controller.error(requestSignal?.reason),
							{
								once: true,
							},
						);
					},
				});
				return new Response(body, { headers: { "Content-Type": "application/json" } });
			}),
		);

		const completed = expect(getRoleState(testEnv, "member", "contributor")).rejects.toMatchObject({
			name: "TimeoutError",
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await completed;

		expect(requestSignal?.aborted).toBe(true);
	});

	test("clears the deadline after reading a successful member response", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ roles: ["contributor"] });
			}),
		);

		expect(await getRoleState(testEnv, "member", "contributor")).toBe("present");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(requestSignal?.aborted).toBe(false);
	});

	test("preserves Discord rejection handling and clears the deadline", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
				requestSignal = init?.signal ?? undefined;
				return new Response(null, { status: 503 });
			}),
		);

		await expect(getRoleState(testEnv, "member", "contributor")).rejects.toThrow(
			"Discord member lookup failed with status 503",
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(requestSignal?.aborted).toBe(false);
	});
});
