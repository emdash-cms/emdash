import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { postMessageWithNonce } from "../src/discord.js";

const testEnv = env as Env;
const channelId = "123456789";
const discordId = "987654321";
const nonce = "welcome-attempt-123";
const content = `Welcome <@${discordId}>!`;

beforeEach(() => {
	testEnv.DISCORD_BOT_TOKEN = "test-bot-token";
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function sendWelcome(timeoutMs = 5_000) {
	return postMessageWithNonce(testEnv, channelId, content, [discordId], nonce, timeoutMs);
}

describe("welcome message delivery", () => {
	test("preserves the nonce and mention policy when confirming a retried message", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("Response lost"))
			.mockResolvedValueOnce(Response.json({ id: "111222333" }));
		vi.stubGlobal("fetch", fetchMock);

		expect(await sendWelcome()).toEqual({ status: "retry", retryAfterMs: 250 });
		expect(await sendWelcome()).toEqual({ status: "sent", messageId: "111222333" });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [url, init] of fetchMock.mock.calls) {
			expect(url).toBe(`https://discord.com/api/v10/channels/${channelId}/messages`);
			expect(init?.method).toBe("POST");
			expect(typeof init?.body).toBe("string");
			expect(JSON.parse(init?.body as string)).toEqual({
				content,
				allowed_mentions: { parse: [], users: [discordId] },
				nonce,
				enforce_nonce: true,
			});
		}
	});

	test.each([
		["header", () => new Response(null, { status: 429, headers: { "Retry-After": "0.125" } }), 125],
		["body", () => Response.json({ retry_after: 0.125 }, { status: 429 }), 125],
		["fractional millisecond", () => Response.json({ retry_after: 0.1251 }, { status: 429 }), 126],
	] as const)(
		"preserves a fractional rate-limit delay from the %s",
		async (_name, response, delay) => {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
			vi.stubGlobal("fetch", fetchMock);

			expect(await sendWelcome()).toEqual({ status: "retry", retryAfterMs: delay });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	test.each([
		["malformed body", () => new Response("{", { status: 429 })],
		["missing delay", () => Response.json({}, { status: 429 })],
		["negative delay", () => Response.json({ retry_after: -1 }, { status: 429 })],
		[
			"invalid header",
			() => new Response(null, { status: 429, headers: { "Retry-After": "later" } }),
		],
		["empty header", () => new Response(null, { status: 429, headers: { "Retry-After": "" } })],
	] as const)("does not invent a retry delay for a rate limit with %s", async (_name, response) => {
		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response()));

		expect(await sendWelcome()).toEqual({ status: "rejected" });
	});

	test.each([400, 401, 403])("does not retry a rejected message with HTTP %s", async (status) => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
		vi.stubGlobal("fetch", fetchMock);

		expect(await sendWelcome()).toEqual({ status: "rejected" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test.each([
		["malformed JSON", () => new Response("{")],
		["missing message ID", () => Response.json({})],
		["invalid message ID", () => Response.json({ id: 123 })],
		["server error", () => new Response(null, { status: 503 })],
	] as const)("keeps a %s outcome unconfirmed", async (_name, response) => {
		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response()));

		expect(await sendWelcome()).toEqual({ status: "retry", retryAfterMs: 250 });
	});

	test.each(["headers", "body"] as const)(
		"aborts stalled response %s within the remaining budget",
		async (stage) => {
			vi.useFakeTimers();
			let signal: AbortSignal | undefined;
			const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
				signal = init?.signal ?? undefined;
				if (stage === "headers") {
					return new Promise<Response>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
					});
				}
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"id":'));
						signal?.addEventListener("abort", () => controller.error(signal?.reason), {
							once: true,
						});
					},
				});
				return Promise.resolve(new Response(body));
			});
			vi.stubGlobal("fetch", fetchMock);

			const completed = sendWelcome(100);
			await vi.advanceTimersByTimeAsync(99);
			expect(signal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);

			expect(await completed).toEqual({ status: "retry", retryAfterMs: 250 });
			expect(signal?.aborted).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);
});
