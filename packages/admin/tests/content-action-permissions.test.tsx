import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers";

const SUBSCRIBER = { id: "user_subscriber", role: 10 };
const CONTRIBUTOR = { id: "user_contributor", role: 20 };
const AUTHOR = { id: "user_author", role: 30 };
const EDITOR = { id: "user_editor", role: 40 };

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

function serve(user: { id: string; role: number }, entries: Entry[]) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(href, location.origin);
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url.pathname}`);
		const path = url.pathname;
		if (path === "/_emdash/api/manifest") return Response.json({ data: MANIFEST });
		if (path === "/_emdash/api/auth/me") return Response.json({ data: user });
		if (path === "/_emdash/api/content/posts") {
			return Response.json({ data: { items: entries.map(contentItem), total: entries.length } });
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

	async function duplicateOffers() {
		const screen = await renderAt({ to: "/content/$collection", params: { collection: "posts" } });
		await expect.element(screen.getByRole("link", { name: "Edit Own post" })).toBeVisible();
		return entries
			.map((entry) => entry.title)
			.filter((title) =>
				[...document.querySelectorAll("button")].some(
					(button) => button.getAttribute("aria-label") === `Duplicate ${title}`,
				),
			);
	}

	it("offers a Contributor no Duplicate, not even on their own drafts", async () => {
		serve(CONTRIBUTOR, [
			...entries,
			{ id: "contributor", title: "Contributor post", status: "draft", authorId: CONTRIBUTOR.id },
		]);
		expect(await duplicateOffers()).toEqual([]);
	});

	it("offers an Author Duplicate only on their own entries", async () => {
		serve(AUTHOR, entries);
		expect(await duplicateOffers()).toEqual(["Own post"]);
	});

	it("offers an Editor Duplicate on every entry", async () => {
		serve(EDITOR, entries);
		expect(await duplicateOffers()).toEqual(["Own post", "Other post", "Unowned post"]);
	});
});

describe("content editor Save and Publish offers", () => {
	it("lets a Contributor save their own draft but not publish it", async () => {
		serve(CONTRIBUTOR, [{ id: "p1", title: "Mine", status: "draft", authorId: CONTRIBUTOR.id }]);
		const screen = await openEntry("p1");

		await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
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
