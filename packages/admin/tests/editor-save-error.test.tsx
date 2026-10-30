import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../dist/styles.css";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "save-error",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts"],
			hasSeo: false,
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

function item(id: string): ContentItem {
	return {
		id,
		type: "posts",
		slug: id,
		status: "draft",
		locale: "en",
		translationGroup: null,
		data: { title: "Initial title" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: `revision-${id}`,
	};
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function createMockServer(
	putResponses: number[],
	authorResponses: number[] = [],
	pendingSave?: Promise<void>,
	withRevisions = false,
) {
	const originalFetch = globalThis.fetch;
	let putIndex = 0;
	let authorIndex = 0;
	let authorId: string | null = null;
	const savedData = new Map<string, Record<string, unknown>>();
	const writes: Record<string, unknown>[] = [];
	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		if (method === "GET" && url === "/_emdash/api/manifest")
			return jsonResponse({
				data: withRevisions
					? {
							...MANIFEST,
							collections: {
								posts: { ...MANIFEST.collections.posts, supports: ["drafts", "revisions"] },
							},
						}
					: MANIFEST,
			});
		if (method === "GET" && url === "/_emdash/api/auth/me")
			return jsonResponse({ data: { id: "user-1", role: 40 } });
		if (method === "GET" && url.startsWith("/_emdash/api/bylines"))
			return jsonResponse({ data: { items: [] } });
		if (method === "GET" && url.startsWith("/_emdash/api/admin/users"))
			return jsonResponse({
				data: { items: [{ id: "user-2", name: "Second author", email: "second@example.com" }] },
			});
		if (method === "GET" && url.includes("/post-1/revisions"))
			return jsonResponse({ data: { items: [], total: 0 } });
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/")) {
			const id = url.split("/content/posts/")[1]?.split("?")[0] ?? "post-1";
			return jsonResponse({
				data: { item: { ...item(id), data: savedData.get(id) ?? item(id).data, authorId } },
			});
		}
		if (method === "GET" && url.startsWith("/_emdash/api/revisions/")) {
			return jsonResponse({
				data: {
					item: {
						id: url.split("/revisions/")[1],
						collection: "posts",
						entryId: url.split("/revisions/revision-")[1],
						data: savedData.get(url.split("/revisions/revision-")[1]!) ?? {
							title: "Initial title",
						},
						authorId: null,
						createdAt: "2026-01-01T00:00:00Z",
					},
				},
			});
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/")) {
			if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
			const payload = JSON.parse(init.body);
			if ("authorId" in payload) {
				const status = authorResponses[authorIndex++] ?? 200;
				if (status !== 200)
					return jsonResponse(
						{ error: { code: "VALIDATION_ERROR", message: "Author is rejected by the server." } },
						status,
					);
				authorId = payload.authorId;
				return jsonResponse({
					data: { item: { ...item("post-1"), data: savedData.get("post-1"), authorId } },
				});
			}
			writes.push(payload);
			await pendingSave;
			const status = putResponses[putIndex++] ?? 200;
			if (status !== 200)
				return jsonResponse(
					{ error: { code: "VALIDATION_ERROR", message: "Title is rejected by the server." } },
					status,
				);
			const data = payload.data;
			savedData.set("post-1", data);
			return jsonResponse({
				data: { item: { ...item("post-1"), data }, _rev: `revision-${putIndex}` },
			});
		}
		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;
	return { writes, restore: () => (globalThis.fetch = originalFetch) };
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
		params: { collection: "posts", id: "post-1" },
	});
	const screen = await render(<TestApp />);
	await expect.element(screen.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
	return { screen, router };
}

