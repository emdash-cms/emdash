import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "published-at-rev",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: false,
			fields: {
				title: { kind: "string", label: "Title" },
			},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

type RevisionedContentItem = ContentItem & { _rev: string };

function makeItem(overrides: Partial<RevisionedContentItem> = {}): RevisionedContentItem {
	return {
		id: "post_1",
		type: "posts",
		slug: "post-one",
		status: "published",
		locale: "en",
		translationGroup: null,
		data: { title: "Draft title" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		publishedAt: "2026-01-01T12:00:00Z",
		scheduledAt: null,
		liveRevisionId: "revision-live",
		draftRevisionId: "revision-draft",
		_rev: "rev-initial",
		...overrides,
	};
}

interface RecordedRequest {
	method: string;
	url: string;
	body: Record<string, unknown> | undefined;
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function contentResponse(item: RevisionedContentItem) {
	const { _rev, ...contentItem } = item;
	return jsonResponse({ data: { item: contentItem, _rev } });
}

function createMockServer(onPut: (request: RecordedRequest, index: number) => Response) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let putCount = 0;
	// Moves on with the conflict, so a client that refetches is distinguishable.
	let currentRevision = "rev-initial";

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ method, url, body });

		if (method === "GET" && url === "/_emdash/api/manifest")
			return jsonResponse({ data: MANIFEST });
		if (method === "GET" && url === "/_emdash/api/auth/me")
			return jsonResponse({ data: { id: "user_1", role: 40 } });
		if (method === "GET" && url.startsWith("/_emdash/api/bylines"))
			return jsonResponse({ data: { items: [] } });
		if (method === "GET" && url.startsWith("/_emdash/api/users"))
			return jsonResponse({ data: { items: [] } });
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1"))
			return contentResponse(makeItem({ _rev: currentRevision }));
		if (method === "GET" && url === "/_emdash/api/revisions/revision-draft")
			return jsonResponse({
				data: {
					item: {
						id: "revision-draft",
						collection: "posts",
						entryId: "post_1",
						data: { title: "Draft title" },
						authorId: null,
						createdAt: "2026-01-02T00:00:00Z",
					},
				},
			});
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			const response = onPut({ method, url, body }, putCount++);
			if (response.status === 409) currentRevision = "rev-moved";
			return response;
		}

		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;

	return {
		requests,
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

async function renderEditPage() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });

	function TestApp() {
		return (
			<I18nProvider i18n={i18n}>
				<ThemeProvider defaultTheme="light">
					<Toasty>
						<QueryClientProvider client={queryClient}>
							<RouterProvider router={router} />
						</QueryClientProvider>
					</Toasty>
				</ThemeProvider>
			</I18nProvider>
		);
	}

	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(<TestApp />);
	await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeVisible();
	return screen;
}

// Only the minute moves, keeping the local date and the 12-hour period out of it.
async function changePublicationMinute(
	screen: Awaited<ReturnType<typeof renderEditPage>>,
	minute: string,
) {
	await screen.getByRole("button", { name: /^Change publication date:/ }).click();
	const dialog = screen.getByRole("dialog");
	await expect.element(dialog).toBeVisible();
	await dialog.getByRole("textbox", { name: "Minute" }).fill(minute);
	await submitPublicationDate(screen);
}

// The dialog's overlay intercepts pointer events until its transition settles.
async function submitPublicationDate(screen: Awaited<ReturnType<typeof renderEditPage>>) {
	const save = screen.getByRole("dialog").getByRole("button", { name: "Save date", exact: true });
	save.element().focus();
	await userEvent.keyboard("{Enter}");
}

describe("ContentEditPage publication date", () => {
	let server: ReturnType<typeof createMockServer> | undefined;

	afterEach(() => {
		server?.restore();
		server = undefined;
	});

	it("sends the revision token with the new date", async () => {
		server = createMockServer(() => contentResponse(makeItem({ _rev: "rev-save-2" })));
		const screen = await renderEditPage();

		await changePublicationMinute(screen, "30");

		await vi.waitFor(() => {
			const put = server?.requests.find((request) => request.method === "PUT");
			expect(put?.body).toMatchObject({ _rev: "rev-initial" });
			expect(put?.body).toHaveProperty("publishedAt");
		});
	});

	it("recovers the newer token when the date write conflicts", async () => {
		server = createMockServer((_request, index) => {
			if (index === 0)
				return jsonResponse(
					{
						error: {
							code: "CONFLICT",
							message: "Content has been modified since last read (version conflict)",
						},
					},
					409,
				);
			return contentResponse(makeItem({ _rev: "rev-save-2" }));
		});
		const screen = await renderEditPage();

		await changePublicationMinute(screen, "30");
		// The refused write leaves the dialog open, and its message settles only after recovery.
		await expect.element(screen.getByText(/version conflict/)).toBeVisible();
		await submitPublicationDate(screen);

		await vi.waitFor(() => {
			const puts = server?.requests.filter((request) => request.method === "PUT");
			expect(puts).toHaveLength(2);
			expect(puts?.at(-1)?.body).toMatchObject({ _rev: "rev-moved" });
		});
	});
});
