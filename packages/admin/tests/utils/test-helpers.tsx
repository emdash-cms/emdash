/**
 * Shared test utilities for admin component tests.
 *
 * Provides wrapper components, mock factories, and helpers
 * for vitest browser mode with React.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

import { ThemeProvider } from "../../src/components/ThemeProvider";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHOD_PREFIX_REGEX = /^(GET|POST|PUT|DELETE|PATCH|ANY) /;

/**
 * Create a fresh QueryClient configured for testing.
 * Disables retries and gcTime for deterministic tests.
 */
export function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				gcTime: 0,
			},
			mutations: {
				retry: false,
			},
		},
	});
}

/**
 * Wrapper that provides QueryClient + ThemeProvider.
 * Use with `render(<Comp />, { wrapper: TestWrapper })`.
 */
export function TestWrapper({ children }: { children: React.ReactNode }) {
	const queryClient = React.useMemo(() => createTestQueryClient(), []);
	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider defaultTheme="light">{children}</ThemeProvider>
		</QueryClientProvider>
	);
}

/**
 * Wrapper that provides just QueryClient (no theme).
 */
export function QueryWrapper({ children }: { children: React.ReactNode }) {
	const queryClient = React.useMemo(() => createTestQueryClient(), []);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/**
 * Mock fetch interceptor for testing API calls.
 *
 * Usage:
 *   const mockFetch = createMockFetch();
 *   mockFetch.on("GET", "/_emdash/api/manifest", { version: "1.0" });
 *   // ... render component that fetches manifest ...
 *   mockFetch.restore();
 */
export function createMockFetch() {
	const originalFetch = globalThis.fetch;
	const handlers = new Map<string, { status: number; body: unknown }>();

	function mockFetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = init?.method ?? "GET";
		const key = `${method.toUpperCase()} ${url}`;

		// Check for exact match first
		let handler = handlers.get(key);

		// Then check for URL-only match (any method)
		if (!handler) {
			handler = handlers.get(`ANY ${url}`);
		}

		// Check for prefix matches
		if (!handler) {
			for (const [pattern, h] of handlers) {
				const patternUrl = pattern.replace(HTTP_METHOD_PREFIX_REGEX, "");
				if (url.startsWith(patternUrl)) {
					handler = h;
					break;
				}
			}
		}

		if (handler) {
			return Promise.resolve(
				new Response(JSON.stringify(handler.body), {
					status: handler.status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}

		// Fall through to real fetch for unmatched
		return originalFetch(input, init);
	}

	globalThis.fetch = mockFetchFn as typeof fetch;

	return {
		on(method: string, url: string, body: unknown, status = 200) {
			handlers.set(`${method.toUpperCase()} ${url}`, { status, body });
			return this;
		},
		restore() {
			globalThis.fetch = originalFetch;
		},
		clear() {
			handlers.clear();
		},
	};
}

/**
 * Wait for a condition to be true, with retry.
 */
export async function waitFor(fn: () => boolean | void, timeout = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const result = fn();
			if (result !== false) return;
		} catch {
			// retry
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	// Final attempt that throws
	fn();
}
