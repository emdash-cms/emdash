import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "../../src/components/ThemeProvider";
import type { AdminManifest } from "../../src/lib/api";
import { createAdminRouter } from "../../src/router";
import { render } from "../utils/render.tsx";
import { createMockFetch, createTestQueryClient } from "../utils/test-helpers";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "not-found-route",
	authMode: "passkey",
	collections: {
		posts: { label: "Posts", labelSingular: "Post", supports: [], hasSeo: false, fields: {} },
	},
	plugins: {},
	taxonomies: [],
};

async function openAdminUrl(path: string) {
	window.history.replaceState(null, "", `/_emdash/admin${path}`);
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	return render(
		<I18nProvider i18n={i18n}>
			<ThemeProvider defaultTheme="light">
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</ThemeProvider>
		</I18nProvider>,
	);
}

describe("unknown admin URLs", () => {
	const originalUrl = window.location.href;
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } });
	});

	afterEach(() => {
		mockFetch.restore();
		window.history.replaceState(null, "", originalUrl);
	});

	it.each(["/does-not-exist", "/settings/nope"])(
		"shows the not-found page inside the admin shell at %s",
		async (path) => {
			const screen = await openAdminUrl(path);

			await expect.element(screen.getByRole("heading", { name: "Page Not Found" })).toBeVisible();
			await expect.element(screen.getByRole("link", { name: "Go to Dashboard" })).toBeVisible();
			await expect.element(screen.getByRole("link", { name: "Settings" })).toBeVisible();
		},
	);
});
