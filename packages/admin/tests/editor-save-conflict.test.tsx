import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { userEvent } from "@vitest/browser/context";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "rev-lockout",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: false,
			fields: {
				title: { kind: "string", label: "Title" },
				link: { kind: "url", label: "Link" },
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
		publishedAt: "2026-01-01T00:00:00Z",
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

function createMockServer(
	onPut: (request: RecordedRequest, index: number) => Response,
	options: { failReadsAfterConflict?: boolean } = {},
) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let putCount = 0;
	// Moves on with the conflict, so a client that refetches is distinguishable.
	let currentRevision = "rev-initial";

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const request = { method, url, body };
		requests.push(request);

		if (method === "GET" && url === "/_emdash/api/manifest")
			return jsonResponse({ data: MANIFEST });
		if (method === "GET" && url === "/_emdash/api/auth/me")
			return jsonResponse({ data: { id: "user_1", role: 40 } });
		if (method === "GET" && url.startsWith("/_emdash/api/bylines"))
			return jsonResponse({ data: { items: [] } });
		if (method === "GET" && url.startsWith("/_emdash/api/users"))
			return jsonResponse({ data: { items: [] } });
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			if (options.failReadsAfterConflict && putCount > 0)
				return jsonResponse({ error: { code: "INTERNAL", message: "Read failed" } }, 500);
			return contentResponse(makeItem({ _rev: currentRevision }));
		}
		if (method === "POST" && url.includes("/discard-draft"))
			return contentResponse(makeItem({ _rev: currentRevision, draftRevisionId: "revision-live" }));
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
			const response = onPut(request, putCount++);
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
	await expect.element(screen.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
	return screen;
}

describe("ContentEditPage save conflict", () => {
	let server: ReturnType<typeof createMockServer> | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		server?.restore();
		server = undefined;
		vi.useRealTimers();
	});

	function conflictOnFirstPut(options: { failReadsAfterConflict?: boolean } = {}) {
		return createMockServer((_request, index) => {
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
		}, options);
	}

	it("stops autosaving until the writer decides", async () => {
		server = conflictOnFirstPut();
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("First edit");
		await vi.advanceTimersByTimeAsync(2500);

		await title.fill("Second edit");
		await vi.advanceTimersByTimeAsync(10000);

		const puts = server.requests.filter((request) => request.method === "PUT");
		expect(puts).toHaveLength(1);
	});

	it("keeps what the writer typed and offers to save it anyway", async () => {
		server = conflictOnFirstPut();
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Writer copy");
		await vi.advanceTimersByTimeAsync(2500);

		await expect
			.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
			.toBeVisible();
		await expect.element(title).toHaveValue("Writer copy");

		await screen.getByRole("button", { name: "Save anyway", exact: true }).click();
		await vi.advanceTimersByTimeAsync(0);

		const puts = server.requests.filter((request) => request.method === "PUT");
		expect(puts.at(-1)?.body).toMatchObject({
			data: { title: "Writer copy" },
			_rev: "rev-moved",
		});
	});

	it("reports the failure when it cannot read the newer version", async () => {
		server = conflictOnFirstPut({ failReadsAfterConflict: true });
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Writer copy");
		await vi.advanceTimersByTimeAsync(2500);

		await expect.element(screen.getByText("Autosave failed")).toBeVisible();
		expect(screen.getByRole("button", { name: "Save anyway", exact: true }).query()).toBeNull();
	});

	it("keeps the notice when the save it offers cannot start", async () => {
		server = conflictOnFirstPut();
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Writer copy");
		await vi.advanceTimersByTimeAsync(2500);

		const saveAnyway = screen.getByRole("button", { name: "Save anyway", exact: true });
		await expect.element(saveAnyway).toBeVisible();

		// An invalid URL makes submitSave return before it reaches onSave.
		await screen.getByRole("textbox", { name: "Link" }).fill("not a url");
		await saveAnyway.click();
		await vi.advanceTimersByTimeAsync(10000);

		await expect.element(saveAnyway).toBeVisible();
		const puts = server.requests.filter((request) => request.method === "PUT");
		expect(puts).toHaveLength(1);
	});

	it("takes the notice down when the writer discards instead", async () => {
		// Real timers: the dialog only settles for a click once its transition runs.
		vi.useRealTimers();
		server = conflictOnFirstPut();
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Writer copy");

		await expect
			.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
			.toBeVisible();

		const trigger = screen.getByRole("button", { name: "Discard changes", exact: true });
		trigger.element().focus();
		await userEvent.keyboard("{Enter}");

		const dialog = screen.getByRole("dialog");
		await expect.element(dialog).toBeVisible();
		const confirm = dialog.getByRole("button", { name: "Discard changes", exact: true });
		confirm.element().focus();
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() =>
			expect(
				server?.requests.filter((request) => request.url.includes("discard-draft")),
			).toHaveLength(1),
		);
		// By text, not role: the open dialog marks the content behind it aria-hidden.
		await vi.waitFor(() => expect(document.body.textContent).not.toContain("Save anyway"));
	});
});
