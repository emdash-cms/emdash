/**
 * Reproduces #1046: Bearer-token API clients don't get D1 read-your-writes.
 *
 * The D1 session adapter receives `isAuthenticated` from the core middleware
 * (which derives it from the astro-session cookie only). Bearer-token (PAT)
 * authenticated requests therefore flow through `createRequestScopedDb` with
 * `isAuthenticated: false`, so:
 *   - reads use `first-unconstrained` (any replica),
 *   - and `commit()` early-returns without persisting the bookmark cookie.
 *
 * That means an authenticated API client can write to primary, get a 200,
 * and a subsequent read may still hit a lagging replica.
 *
 * This test is a focused unit repro of the adapter's behaviour: it shows
 * that when `isAuthenticated: false`, the constraint is `first-unconstrained`
 * and `commit()` is a no-op. A fix should make Bearer-authenticated requests
 * pass `isAuthenticated: true` (or the adapter should grow an `isApiAuthenticated`
 * sibling flag) so the post-write read can resume from the bookmark.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the cloudflare:workers env binding before importing the adapter.
const fakeBinding = {
	withSession: vi.fn(),
};

vi.mock("cloudflare:workers", () => ({
	env: { DB: fakeBinding },
}));

// Import after mocking so the module picks up our fake env.
const { createRequestScopedDb } = await import("../../src/db/d1.js");

interface MockCookieJar {
	get(name: string): { value: string } | undefined;
	set(name: string, value: string, options?: Record<string, unknown>): void;
	_store: Map<string, string>;
}

function makeCookies(initial: Record<string, string> = {}): MockCookieJar {
	const store = new Map(Object.entries(initial));
	return {
		_store: store,
		get(name: string) {
			const v = store.get(name);
			return v === undefined ? undefined : { value: v };
		},
		set: vi.fn((name: string, value: string, _options?: Record<string, unknown>) => {
			store.set(name, value);
		}) as MockCookieJar["set"],
	};
}

function makeSessionStub(bookmark: string | null) {
	return {
		prepare: vi.fn(),
		batch: vi.fn(),
		getBookmark: vi.fn(() => bookmark),
	};
}

describe("createRequestScopedDb — Bearer-token routing (#1046)", () => {
	beforeEach(() => {
		fakeBinding.withSession.mockReset();
	});

	it("reproduces #1046: a Bearer-authenticated request looks anonymous to the adapter", () => {
		// Simulate the middleware callsite for a Bearer-authenticated GET:
		// the auth chain has already validated a PAT and set locals.user, but
		// the runtime middleware derives isAuthenticated from the astro-session
		// cookie, which is absent — so it passes isAuthenticated: false.
		const sessionStub = makeSessionStub("bm-after-read");
		fakeBinding.withSession.mockReturnValue(sessionStub);
		const cookies = makeCookies({
			__em_d1_bookmark: "bm-from-previous-write",
		});

		const scoped = createRequestScopedDb({
			config: { binding: "DB", session: "auto" },
			// THIS is the bug surface: a PAT-authenticated GET arrives here with
			// isAuthenticated: false because sessionUser is null.
			isAuthenticated: false,
			isWrite: false,
			cookies,
			url: new URL("https://example.com/_emdash/api/content/posts"),
		});

		expect(scoped).not.toBeNull();

		// Symptom 1: the adapter ignored the saved bookmark and routed the read
		// to "first-unconstrained" instead of resuming from the prior write.
		expect(fakeBinding.withSession).toHaveBeenCalledTimes(1);
		expect(fakeBinding.withSession).toHaveBeenCalledWith("first-unconstrained");

		// Symptom 2: commit() refuses to persist the new bookmark, so the next
		// request can't resume either.
		scoped!.commit();
		expect(cookies.set).not.toHaveBeenCalled();

		// What we WANT (and what this test should assert once the fix lands):
		// a Bearer-authenticated request should be treated like an authenticated
		// session request — read from the saved bookmark and persist the new one.
		//
		// Uncomment after fix:
		// expect(fakeBinding.withSession).toHaveBeenCalledWith("bm-from-previous-write");
		// expect(cookies.set).toHaveBeenCalledWith(
		//     "__em_d1_bookmark",
		//     "bm-after-read",
		//     expect.objectContaining({ httpOnly: true }),
		// );
	});

	it("baseline: cookie-session-authenticated request DOES resume + persist bookmarks", () => {
		// Sanity check: with isAuthenticated: true the adapter already behaves.
		// This is what Bearer-authenticated requests should also get.
		const sessionStub = makeSessionStub("bm-after-read");
		fakeBinding.withSession.mockReturnValue(sessionStub);
		const cookies = makeCookies({
			__em_d1_bookmark: "bm-from-previous-write",
		});

		const scoped = createRequestScopedDb({
			config: { binding: "DB", session: "auto" },
			isAuthenticated: true,
			isWrite: false,
			cookies,
			url: new URL("https://example.com/_emdash/api/content/posts"),
		});

		expect(fakeBinding.withSession).toHaveBeenCalledWith("bm-from-previous-write");
		scoped!.commit();
		expect(cookies.set).toHaveBeenCalledWith(
			"__em_d1_bookmark",
			"bm-after-read",
			expect.objectContaining({ httpOnly: true }),
		);
	});

	it("regression: Bearer-authenticated reads resume from bookmark when isAuthenticated is true", () => {
		// Once the middleware fix lands, Bearer-authenticated requests arrive
		// at the adapter with isAuthenticated: true. This test locks in the
		// expected adapter behaviour for that path.
		const sessionStub = makeSessionStub("bm-after-read");
		fakeBinding.withSession.mockReturnValue(sessionStub);
		const cookies = makeCookies({
			__em_d1_bookmark: "bm-from-previous-write",
		});

		const scoped = createRequestScopedDb({
			config: { binding: "DB", session: "auto" },
			isAuthenticated: true,
			isWrite: false,
			cookies,
			url: new URL("https://example.com/_emdash/api/content/posts"),
		});

		expect(fakeBinding.withSession).toHaveBeenCalledWith("bm-from-previous-write");
		scoped!.commit();
		expect(cookies.set).toHaveBeenCalledWith(
			"__em_d1_bookmark",
			"bm-after-read",
			expect.objectContaining({ httpOnly: true }),
		);
	});
});
