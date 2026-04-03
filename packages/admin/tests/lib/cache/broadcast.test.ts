/**
 * Tests for the BroadcastChannel multi-tab coordination.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import {
	broadcastInvalidation,
	closeBroadcastChannel,
	listenForInvalidations,
} from "../../../src/lib/cache/broadcast.js";

describe("broadcast", () => {
	afterEach(() => {
		closeBroadcastChannel();
	});

	describe("broadcastInvalidation", () => {
		it("does not throw when called", () => {
			// BroadcastChannel sends to *other* contexts, so we can't easily
			// receive in the same context. Just verify it doesn't throw.
			expect(() => {
				broadcastInvalidation([["content"], ["media"]]);
			}).not.toThrow();
		});

		it("handles empty query keys", () => {
			expect(() => {
				broadcastInvalidation([]);
			}).not.toThrow();
		});
	});

	describe("listenForInvalidations", () => {
		it("returns a cleanup function", () => {
			const mockQueryClient = {
				invalidateQueries: vi.fn(),
			};

			const cleanup = listenForInvalidations(mockQueryClient as never);
			expect(typeof cleanup).toBe("function");

			// Cleanup should not throw
			cleanup();
		});
	});

	describe("closeBroadcastChannel", () => {
		it("does not throw when called without an open channel", () => {
			expect(() => {
				closeBroadcastChannel();
			}).not.toThrow();
		});

		it("does not throw when called after broadcastInvalidation", () => {
			broadcastInvalidation([["test"]]);
			expect(() => {
				closeBroadcastChannel();
			}).not.toThrow();
		});

		it("can be called multiple times safely", () => {
			broadcastInvalidation([["test"]]);
			closeBroadcastChannel();
			closeBroadcastChannel(); // second call should be safe
		});
	});
});
