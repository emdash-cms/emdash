import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMagicLink } from "./magic-link/index.js";
import { requestSignup } from "./signup.js";
import type { AuthAdapter, User } from "./types.js";

const existingUser = { id: "user_1", email: "author@example.com" } as User;

function stubAdapter(user: User | null): AuthAdapter {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- only the lookups these paths call
	return {
		getUserByEmail: vi.fn(async () => user),
		getAllowedDomain: vi.fn(async () => null),
	} as unknown as AuthAdapter;
}

const config = { baseUrl: "https://example.com", siteName: "Example", email: vi.fn() };

const unsentCalls: [string, (options: { delayWhenUnsent?: boolean }) => Promise<void>][] = [
	[
		"sendMagicLink for an unknown email",
		(options) => sendMagicLink({ ...config, ...options }, stubAdapter(null), "nobody@example.com"),
	],
	[
		"requestSignup for an existing user",
		(options) =>
			requestSignup({ ...config, ...options }, stubAdapter(existingUser), "author@example.com"),
	],
	[
		"requestSignup for a domain that is not allowed",
		(options) => requestSignup({ ...config, ...options }, stubAdapter(null), "a@other.example"),
	],
];

describe("delayWhenUnsent", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function isSettled(promise: Promise<void>): Promise<boolean> {
		let settled = false;
		void promise.finally(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		return settled;
	}

	it.each(unsentCalls)("%s waits at least 100 ms by default", async (_label, call) => {
		const pending = call({});

		await vi.advanceTimersByTimeAsync(99);
		expect(await isSettled(pending)).toBe(false);

		await vi.advanceTimersByTimeAsync(151);
		expect(await isSettled(pending)).toBe(true);
		expect(config.email).not.toHaveBeenCalled();
	});

	it.each(unsentCalls)("%s resolves without waiting when turned off", async (_label, call) => {
		expect(await isSettled(call({ delayWhenUnsent: false }))).toBe(true);
		expect(config.email).not.toHaveBeenCalled();
	});
});
