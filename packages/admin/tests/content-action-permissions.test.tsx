import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers";

const SUBSCRIBER = { id: "user_subscriber", role: 10 };
const CONTRIBUTOR = { id: "user_contributor", role: 20 };
const AUTHOR = { id: "user_author", role: 30 };
const EDITOR = { id: "user_editor", role: 40 };
const ADMIN = { id: "user_admin", role: 50 };

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts"],
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

interface Entry {
	id: string;
	title: string;
	status: "draft" | "published" | "scheduled";
	authorId: string | null;
}

function contentItem({ id, title, status, authorId }: Entry) {
	const published = status === "published";
	return {
		id,
		type: "posts",
		slug: id,
		status,
		locale: "en",
		translationGroup: null,
		data: { title },
		authorId,
		primaryBylineId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		publishedAt: published ? "2025-01-01T00:00:00Z" : null,
		scheduledAt: status === "scheduled" ? "2099-01-01T00:00:00Z" : null,
		liveRevisionId: published ? "rev_1" : null,
		draftRevisionId: published ? "rev_1" : null,
	};
}

let requests: string[];
let restoreFetch: () => void;

interface TrashOptions {
	trashed: Entry[];
	emptyTrash?: (url: URL) => Promise<Response>;
	manifest?: AdminManifest;
}