describe("ContentEditPage save error wiring", () => {
	let server: ReturnType<typeof createMockServer> | undefined;
	afterEach(async () => {
		await page.viewport(1280, 800);
		server?.restore();
		server = undefined;
		vi.useRealTimers();
	});

	it("announces save completion from a persistent live region and restores keyboard focus", async () => {
		let finishSave!: () => void;
		server = createMockServer(
			[200],
			[],
			new Promise<void>((resolve) => {
				finishSave = resolve;
			}),
		);
		const { screen } = await renderEditPage();
		const status = screen.getByRole("status").filter({ hasText: "Saved" }).element();
		await screen.getByRole("textbox", { name: "Title" }).fill("Keyboard save");
		await expect.element(status).toHaveTextContent("Unsaved changes");
		const save = screen.getByRole("button", { name: "Save", exact: true });
		save.element().focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(status).toHaveTextContent("Saving...");
		finishSave();
		await expect.element(status).toHaveTextContent("Saved");
		expect(status.isConnected).toBe(true);
		expect(status.closest("[aria-hidden=true], [inert]")).toBeNull();
		const heading = document.querySelector("[data-emdash-editor-bar] h1")!;
		await expect.element(heading).toHaveFocus();
		expect(save.query()).toBeNull();
	});

	it("keeps title focus when autosave finishes after Save blurred without a target", async () => {
		let finishSave!: () => void;
		server = createMockServer(
			[200],
			[],
			new Promise<void>((resolve) => {
				finishSave = resolve;
			}),
		);
		const { screen } = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });
		await title.fill("Continue editing after blur");
		const save = screen.getByRole("button", { name: "Save", exact: true });
		save.element().focus();
		await expect.element(save).toHaveFocus();
		save.element().blur();
		expect(document.activeElement).toBe(document.body);
		title.element().focus();
		await expect.element(title).toHaveFocus();
		await expect.poll(() => server!.writes.length, { timeout: 6000 }).toBe(1);
		finishSave();
		await expect
			.element(screen.getByRole("status").filter({ hasText: "Saved" }))
			.toHaveTextContent("Saved");
		expect(save.query()).toBeNull();
		await expect.element(title).toHaveFocus();
	});

	it("keeps explicit draft checkpoints reachable on phones after autosave", async () => {
		await page.viewport(390, 800);
		server = createMockServer([200, 200], [], undefined, true);
		const { screen } = await renderEditPage();
		const status = screen.getByRole("status").filter({ hasText: "Saved" }).element();
		await screen.getByRole("textbox", { name: "Title" }).fill("Phone checkpoint");
		await expect.poll(() => server!.writes.length, { timeout: 6000 }).toBe(1);
		await expect.element(status).toHaveTextContent("Saved");
		expect(server.writes[0]).toMatchObject({ skipRevision: true });
		await screen.getByRole("button", { name: "Settings", exact: true }).click();
		const manualSave = screen.getByRole("button", { name: "Save draft", exact: true });
		await expect.element(manualSave).toBeEnabled();
		await manualSave.click();
		await expect.poll(() => server!.writes.length).toBe(2);
		expect(server.writes[1]).not.toHaveProperty("skipRevision");
		expect(server.writes[1]).toMatchObject({ data: { title: "Phone checkpoint" } });
		await expect.element(status).toHaveTextContent("Saved");
		await expect.element(manualSave).toBeEnabled();
	});

	it("shows, dismisses, replaces, and clears a manual save error", async () => {
		server = createMockServer([500, 500, 200]);
		const { screen } = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });
		const save = screen.getByRole("button", { name: "Save", exact: true });

		await title.fill("Rejected once");
		await save.click();
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Title is rejected by the server.");
		await screen.getByRole("button", { name: "Dismiss save error" }).click();
		expect(screen.getByRole("alert").query()).toBeNull();

		await title.fill("Rejected twice");
		await save.click();
		await expect.element(screen.getByRole("alert")).toBeVisible();
		await title.fill("Accepted");
		await save.click();
		await vi.waitFor(() => expect(screen.getByRole("alert").query()).toBeNull());
	});

	it("does not show an editor banner for a failed or retried auxiliary write", async () => {
		server = createMockServer([], [500, 200]);
		const { screen } = await renderEditPage();
		const author = screen.getByRole("combobox", { name: "Author" });

		await author.click();
		await page.getByRole("option", { name: /Second author/ }).click();
		await vi.waitFor(() =>
			expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent(
				"Author is rejected",
			),
		);
		expect(screen.getByRole("alert").query()).toBeNull();

		await author.click();
		await page.getByRole("option", { name: /Second author/ }).click();
		await expect.element(author).toHaveTextContent("Second author");
		expect(screen.getByRole("alert").query()).toBeNull();
	});

	it("shows autosave failures in the editor and does not carry them to another entry", async () => {
		vi.useFakeTimers();
		server = createMockServer([500, 200, 500]);
		const { screen, router } = await renderEditPage();
		await screen.getByRole("textbox", { name: "Title" }).fill("Autosave rejected");
		await vi.waitFor(async () => {
			await vi.advanceTimersByTimeAsync(500);
			expect(screen.getByRole("alert").query()).not.toBeNull();
		});
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Autosave failed");
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Title is rejected by the server.");
		await expect
			.element(screen.getByRole("region", { name: "Notifications" }))
			.toHaveTextContent("Autosave failed");

		await screen.getByRole("textbox", { name: "Title" }).fill("Autosave accepted");
		await vi.waitFor(async () => {
			await vi.advanceTimersByTimeAsync(500);
			expect(screen.getByRole("alert").query()).toBeNull();
		});
		await screen.getByRole("textbox", { name: "Title" }).fill("Another failure");
		await vi.waitFor(async () => {
			await vi.advanceTimersByTimeAsync(500);
			expect(screen.getByRole("alert").query()).not.toBeNull();
		});
		await screen.getByRole("combobox", { name: "Author" }).click();
		await vi.advanceTimersByTimeAsync(150);
		await page.getByRole("option", { name: /Second author/ }).click();
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() =>
			expect(screen.getByRole("combobox", { name: "Author" }).element().textContent).toContain(
				"Second author",
			),
		);
		expect(screen.getByRole("alert").query()).not.toBeNull();

		vi.useRealTimers();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post-2" },
			ignoreBlocker: true,
		});
		await expect
			.element(screen.getByRole("textbox", { name: "Title" }))
			.toHaveValue("Initial title");
		expect(screen.getByRole("alert").query()).toBeNull();

		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post-1" },
			ignoreBlocker: true,
		});
		await expect
			.element(screen.getByRole("textbox", { name: "Title" }))
			.toHaveValue("Autosave accepted");
		expect(screen.getByRole("alert").query()).toBeNull();
	});
});
