import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { fireEvent } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem, ContentSeoInput } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "publish-race",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: false,
			fields: {
				title: { kind: "string", label: "Title" },
				website: { kind: "url", label: "Website" },
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
		data: { title: "Draft title", website: "" },
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

interface MockServerOptions {
	hasSeo?: boolean;
	initialBylines?: ContentItem["bylines"];
	initialScheduledAt?: string;
	omitScheduleChangeRevision?: boolean;
	onContentGet?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
	onPut?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
	onPublish?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
	onSchedule?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
	onUnschedule?: (request: RecordedRequest, index: number) => Promise<Response> | Response;
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(code: string, message: string, status: number) {
	return jsonResponse({ error: { code, message } }, status);
}

function contentResponse(item: RevisionedContentItem) {
	const { _rev, ...contentItem } = item;
	return jsonResponse({ data: { item: contentItem, _rev } });
}

function createMockServer(options: MockServerOptions = {}) {
	const originalFetch = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	let contentGetCount = 0;
	let putCount = 0;
	let publishCount = 0;
	let scheduleCount = 0;
	let unscheduleCount = 0;
	let currentRevision = "rev-initial";
	let currentScheduledAt: string | null = options.initialScheduledAt ?? null;
	const currentBylines = options.initialBylines;

	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const request = { method, url, body };
		requests.push(request);

		if (method === "GET" && url === "/_emdash/api/manifest") {
			return jsonResponse({
				data: options.hasSeo
					? {
							...MANIFEST,
							collections: { posts: { ...MANIFEST.collections.posts, hasSeo: true } },
						}
					: MANIFEST,
			});
		}
		if (method === "GET" && url === "/_emdash/api/auth/me") {
			return jsonResponse({ data: { id: "user_1", role: 40 } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/bylines")) {
			return jsonResponse({ data: { items: [] } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/users")) {
			return jsonResponse({ data: { items: [] } });
		}
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			const index = contentGetCount++;
			if (options.onContentGet) return options.onContentGet(request, index);
			const savedData = requests.findLast(
				(candidate) => candidate.method === "PUT" && candidate.body?.data,
			)?.body?.data as Record<string, unknown> | undefined;
			return contentResponse(
				makeItem({
					_rev: currentRevision,
					bylines: currentBylines,
					data: savedData ?? makeItem().data,
					scheduledAt: currentScheduledAt,
				}),
			);
		}
		if (method === "GET" && url === "/_emdash/api/revisions/revision-draft") {
			const savedData = requests.findLast(
				(candidate) => candidate.method === "PUT" && candidate.body?.data,
			)?.body?.data as Record<string, unknown> | undefined;
			return jsonResponse({
				data: {
					item: {
						id: "revision-draft",
						collection: "posts",
						entryId: "post_1",
						data: savedData ?? { title: "Draft title", website: "" },
						authorId: null,
						createdAt: "2026-01-02T00:00:00Z",
					},
				},
			});
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post_1")) {
			const index = putCount++;
			if (options.onPut) return options.onPut(request, index);
			currentRevision = `rev-save-${index + 1}`;
			return contentResponse(
				makeItem({
					_rev: currentRevision,
					bylines: currentBylines,
					data: (request.body?.data as Record<string, unknown> | undefined) ?? makeItem().data,
					scheduledAt: currentScheduledAt,
				}),
			);
		}
		if (method === "POST" && url.startsWith("/_emdash/api/content/posts/post_1/publish")) {
			const index = publishCount++;
			if (options.onPublish) return options.onPublish(request, index);
			const savedData = requests.findLast(
				(candidate) => candidate.method === "PUT" && candidate.body?.data,
			)?.body?.data as Record<string, unknown> | undefined;
			return contentResponse(
				makeItem({
					_rev: `rev-publish-${index + 1}`,
					data: savedData ?? { title: "Draft title", website: "" },
					liveRevisionId: "revision-draft",
				}),
			);
		}
		if (method === "POST" && url.startsWith("/_emdash/api/content/posts/post_1/schedule")) {
			const index = scheduleCount++;
			if (options.onSchedule) return options.onSchedule(request, index);
			currentRevision = `rev-schedule-${index + 1}`;
			currentScheduledAt = String(body?.scheduledAt);
			return contentResponse(
				makeItem({
					_rev: options.omitScheduleChangeRevision ? undefined : currentRevision,
					scheduledAt: currentScheduledAt,
				}),
			);
		}
		if (method === "DELETE" && url.startsWith("/_emdash/api/content/posts/post_1/schedule")) {
			const index = unscheduleCount++;
			if (options.onUnschedule) return options.onUnschedule(request, index);
			currentRevision = `rev-unschedule-${index + 1}`;
			currentScheduledAt = null;
			return contentResponse(
				makeItem({
					_rev: options.omitScheduleChangeRevision ? undefined : currentRevision,
					scheduledAt: null,
				}),
			);
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

function buildRouter() {
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

	return { queryClient, router, TestApp };
}

async function renderEditPage(
	publishingLabel = "Publish changes",
	onQueryClient?: (queryClient: ReturnType<typeof createTestQueryClient>) => void,
) {
	const { queryClient, router, TestApp } = buildRouter();
	onQueryClient?.(queryClient);
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(<TestApp />);
	await expect
		.element(screen.getByRole("button", { name: publishingLabel, exact: true }))
		.toBeVisible();
	return screen;
}

async function getPublishAction(screen: Awaited<ReturnType<typeof render>>) {
	await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
	const action = screen
		.getByRole("dialog", { name: "Publish changes?" })
		.getByRole("button", { name: "Publish changes", exact: true });
	await expect.element(action).toBeVisible();
	return action;
}

async function publishNow(screen: Awaited<ReturnType<typeof render>>) {
	(await getPublishAction(screen)).element().click();
	await vi.advanceTimersByTimeAsync(150);
}

function localDateKey(date: Date): string {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

async function fillScheduleFields(screen: Awaited<ReturnType<typeof render>>) {
	const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	const dayButton = dialog
		.element()
		.querySelector<HTMLButtonElement>(`[data-day="${localDateKey(tomorrow)}"] button`);
	expect(dayButton).not.toBeNull();
	fireEvent.click(dayButton!);
	await dialog.getByRole("textbox", { name: "Hour" }).fill("09");
	await dialog.getByRole("textbox", { name: "Minute" }).fill("00");
}

function contentMutations(requests: RecordedRequest[]) {
	return requests.filter(
		(request) =>
			request.method === "PUT" || (request.method === "POST" && request.url.includes("/publish")),
	);
}

function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("ContentEditPage publish and autosave ordering", () => {
	let server: ReturnType<typeof createMockServer> | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		server?.restore();
		server = undefined;
		vi.useRealTimers();
	});

	it("flushes the current payload before publish and cancels the pending debounce", async () => {
		server = createMockServer();
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Title" }).fill("Latest title");
		await publishNow(screen);
		await vi.advanceTimersByTimeAsync(0);

		const mutations = contentMutations(server.requests);
		expect(mutations.map(({ method }) => method)).toEqual(["PUT", "POST"]);
		expect(mutations[0]?.body).toMatchObject({
			data: { title: "Latest title" },
			_rev: "rev-initial",
		});
		expect(mutations[1]?.body).toEqual({ _rev: "rev-save-1" });

		await vi.advanceTimersByTimeAsync(2500);
		expect(contentMutations(server.requests)).toHaveLength(2);
	});

	it("queues the publish flush behind an in-flight autosave", async () => {
		const autosave = deferredResponse();
		server = createMockServer({
			onPut: (_request, index) => {
				if (index === 0) return autosave.promise;
				return contentResponse(makeItem({ _rev: "rev-flush" }));
			},
		});
		const screen = await renderEditPage();

		const title = screen.getByRole("textbox", { name: "Title" });
		await title.fill("Autosave title");
		await vi.advanceTimersByTimeAsync(2000);
		expect(contentMutations(server.requests)).toHaveLength(1);

		await title.fill("Publish title");
		await publishNow(screen);
		await vi.advanceTimersByTimeAsync(0);
		expect(contentMutations(server.requests)).toHaveLength(1);

		autosave.resolve(contentResponse(makeItem({ _rev: "rev-autosave" })));
		await vi.waitFor(() => {
			expect(contentMutations(server!.requests).map(({ method }) => method)).toEqual([
				"PUT",
				"PUT",
				"POST",
			]);
		});

		const mutations = contentMutations(server.requests);
		expect(mutations[1]?.body).toMatchObject({
			data: { title: "Publish title" },
			_rev: "rev-autosave",
		});
		expect(mutations[2]?.body).toEqual({ _rev: "rev-flush" });
	});

	it.each([
		["network failure", () => Promise.reject(new TypeError("Network unavailable"))],
		["server failure", () => errorResponse("CONTENT_UPDATE_ERROR", "Save failed", 500)],
		["revision conflict", () => errorResponse("CONFLICT", "Content changed", 409)],
	])("does not publish after a %s while flushing", async (_name, failure) => {
		server = createMockServer({ onPut: failure });
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Title" }).fill("Latest title");
		await publishNow(screen);
		await vi.advanceTimersByTimeAsync(0);

		expect(contentMutations(server.requests).map(({ method }) => method)).toEqual(["PUT"]);
	});

	it("does not save or publish an invalid editor payload", async () => {
		server = createMockServer();
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Website" }).fill("not a URL");
		await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
		await vi.advanceTimersByTimeAsync(2500);

		expect(contentMutations(server.requests)).toEqual([]);
	});

	it("coalesces repeated publish clicks and advances the revision token after save and publish", async () => {
		server = createMockServer();
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("First publish");
		const publish = await getPublishAction(screen);
		publish.element().click();
		publish.element().click();
		await vi.advanceTimersByTimeAsync(0);
		expect(contentMutations(server.requests).map(({ method }) => method)).toEqual(["PUT", "POST"]);

		await title.fill("After publish");
		await vi.advanceTimersByTimeAsync(2000);
		const mutations = contentMutations(server.requests);
		expect(mutations.map(({ method }) => method)).toEqual(["PUT", "POST", "PUT"]);
		expect(mutations[2]?.body).toMatchObject({ _rev: "rev-publish-1" });
	});

	it("keeps edits made after a coalesced publish click dirty", async () => {
		const save = deferredResponse();
		server = createMockServer({
			onPut: (request, index) => {
				if (index === 0) return save.promise;
				return contentResponse(
					makeItem({
						_rev: "rev-after-publish",
						data: request.body?.data as Record<string, unknown>,
					}),
				);
			},
			onPublish: () =>
				contentResponse(
					makeItem({
						_rev: "rev-published",
						data: { title: "First publish", website: "" },
						liveRevisionId: "revision-draft",
					}),
				),
		});
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("First publish");
		await publishNow(screen);
		await vi.waitFor(() => expect(contentMutations(server!.requests)).toHaveLength(1));
		await title.fill("Second edit");
		await publishNow(screen);

		save.resolve(
			contentResponse(
				makeItem({ _rev: "rev-saved", data: { title: "First publish", website: "" } }),
			),
		);
		await vi.waitFor(() =>
			expect(contentMutations(server!.requests).map(({ method }) => method)).toEqual([
				"PUT",
				"POST",
			]),
		);
		await vi.advanceTimersByTimeAsync(2000);
		await vi.waitFor(() => expect(contentMutations(server!.requests)).toHaveLength(3));

		const mutations = contentMutations(server.requests);
		expect(mutations[2]?.body).toMatchObject({
			data: { title: "Second edit" },
			_rev: "rev-published",
		});
	});

	it("ignores Enter-key form submission while publish is in flight", async () => {
		const publishResponse = deferredResponse();
		server = createMockServer({ onPublish: () => publishResponse.promise });
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Publish title");
		await publishNow(screen);
		await vi.waitFor(() =>
			expect(contentMutations(server!.requests).map(({ method }) => method)).toEqual([
				"PUT",
				"POST",
			]),
		);

		title.element().focus();
		await userEvent.keyboard("{Enter}");
		await vi.advanceTimersByTimeAsync(0);
		expect(contentMutations(server.requests).map(({ method }) => method)).toEqual(["PUT", "POST"]);

		publishResponse.resolve(contentResponse(makeItem({ _rev: "rev-published" })));
	});

	it("flushes the current payload before scheduling and cancels the pending debounce", async () => {
		server = createMockServer();
		let queryClient: ReturnType<typeof createTestQueryClient> | undefined;
		const screen = await renderEditPage("Publish changes", (client) => {
			queryClient = client;
		});

		await screen.getByRole("textbox", { name: "Title" }).fill("Scheduled title");
		await screen.getByRole("button", { name: "Schedule" }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
		await fillScheduleFields(screen);
		fireEvent.click(
			dialog.getByRole("button", { name: "Schedule changes", exact: true }).element(),
		);

		await vi.waitFor(() => {
			expect(
				server!.requests
					.filter(
						(request) =>
							request.method === "PUT" ||
							(request.method === "POST" && request.url.includes("/schedule")),
					)
					.map(({ method }) => method),
			).toEqual(["PUT", "POST"]);
		});
		const save = server.requests.find((request) => request.method === "PUT");
		expect(save?.body).toMatchObject({
			data: { title: "Scheduled title" },
			_rev: "rev-initial",
		});
		await vi.waitFor(() => {
			expect(
				queryClient?.getQueryData<ContentItem>([
					"content",
					"posts",
					"post_1",
					{ locale: undefined },
				])?.data,
			).toMatchObject({ title: "Scheduled title" });
		});

		await vi.advanceTimersByTimeAsync(2500);
		expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(1);

		await screen.getByRole("textbox", { name: "Title" }).fill("After schedule");
		await vi.advanceTimersByTimeAsync(2000);
		await vi.waitFor(() => {
			expect(server!.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
		});
		const nextSave = server.requests.filter((request) => request.method === "PUT")[1];
		expect(nextSave?.body).toMatchObject({
			data: { title: "After schedule" },
			_rev: "rev-schedule-1",
		});
		await vi.waitFor(() => {
			expect(
				queryClient?.getQueryData<ContentItem>([
					"content",
					"posts",
					"post_1",
					{ locale: undefined },
				])?.data,
			).toMatchObject({ title: "After schedule" });
		});
		await expect.element(screen.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();

		const removeSchedule = screen.getByRole("button", { name: "Remove schedule" });
		await expect.element(removeSchedule).toBeInTheDocument();
		fireEvent.click(removeSchedule.element());
		await vi.waitFor(() => {
			expect(server!.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
		});
		await expect
			.element(screen.getByRole("button", { name: "Publish changes", exact: true }))
			.toBeEnabled();
		expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(2);

		await screen.getByRole("textbox", { name: "Title" }).fill("After unschedule");
		await vi.advanceTimersByTimeAsync(2000);
		await vi.waitFor(() => {
			expect(server!.requests.filter((request) => request.method === "PUT")).toHaveLength(3);
		});
		const saveAfterUnschedule = server.requests.filter((request) => request.method === "PUT")[2];
		expect(saveAfterUnschedule?.body).toMatchObject({
			data: { title: "After unschedule" },
			_rev: "rev-unschedule-1",
		});
	});

	it("flushes the current payload before removing a schedule", async () => {
		server = createMockServer({ initialScheduledAt: "2030-01-01T09:00:00.000Z" });
		const screen = await renderEditPage("Publish changes");

		await screen.getByRole("textbox", { name: "Title" }).fill("Unscheduled title");
		fireEvent.click(screen.getByRole("button", { name: "Remove schedule" }).element());

		await vi.waitFor(() => {
			expect(
				server!.requests
					.filter((request) => request.method === "PUT" || request.method === "DELETE")
					.map(({ method }) => method),
			).toEqual(["PUT", "DELETE"]);
		});
		const save = server.requests.find((request) => request.method === "PUT");
		expect(save?.body).toMatchObject({
			data: { title: "Unscheduled title" },
			_rev: "rev-initial",
		});
	});

	it("flushes the current payload before saving a publication date", async () => {
		server = createMockServer();
		let queryClient: ReturnType<typeof createTestQueryClient> | undefined;
		const screen = await renderEditPage("Publish changes", (client) => {
			queryClient = client;
		});

		await screen.getByRole("textbox", { name: "Title" }).fill("Rescued title");
		await screen.getByRole("button", { name: /Change publication date/ }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Change publication date" });
		await dialog.getByRole("textbox", { name: "Minute" }).fill("07");
		fireEvent.click(dialog.getByRole("button", { name: "Save date", exact: true }).element());

		await vi.waitFor(() => {
			expect(
				server!.requests
					.filter((request) => request.method === "PUT")
					.map((request) => (request.body?.publishedAt ? "date" : "save")),
			).toEqual(["save", "date"]);
		});
		const save = server.requests.find(
			(request) => request.method === "PUT" && !request.body?.publishedAt,
		);
		expect(save?.body).toMatchObject({
			data: { title: "Rescued title" },
			_rev: "rev-initial",
		});

		await vi.waitFor(() => {
			expect(
				queryClient?.getQueryData<ContentItem>([
					"content",
					"posts",
					"post_1",
					{ locale: undefined },
				])?.data,
			).toMatchObject({ title: "Rescued title" });
		});
	});

	it("refuses a publication date change for invalid fields and names the date", async () => {
		server = createMockServer();
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Website" }).fill("not a URL");
		fireEvent.click(screen.getByRole("button", { name: /Change publication date/ }).element());
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Change publication date" });
		await dialog.getByRole("textbox", { name: "Minute" }).fill("07");
		fireEvent.click(dialog.getByRole("button", { name: "Save date", exact: true }).element());

		await expect
			.element(dialog.getByText("Fix invalid fields before changing the publication date"))
			.toBeVisible();
		expect(contentMutations(server.requests)).toEqual([]);
	});

	it("keeps existing bylines after scheduling", async () => {
		const byline = {
			id: "byline-1",
			slug: "ada",
			displayName: "Ada Lovelace",
			bio: null,
			avatarMediaId: null,
			websiteUrl: null,
			userId: null,
			isGuest: true,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			locale: "en",
			translationGroup: null,
		};
		server = createMockServer({
			initialBylines: [{ byline, sortOrder: 0, roleLabel: "Author" }],
		});
		let queryClient: ReturnType<typeof createTestQueryClient> | undefined;
		const screen = await renderEditPage("Publish changes", (client) => {
			queryClient = client;
		});
		await expect.element(screen.getByText("Ada Lovelace", { exact: true })).toBeVisible();

		await screen.getByRole("button", { name: "Schedule" }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
		await fillScheduleFields(screen);
		fireEvent.click(
			dialog.getByRole("button", { name: "Schedule changes", exact: true }).element(),
		);

		await expect.element(screen.getByRole("button", { name: "Change schedule" })).toBeVisible();
		expect(
			queryClient?.getQueryData<ContentItem>(["content", "posts", "post_1", { locale: undefined }])
				?.bylines,
		).toEqual([{ byline, sortOrder: 0, roleLabel: "Author" }]);
	});

	it("keeps the schedule result when the preceding save refetch resolves late", async () => {
		const delayedRefresh = deferredResponse();
		server = createMockServer({
			onContentGet: (_request, index) =>
				index === 0 ? contentResponse(makeItem()) : delayedRefresh.promise,
		});
		const screen = await renderEditPage();

		await screen.getByRole("textbox", { name: "Title" }).fill("Scheduled title");
		await screen.getByRole("button", { name: "Schedule" }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
		await fillScheduleFields(screen);
		fireEvent.click(
			dialog.getByRole("button", { name: "Schedule changes", exact: true }).element(),
		);
		const changeSchedule = screen.getByRole("button", { name: "Change schedule" });
		await expect.element(changeSchedule).toBeVisible();

		delayedRefresh.resolve(contentResponse(makeItem({ _rev: "rev-save-1", scheduledAt: null })));
		await vi.advanceTimersByTimeAsync(0);
		await expect.element(changeSchedule).toBeVisible();
	});

	it("does not create a draft revision for clean schedule changes", async () => {
		server = createMockServer({ initialScheduledAt: "2030-01-01T09:00:00.000Z" });
		const screen = await renderEditPage("Publish changes");

		const changeSchedule = screen.getByRole("button", { name: "Change schedule" });
		fireEvent.click(changeSchedule.element());
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Change schedule" });
		await dialog.getByRole("textbox", { name: "Hour" }).fill("10");
		await vi.advanceTimersByTimeAsync(0);
		fireEvent.click(dialog.getByRole("button", { name: "Save schedule", exact: true }).element());
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => {
			expect(
				server!.requests.filter(
					(request) => request.method === "POST" && request.url.includes("/schedule"),
				),
			).toHaveLength(1);
		});

		fireEvent.click(screen.getByRole("button", { name: "Remove schedule" }).element());
		await vi.waitFor(() => {
			expect(server!.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
		});
		expect(
			server.requests
				.filter(
					(request) =>
						request.method === "PUT" ||
						((request.method === "POST" || request.method === "DELETE") &&
							request.url.includes("/schedule")),
				)
				.map(({ method }) => method),
		).toEqual(["POST", "DELETE"]);
	});

	it("flushes a clean-looking value after an older autosave", async () => {
		const autosave = deferredResponse();
		server = createMockServer({
			onPut: (request, index) =>
				index === 0
					? autosave.promise
					: contentResponse(
							makeItem({
								_rev: "rev-corrective",
								data: request.body?.data as Record<string, unknown>,
							}),
						),
		});
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Autosave title");
		await vi.advanceTimersByTimeAsync(2000);
		await title.fill("Draft title");
		await screen.getByRole("button", { name: "Schedule" }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
		await fillScheduleFields(screen);
		fireEvent.click(
			dialog.getByRole("button", { name: "Schedule changes", exact: true }).element(),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(
			server.requests
				.filter(
					(request) =>
						request.method === "PUT" ||
						(request.method === "POST" && request.url.includes("/schedule")),
				)
				.map(({ method }) => method),
		).toEqual(["PUT"]);

		autosave.resolve(
			contentResponse(
				makeItem({
					_rev: "rev-autosave",
					data: { title: "Autosave title", website: "" },
				}),
			),
		);
		await vi.waitFor(() => {
			expect(
				server!.requests
					.filter(
						(request) =>
							request.method === "PUT" ||
							(request.method === "POST" && request.url.includes("/schedule")),
					)
					.map(({ method }) => method),
			).toEqual(["PUT", "PUT", "POST"]);
		});
		const correctiveSave = server.requests.filter((request) => request.method === "PUT")[1];
		expect(correctiveSave?.body).toMatchObject({
			data: { title: "Draft title" },
			_rev: "rev-autosave",
		});
	});

	it("refreshes the revision token when a schedule response omits it", async () => {
		server = createMockServer({ omitScheduleChangeRevision: true });
		const screen = await renderEditPage();
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Scheduled title");
		await screen.getByRole("button", { name: "Schedule" }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
		await fillScheduleFields(screen);
		fireEvent.click(
			dialog.getByRole("button", { name: "Schedule changes", exact: true }).element(),
		);
		await vi.waitFor(() => {
			expect(server!.requests.filter((request) => request.method === "POST")).toHaveLength(1);
		});

		await title.fill("After schedule");
		await vi.advanceTimersByTimeAsync(2000);
		await vi.waitFor(() => {
			expect(server!.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
		});
		const saveAfterSchedule = server.requests.filter((request) => request.method === "PUT")[1];
		expect(saveAfterSchedule?.body).toMatchObject({
			data: { title: "After schedule" },
			_rev: "rev-schedule-1",
		});
	});
});

describe("ContentEditPage save sequencing and conflicts", () => {
	const conflictRefusal =
		"This entry changed somewhere else. Save anyway, or reload to get the newer version.";
	let server: ReturnType<typeof createSharedEntryServer> | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		server?.restore();
		server = undefined;
		vi.useRealTimers();
	});

	// One stored entry that refuses a save carrying a stale token, like the real
	// handler. A save without a token is a blind write and goes through.
	function createSharedEntryServer(
		overrides: Partial<RevisionedContentItem> = {},
		options: {
			holdFirstSave?: Promise<unknown>;
			holdPublishedAtSave?: Promise<unknown>;
			hasSeo?: boolean;
		} = {},
	) {
		const initialItem = makeItem(overrides);
		const entry = {
			rev: initialItem._rev,
			data: initialItem.data,
			authorId: initialItem.authorId,
			seo: initialItem.seo,
			publishedAt: initialItem.publishedAt,
		};
		let saves = 0;
		const storedItem = () =>
			makeItem({
				...overrides,
				_rev: entry.rev,
				data: entry.data,
				authorId: entry.authorId,
				seo: entry.seo,
				publishedAt: entry.publishedAt,
			});
		const mock = createMockServer({
			hasSeo: options.hasSeo,
			onContentGet: () => contentResponse(storedItem()),
			onPut: async (request, index) => {
				if (index === 0) await options.holdFirstSave;
				const body = request.body ?? {};
				if (body.publishedAt) await options.holdPublishedAtSave;
				if (body._rev && body._rev !== entry.rev) {
					return errorResponse(
						"CONFLICT",
						"Content has been modified since last read (version conflict)",
						409,
					);
				}
				if (body.data) entry.data = body.data as Record<string, unknown>;
				if ("authorId" in body) entry.authorId = body.authorId as string | null;
				if ("publishedAt" in body) entry.publishedAt = body.publishedAt as string | null;
				if (body.seo) {
					entry.seo = {
						title: null,
						description: null,
						image: null,
						canonical: null,
						noIndex: false,
						...entry.seo,
						...(body.seo as ContentSeoInput),
					};
				}
				entry.rev = `rev-save-${++saves}`;
				return contentResponse(storedItem());
			},
		});
		// The draft revision holds what the server stored, never a refused payload.
		const serveEntry = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/_emdash/api/revisions/revision-draft") {
				await serveEntry(input, init);
				return jsonResponse({
					data: {
						item: {
							id: "revision-draft",
							collection: "posts",
							entryId: "post_1",
							data: entry.data,
							authorId: entry.authorId,
							createdAt: "2026-01-02T00:00:00Z",
						},
					},
				});
			}
			return serveEntry(input, init);
		}) as typeof fetch;
		return {
			...mock,
			entry,
			otherWriterSaves(data: Record<string, unknown>) {
				entry.data = data;
				entry.rev = "rev-moved";
			},
		};
	}

	async function enterConflict(screen: Awaited<ReturnType<typeof render>>) {
		server!.otherWriterSaves({ title: "Other writer", website: "" });
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Writer copy");
		await vi.advanceTimersByTimeAsync(2500);
		await expect
			.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
			.toBeVisible();
	}

	function serveOneOtherUser() {
		const inner = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/users")) {
				return jsonResponse({
					data: {
						items: [
							{
								id: "user_2",
								email: "other@example.com",
								name: "Other Writer",
								avatarUrl: null,
								role: 40,
								emailVerified: true,
								disabled: false,
								createdAt: "2026-01-01T00:00:00Z",
								updatedAt: "2026-01-01T00:00:00Z",
								lastLogin: null,
							},
						],
					},
				});
			}
			return inner(input, init);
		}) as typeof fetch;
	}

	function publishRequests() {
		return server!.requests.filter(
			(request) => request.method === "POST" && request.url.includes("/publish"),
		);
	}

	it.each(["author", "SEO"] as const)(
		"queues %s changes behind an in-flight autosave without losing either edit",
		async (field) => {
			const autosave = deferredResponse();
			server = createSharedEntryServer(
				{},
				{ holdFirstSave: autosave.promise, hasSeo: field === "SEO" },
			);
			if (field === "author") serveOneOtherUser();
			const screen = await renderEditPage();
			const title = screen.getByRole("textbox", { name: "Title", exact: true });

			await title.fill("Autosave title");
			await vi.advanceTimersByTimeAsync(2000);
			expect(contentMutations(server.requests)).toHaveLength(1);
			expect(contentMutations(server.requests)[0]?.body).toMatchObject({
				data: { title: "Autosave title" },
				skipRevision: true,
				_rev: "rev-initial",
			});

			if (field === "author") {
				await screen.getByRole("combobox", { name: "Author" }).click();
				await vi.advanceTimersByTimeAsync(150);
				await page.getByRole("option", { name: /Other Writer/ }).click();
			} else {
				await screen.getByRole("textbox", { name: "SEO Title", exact: true }).fill("Queued SEO");
			}
			await vi.advanceTimersByTimeAsync(1000);
			expect(contentMutations(server.requests)).toHaveLength(1);

			autosave.resolve(new Response());
			await vi.waitFor(() => expect(server!.entry.rev).toBe("rev-save-2"));
			await vi.advanceTimersByTimeAsync(2500);

			const changes =
				field === "author" ? { authorId: "user_2" } : { seo: { title: "Queued SEO" } };
			const mutations = contentMutations(server.requests);
			expect(mutations).toHaveLength(2);
			expect(mutations[1]?.body).toMatchObject({ ...changes, _rev: "rev-save-1" });
			expect(server.entry).toMatchObject({ ...changes, data: { title: "Autosave title" } });
			await expect.element(title).toHaveValue("Autosave title");
			await expect
				.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
				.not.toBeInTheDocument();
		},
	);

	it.each(["author", "SEO"] as const)(
		"keeps queued %s edits when the preceding autosave conflicts without overwriting content",
		async (field) => {
			const autosave = deferredResponse();
			server = createSharedEntryServer(
				{},
				{ holdFirstSave: autosave.promise, hasSeo: field === "SEO" },
			);
			if (field === "author") serveOneOtherUser();
			const screen = await renderEditPage();
			await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Writer copy");
			await vi.advanceTimersByTimeAsync(2000);
			if (field === "author") {
				await screen.getByRole("combobox", { name: "Author" }).click();
				await vi.advanceTimersByTimeAsync(150);
				await page.getByRole("option", { name: /Other Writer/ }).click();
			} else {
				await screen.getByRole("textbox", { name: "SEO Title", exact: true }).fill("Queued SEO");
			}
			await vi.advanceTimersByTimeAsync(1000);
			server.otherWriterSaves({ title: "Other writer", website: "" });
			autosave.resolve(new Response());
			await vi.waitFor(() => {
				if (field === "author") expect(server!.entry.authorId).toBe("user_2");
				else expect(server!.entry.seo?.title).toBe("Queued SEO");
			});
			expect(server.entry.data.title).toBe("Other writer");
			await expect
				.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
				.toBeVisible();
			await expect
				.element(screen.getByRole("textbox", { name: "Title", exact: true }))
				.toHaveValue("Writer copy");
		},
	);

	it("keeps a publication-date write queued with its form flush ahead of a pending SEO save", async () => {
		const dateSave = deferredResponse();
		server = createSharedEntryServer({}, { hasSeo: true, holdPublishedAtSave: dateSave.promise });
		const screen = await renderEditPage();
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Publication title");
		await screen.getByRole("textbox", { name: "SEO Title", exact: true }).fill("Publication SEO");
		await screen.getByRole("button", { name: /Change publication date/ }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Change publication date" });
		await dialog.getByRole("textbox", { name: "Minute" }).fill("07");
		fireEvent.click(dialog.getByRole("button", { name: "Save date", exact: true }).element());

		await vi.waitFor(() => expect(contentMutations(server!.requests)).toHaveLength(2));
		await vi.advanceTimersByTimeAsync(1000);
		expect(contentMutations(server.requests)).toHaveLength(2);

		dateSave.resolve(new Response());
		await vi.waitFor(() => expect(server!.entry.rev).toBe("rev-save-3"));
		await vi.advanceTimersByTimeAsync(2500);

		const mutations = contentMutations(server.requests);
		expect(mutations).toHaveLength(3);
		expect(mutations[0]?.body).toMatchObject({
			data: { title: "Publication title" },
			_rev: "rev-initial",
		});
		expect(mutations[1]?.body).toMatchObject({
			publishedAt: expect.any(String),
			_rev: "rev-save-1",
		});
		expect(mutations[2]?.body).toMatchObject({
			seo: { title: "Publication SEO" },
			_rev: "rev-save-2",
		});
		expect(server.entry).toMatchObject({
			data: { title: "Publication title" },
			seo: { title: "Publication SEO" },
			publishedAt: mutations[1]?.body?.publishedAt,
		});
		await expect.element(dialog).not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
			.not.toBeInTheDocument();
	});

	it("refuses a publication date change and keeps the other writer's version", async () => {
		server = createSharedEntryServer();
		const screen = await renderEditPage();
		await enterConflict(screen);

		await screen.getByRole("button", { name: /Change publication date/ }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Change publication date" });
		await dialog.getByRole("textbox", { name: "Minute" }).fill("07");
		fireEvent.click(dialog.getByRole("button", { name: "Save date", exact: true }).element());

		await expect.element(dialog.getByText(conflictRefusal)).toBeVisible();
		expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
		expect(server.entry.data).toMatchObject({ title: "Other writer" });
	});

	it("disables publishing until the writer decides", async () => {
		server = createSharedEntryServer();
		const screen = await renderEditPage();
		await enterConflict(screen);

		await expect
			.element(screen.getByRole("button", { name: "Publish changes", exact: true }))
			.toBeDisabled();
	});

	it("disables unpublishing until the writer decides", async () => {
		server = createSharedEntryServer({ draftRevisionId: null });
		const screen = await renderEditPage("Unpublish Post");
		await enterConflict(screen);

		await expect
			.element(screen.getByRole("button", { name: "Unpublish Post", exact: true }))
			.toBeDisabled();
	});

	it("does not publish from a confirmation dialog that was open when the conflict arrived", async () => {
		server = createSharedEntryServer();
		const screen = await renderEditPage();
		server.otherWriterSaves({ title: "Other writer", website: "" });
		await screen.getByRole("textbox", { name: "Title" }).fill("Writer copy");
		const publishNowButton = await getPublishAction(screen);

		await vi.advanceTimersByTimeAsync(2500);
		await expect.element(publishNowButton).toBeDisabled();
		fireEvent.click(publishNowButton.element());
		await vi.advanceTimersByTimeAsync(1000);

		expect(publishRequests()).toEqual([]);
		expect(server.entry.data).toMatchObject({ title: "Other writer" });
		fireEvent.click(
			screen
				.getByRole("dialog", { name: "Publish changes?" })
				.getByRole("button", { name: "Cancel", exact: true })
				.element(),
		);
		await vi.advanceTimersByTimeAsync(150);
		await expect
			.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
			.toBeVisible();
	});

	it("does not publish when the conflict arrives while the publish waits for autosave", async () => {
		const autosave = deferredResponse();
		server = createSharedEntryServer({}, { holdFirstSave: autosave.promise });
		const screen = await renderEditPage();
		server.otherWriterSaves({ title: "Other writer", website: "" });
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Writer copy");
		await vi.advanceTimersByTimeAsync(2500);

		await publishNow(screen);
		autosave.resolve(new Response());
		await vi.advanceTimersByTimeAsync(1000);

		expect(publishRequests()).toEqual([]);
		expect(server.entry.data).toMatchObject({ title: "Other writer" });
	});

	it("does not save a submission that waited for the autosave the conflict refused", async () => {
		const autosave = deferredResponse();
		server = createSharedEntryServer({}, { holdFirstSave: autosave.promise });
		const screen = await renderEditPage();
		server.otherWriterSaves({ title: "Other writer", website: "" });
		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		await title.fill("Writer copy");
		await vi.advanceTimersByTimeAsync(2500);

		fireEvent.submit(title.element().closest("form")!);
		autosave.resolve(new Response());
		await vi.advanceTimersByTimeAsync(1000);

		await expect
			.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
			.toBeVisible();
		expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
		expect(server.entry.data).toMatchObject({ title: "Other writer" });
	});

	it("keeps the conflict when the author changes, so a later edit cannot overwrite", async () => {
		server = createSharedEntryServer();
		serveOneOtherUser();
		const screen = await renderEditPage();
		await enterConflict(screen);

		await screen.getByRole("combobox", { name: "Author" }).click();
		await vi.advanceTimersByTimeAsync(150);
		await page.getByRole("option", { name: /Other Writer/ }).click();
		await vi.advanceTimersByTimeAsync(5000);

		expect(server.entry.authorId).toBe("user_2");
		await expect
			.element(screen.getByRole("button", { name: "Save anyway", exact: true }))
			.toBeVisible();

		await expect
			.element(screen.getByRole("textbox", { name: "Title", exact: true }))
			.toHaveValue("Writer copy");

		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Writer copy 2");
		await vi.advanceTimersByTimeAsync(5000);

		expect(server.entry.data).toMatchObject({ title: "Other writer" });
	});

	it("refuses a schedule from a dialog that was open when the conflict arrived", async () => {
		server = createSharedEntryServer();
		const screen = await renderEditPage();
		server.otherWriterSaves({ title: "Other writer", website: "" });
		await screen.getByRole("textbox", { name: "Title", exact: true }).fill("Writer copy");
		await screen.getByRole("button", { name: "Schedule" }).click();
		await vi.advanceTimersByTimeAsync(150);
		const dialog = screen.getByRole("dialog", { name: "Schedule changes" });
		await fillScheduleFields(screen);
		await vi.advanceTimersByTimeAsync(2500);

		fireEvent.click(
			dialog.getByRole("button", { name: "Schedule changes", exact: true }).element(),
		);

		await expect.element(dialog.getByText(conflictRefusal)).toBeVisible();
		expect(
			server.requests.filter(
				(request) => request.method === "POST" && request.url.includes("/schedule"),
			),
		).toHaveLength(0);
		expect(server.entry.data).toMatchObject({ title: "Other writer" });
	});

	it("publishes again once the writer saves anyway", async () => {
		server = createSharedEntryServer();
		const screen = await renderEditPage();
		await enterConflict(screen);

		await screen.getByRole("button", { name: "Save anyway", exact: true }).click();
		await vi.advanceTimersByTimeAsync(0);
		await expect
			.element(screen.getByRole("button", { name: "Publish changes", exact: true }))
			.toBeEnabled();
		await publishNow(screen);

		await vi.waitFor(() => expect(publishRequests()).toHaveLength(1));
		expect(server.entry.data).toMatchObject({ title: "Writer copy" });
	});
});
