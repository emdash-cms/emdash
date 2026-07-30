import { Toasty } from "@cloudflare/kumo";
/**
 * MediaPage must surface a failed upload as a failure.
 *
 * `MediaLibrary.handleFileSelect` awaits the `onUpload` prop and decides between
 * the success and error banner by counting rejections:
 *
 *     try { await onUpload?.(file); uploaded++ }
 *     catch { failed++ }
 *     ...
 *     if (failed === 0) setUploadState({ status: "success", ... })
 *
 * MediaPage used to pass `uploadMutation.mutate`, which is fire-and-forget — it
 * returns `undefined` and never rejects. So `failed` stayed 0 no matter what the
 * API said, and a rejected upload rendered the green "File uploaded" banner
 * while nothing was added to the list, with the API's reason discarded. Passing
 * `mutateAsync` propagates the real error to that catch.
 *
 * The assertion is on the prop contract rather than the rendered banner: the
 * banner is MediaLibrary's behaviour (and is already correct), whereas the bug
 * was purely in how MediaPage wired the handler.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createMockFetch, createTestQueryClient } from "./utils/test-helpers";

const uploadMedia = vi.fn();

vi.mock("../src/lib/api", async () => {
	const actual = await vi.importActual("../src/lib/api");
	return {
		...actual,
		fetchMediaList: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
		uploadMedia: (file: File) => uploadMedia(file) as Promise<unknown>,
	};
});

/** Capture the props MediaPage hands to MediaLibrary. */
let capturedOnUpload: ((file: File) => Promise<void> | void) | undefined;

vi.mock("../src/components/MediaLibrary", () => ({
	MediaLibrary: (props: { onUpload?: (file: File) => Promise<void> | void }) => {
		capturedOnUpload = props.onUpload;
		return <div data-testid="media-library" />;
	},
}));

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function buildRouter() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) {
		i18n.loadAndActivate({ locale: "en", messages: {} });
	}
	function TestApp() {
		return (
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>
		);
	}
	return { router, TestApp };
}

async function renderMediaPage() {
	capturedOnUpload = undefined;
	const { router, TestApp } = buildRouter();
	await router.navigate({ to: "/media" });
	const screen = await render(<TestApp />);
	await expect.element(screen.getByTestId("media-library")).toBeInTheDocument();
	return capturedOnUpload;
}

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
	i18n: { defaultLocale: "en", locales: ["en"] },
};

describe("MediaPage upload failure reporting", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		uploadMedia.mockReset();
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 60 } });
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("rejects when the upload fails, so MediaLibrary can show the error", async () => {
		uploadMedia.mockRejectedValue(new Error("File type not allowed"));

		const onUpload = await renderMediaPage();
		expect(onUpload).toBeDefined();

		// mutate() would resolve to undefined here and the failure would be
		// silently scored as a success.
		await expect(
			Promise.resolve(onUpload?.(new File(["x"], "notes.txt", { type: "text/plain" }))),
		).rejects.toThrow("File type not allowed");
	});

	it("resolves when the upload succeeds", async () => {
		uploadMedia.mockResolvedValue({
			id: "m1",
			filename: "photo.png",
			mimeType: "image/png",
			url: "/_emdash/api/media/file/m1.png",
			size: 10,
			createdAt: "2026-01-01",
		});

		const onUpload = await renderMediaPage();
		expect(onUpload).toBeDefined();

		// Companion check on the happy path -- the regression guard is the test
		// above. The handler resolves to void, so the assertion is only that it
		// settles without rejecting and that the upload was actually attempted.
		await expect(
			Promise.resolve(onUpload?.(new File(["x"], "photo.png", { type: "image/png" }))),
		).resolves.toBeUndefined();
		expect(uploadMedia).toHaveBeenCalledOnce();
	});
});