function serve(user: { id: string; role: number }, entries: Entry[], trash?: TrashOptions) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(href, location.origin);
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url.pathname}`);
		const path = url.pathname;
		if (path === "/_emdash/api/manifest") {
			return Response.json({ data: trash?.manifest ?? MANIFEST });
		}
		if (path === "/_emdash/api/auth/me") return Response.json({ data: user });
		if (path === "/_emdash/api/content/posts") {
			return Response.json({ data: { items: entries.map(contentItem), total: entries.length } });
		}
		if (trash && path === "/_emdash/api/content/posts/trash") {
			if (method === "DELETE" && trash.emptyTrash) return trash.emptyTrash(url);
			const items = trash.trashed.map((entry) => ({
				...contentItem(entry),
				deletedAt: "2025-01-02T00:00:00Z",
			}));
			return Response.json({ data: { items, total: items.length } });
		}
		const entry = entries.find(
			(candidate) => path === `/_emdash/api/content/posts/${candidate.id}`,
		);
		if (entry) return Response.json({ data: { item: contentItem(entry), _rev: "rev-token" } });
		if (path.endsWith("/lock")) {
			return Response.json({ data: { enabled: true, heldByCaller: true, holder: null } });
		}
		return Response.json({ data: { items: [], total: 0 } });
	};
	restoreFetch = () => {
		globalThis.fetch = originalFetch;
	};
}

async function renderAt(
	location:
		| { to: "/content/$collection"; params: { collection: string } }
		| { to: "/content/$collection/$id"; params: { collection: string; id: string } },
) {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
	await router.navigate(location);
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

function openEntry(id: string) {
	return renderAt({ to: "/content/$collection/$id", params: { collection: "posts", id } });
}

beforeEach(() => {
	requests = [];
});

afterEach(() => {
	restoreFetch();
});

describe("content list Duplicate offer", () => {
	const entries: Entry[] = [
		{ id: "own", title: "Own post", status: "draft", authorId: AUTHOR.id },
		{ id: "other", title: "Other post", status: "draft", authorId: "user_other" },
		{ id: "unowned", title: "Unowned post", status: "draft", authorId: null },
	];

	async function duplicateOffers(served: Entry[]) {
		const screen = await renderAt({ to: "/content/$collection", params: { collection: "posts" } });
		const offers: string[] = [];
		for (const { title } of served) {
			await screen.getByRole("button", { name: `Actions for ${title}` }).click();
			await expect.element(screen.getByRole("menuitem", { name: "Edit" })).toBeVisible();
			if (screen.getByRole("menuitem", { name: "Duplicate" }).query()) offers.push(title);
			await userEvent.keyboard("{Escape}");
			await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
		}
		return offers;
	}

	it("offers a Contributor no Duplicate, not even on their own drafts", async () => {
		const served: Entry[] = [
			...entries,
			{ id: "contributor", title: "Contributor post", status: "draft", authorId: CONTRIBUTOR.id },
		];
		serve(CONTRIBUTOR, served);
		expect(await duplicateOffers(served)).toEqual([]);
	});

	it("offers an Author Duplicate only on their own entries", async () => {
		serve(AUTHOR, entries);
		expect(await duplicateOffers(entries)).toEqual(["Own post"]);
	});

	it("offers an Editor Duplicate on every entry", async () => {
		serve(EDITOR, entries);
		expect(await duplicateOffers(entries)).toEqual(["Own post", "Other post", "Unowned post"]);
	});
});

describe("content editor Save and Publish offers", () => {
	it("lets a Contributor save their own draft but not publish it", async () => {
		serve(CONTRIBUTOR, [{ id: "p1", title: "Mine", status: "draft", authorId: CONTRIBUTOR.id }]);
		const screen = await openEntry("p1");

		await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
		await screen.getByRole("textbox", { name: "Title" }).fill("Edited draft");
		await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
		expect(screen.getByRole("button", { name: /^Publish/ }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Schedule" }).query()).toBeNull();
		expect(requests).toContain("POST /_emdash/api/content/posts/p1/lock");
	});

	it("shows a Contributor their published entry read-only", async () => {
		serve(CONTRIBUTOR, [
			{ id: "p1", title: "Mine", status: "published", authorId: CONTRIBUTOR.id },
		]);
		const screen = await openEntry("p1");

		await expect
			.element(screen.getByText("Your role can edit your own entries only while they are drafts."))
			.toBeVisible();
		await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
		expect(screen.getByRole("button", { name: /^Unpublish/ }).query()).toBeNull();
		expect(requests.filter((request) => request.endsWith("/lock"))).toEqual([]);
	});

	it("doesn't promise draft edits to a Subscriber who owns the entry", async () => {
		serve(SUBSCRIBER, [{ id: "p1", title: "Mine", status: "published", authorId: SUBSCRIBER.id }]);
		const screen = await openEntry("p1");

		await expect.element(screen.getByText("Your role can't edit this entry.")).toBeVisible();
	});

	it("shows an Author someone else's entry read-only, without Publish", async () => {
		serve(AUTHOR, [{ id: "p1", title: "Theirs", status: "draft", authorId: "user_other" }]);
		const screen = await openEntry("p1");

		await expect.element(screen.getByText("Your role can't edit this entry.")).toBeVisible();
		await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
		expect(screen.getByRole("button", { name: /^Publish/ }).query()).toBeNull();
		expect(requests.filter((request) => request.endsWith("/lock"))).toEqual([]);
	});

	it("shows an Author someone else's scheduled entry without schedule actions", async () => {
		serve(AUTHOR, [{ id: "p1", title: "Theirs", status: "scheduled", authorId: "user_other" }]);
		const screen = await openEntry("p1");

		await expect.element(screen.getByText("Your role can't edit this entry.")).toBeVisible();
		expect(screen.getByRole("button", { name: "Remove schedule" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Change schedule" }).query()).toBeNull();
	});

	it("treats an entry without a recorded author as someone else's for an Author", async () => {
		serve(AUTHOR, [{ id: "p1", title: "Imported", status: "draft", authorId: null }]);
		const screen = await openEntry("p1");

		await expect.element(screen.getByText("Your role can't edit this entry.")).toBeVisible();
		expect(screen.getByRole("button", { name: /^Publish/ }).query()).toBeNull();
	});

	it("offers an Author Publish on their own entry", async () => {
		serve(AUTHOR, [{ id: "p1", title: "Mine", status: "draft", authorId: AUTHOR.id }]);
		const screen = await openEntry("p1");

		await expect.element(screen.getByRole("button", { name: "Publish now" })).toBeVisible();
		await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
	});

	it("offers an Editor Publish on an entry without a recorded author", async () => {
		serve(EDITOR, [{ id: "p1", title: "Imported", status: "draft", authorId: null }]);
		const screen = await openEntry("p1");

		await expect.element(screen.getByRole("button", { name: "Publish now" })).toBeVisible();
		await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
	});
});

describe("content trash actions", () => {
	const trashed: Entry[] = [
		{ id: "gone", title: "Gone post", status: "draft", authorId: EDITOR.id },
		{ id: "older", title: "Older post", status: "draft", authorId: EDITOR.id },
	];

	async function openTrash() {
		const screen = await renderAt({ to: "/content/$collection", params: { collection: "posts" } });
		await screen.getByRole("tab", { name: /Trash/ }).click();
		await screen.getByRole("button", { name: "Actions for Gone post" }).click();
		await expect.element(screen.getByRole("menuitem", { name: "Restore" })).toBeVisible();
		return screen;
	}

	it("offers an Editor neither Delete permanently nor Empty trash", async () => {
		serve(EDITOR, [], { trashed });
		const screen = await openTrash();

		expect(screen.getByRole("menuitem", { name: "Delete permanently" }).query()).toBeNull();
		await userEvent.keyboard("{Escape}");
		expect(screen.getByRole("button", { name: /Empty trash/ }).query()).toBeNull();
	});

	it("offers an Admin Delete permanently and Empty trash", async () => {
		serve(ADMIN, [], { trashed });
		const screen = await openTrash();

		await expect
			.element(screen.getByRole("menuitem", { name: "Delete permanently" }))
			.toBeVisible();
		await userEvent.keyboard("{Escape}");
		await expect.element(screen.getByRole("button", { name: "Empty trash (2)" })).toBeVisible();
	});

	it("empties the trash in batches, showing progress, after a confirmation that opens on Cancel", async () => {
		const batches = [
			{ deleted: 40, remaining: 80 },
			{ deleted: 40, remaining: 40 },
			{ deleted: 40, remaining: 0 },
		];
		const pending: Array<() => void> = [];
		serve(ADMIN, [], {
			trashed,
			emptyTrash: () =>
				new Promise((resolve) => {
					const batch = batches[pending.length]!;
					pending.push(() => resolve(Response.json({ data: batch })));
				}),
		});
		const screen = await renderAt({ to: "/content/$collection", params: { collection: "posts" } });
		await screen.getByRole("tab", { name: /Trash/ }).click();

		await screen.getByRole("button", { name: "Empty trash (2)" }).click();
		const dialog = screen.getByRole("dialog", { name: "Empty trash?" });
		await expect.element(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
		await expect
			.element(
				dialog.getByText("Permanently delete all 2 items in the trash? This cannot be undone."),
			)
			.toBeVisible();
		dialog.getByRole("button", { name: "Empty trash" }).element().click();

		await expect.element(dialog.getByRole("button", { name: "Deleting 0 of 2…" })).toBeVisible();
		await vi.waitFor(() => expect(pending).toHaveLength(1));
		pending[0]!();
		await expect.element(dialog.getByRole("button", { name: "Deleting 40 of 120…" })).toBeVisible();
		await expect.element(dialog.getByRole("status")).toHaveTextContent("Deleting 40 of 120…");
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		pending[1]!();
		await expect.element(dialog.getByRole("button", { name: "Deleting 80 of 120…" })).toBeVisible();
		await vi.waitFor(() => expect(pending).toHaveLength(3));
		pending[2]!();

		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(screen.getByText("Permanently deleted 120 items")).toBeVisible();
		expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([
			"DELETE /_emdash/api/content/posts/trash",
			"DELETE /_emdash/api/content/posts/trash",
			"DELETE /_emdash/api/content/posts/trash",
		]);
	});
	it("empties only the trash of the locale the list shows", async () => {
		const deleteUrls: URL[] = [];
		serve(ADMIN, [], {
			trashed,
			manifest: { ...MANIFEST, i18n: { defaultLocale: "fr", locales: ["en", "fr"] } },
			emptyTrash: async (url) => {
				deleteUrls.push(url);
				return Response.json({ data: { deleted: 2, remaining: 0 } });
			},
		});
		const screen = await renderAt({ to: "/content/$collection", params: { collection: "posts" } });
		await screen.getByRole("tab", { name: /Trash/ }).click();

		await screen.getByRole("button", { name: "Empty trash (2)" }).click();
		const dialog = screen.getByRole("dialog", { name: "Empty trash?" });
		await expect
			.element(
				dialog.getByText("Permanently delete all 2 FR items in the trash? This cannot be undone."),
			)
			.toBeVisible();
		dialog.getByRole("button", { name: "Empty trash" }).element().click();

		await expect.element(dialog).not.toBeInTheDocument();
		expect(deleteUrls.map((url) => url.searchParams.get("locale"))).toEqual(["fr"]);
	});
});
