import { LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import type { AdminComment } from "../src/lib/api/comments.js";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "comments",
	authMode: "passkey",
	collections: {
		posts: { label: "Posts", labelSingular: "Post", supports: [], hasSeo: false, fields: {} },
	},
	plugins: {},
	taxonomies: [],
};

const comment: AdminComment = {
	id: "comment-1",
	collection: "posts",
	contentId: "post-1",
	parentId: null,
	authorName: "Maya Chen",
	authorEmail: "maya@example.com",
	authorUserId: null,
	body: "Great write-up.",
	status: "pending",
	ipHash: null,
	userAgent: null,
	moderationMetadata: null,
	createdAt: "2026-01-02T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
};

const failure = { error: { code: "INTERNAL_ERROR", message: "Database unavailable" } };

const TestLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
	({ href, to, children, ...props }, ref) => (
		<a ref={ref} href={href ?? to} {...props}>
			{children}
		</a>
	),
);
TestLink.displayName = "TestLink";

function json(data: unknown, status = 200) {
	return Promise.resolve(
		new Response(JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

async function renderComments() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, staleTime: 60_000 },
			mutations: { retry: false },
		},
	});
	const router = createAdminRouter(queryClient);
	await router.navigate({ to: "/comments" });

	function TestApp() {
		return (
			<ThemeProvider defaultTheme="light">
				<I18nProvider i18n={i18n}>
					<Toasty>
						<QueryClientProvider client={queryClient}>
							<LinkProvider component={TestLink}>
								<RouterProvider router={router} />
							</LinkProvider>
						</QueryClientProvider>
					</Toasty>
				</I18nProvider>
			</ThemeProvider>
		);
	}

	return render(<TestApp />);
}

describe("comment deletes that fail", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		i18n.loadAndActivate({ locale: "en", messages: {} });

		globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = init?.method ?? "GET";

			if (method === "GET" && url === "/_emdash/api/manifest") {
				return json({ data: manifest });
			}
			if (method === "GET" && url === "/_emdash/api/auth/me") {
				return json({
					data: { id: "admin", email: "admin@example.com", name: "Admin", role: 50 },
				});
			}
			if (method === "GET" && url === "/_emdash/api/admin/comments/counts") {
				return json({ data: { pending: 1, approved: 0, spam: 0, trash: 0 } });
			}
			if (method === "GET" && url.startsWith("/_emdash/api/admin/comments?")) {
				return json({ data: { items: [comment] } });
			}
			if (method === "POST" && url === "/_emdash/api/admin/comments/bulk") {
				return json(failure, 500);
			}
			if (method === "DELETE" && url === `/_emdash/api/admin/comments/${comment.id}`) {
				return json(failure, 500);
			}

			throw new Error(`Unexpected request: ${method} ${url}`);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps the bulk delete dialog open with the error, and the selection", async () => {
		const screen = await renderComments();
		await screen.getByRole("checkbox", { name: "Select comment by Maya Chen" }).click();
		await screen.getByRole("button", { name: "Delete", exact: true }).click();
		const dialog = screen.getByRole("dialog", { name: "Delete Permanently?" });
		await expect.element(dialog).toBeVisible();

		// Direct DOM clicks to bypass Base UI's inert overlay
		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();

		await expect.element(dialog.getByText("Database unavailable")).toBeVisible();
		expect(screen.getByText("Failed to perform bulk action").query()).toBeNull();
		dialog.getByRole("button", { name: "Cancel" }).element().click();
		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(screen.getByText("1 selected")).toBeVisible();
	});

	it("keeps a comment's delete dialog open with the error", async () => {
		const screen = await renderComments();
		await screen.getByRole("button", { name: "Actions for comment by Maya Chen" }).click();
		await screen.getByRole("menuitem", { name: "Delete permanently" }).click();
		const dialog = screen.getByRole("dialog", { name: "Delete Comment?" });
		await expect.element(dialog).toBeVisible();

		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();

		await expect.element(dialog.getByText("Database unavailable")).toBeVisible();
	});
});
