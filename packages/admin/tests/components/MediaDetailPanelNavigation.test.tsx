import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaDetailPanel } from "../../src/components/MediaDetailPanel";
import {
	fetchManifest,
	fetchMediaUsageDetails,
	updateMedia,
	type AdminManifest,
	type MediaItem,
	type MediaUsageDetailsResponse,
} from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
	return {
		...actual,
		deleteFromProvider: vi.fn().mockResolvedValue({}),
		deleteMedia: vi.fn().mockResolvedValue({}),
		fetchManifest: vi.fn(),
		fetchMediaUsageDetails: vi.fn(),
		updateMedia: vi.fn().mockResolvedValue({}),
	};
});

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "manifest-hash",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts"],
			hasSeo: false,
			fields: {},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: { defaultLocale: "en", locales: ["en", "fr"] },
};

const usageDetails: MediaUsageDetailsResponse = {
	items: [
		{
			collection: "posts",
			contentId: "post-1",
			title: "Launch notes",
			slug: "launch-notes",
			locale: "fr",
			status: "published",
			scheduledAt: null,
			deletedAt: null,
			sources: [],
		},
	],
	coverage: { scope: "all_content_collections", status: "complete" },
};

const item: MediaItem = {
	id: "media-1",
	filename: "photo.jpg",
	mimeType: "image/jpeg",
	url: "https://example.com/photo.jpg",
	size: 204800,
	alt: "Original",
	createdAt: "2025-01-15T10:30:00Z",
	usage: {
		count: 1,
		coverage: { scope: "all_content_collections", status: "complete" },
	},
};

function createPanelRouter() {
	const rootRoute = createRootRoute({ component: Outlet });
	const panelRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <MediaDetailPanel open item={item} onClose={() => {}} />,
	});
	const contentRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/content/$collection/$id",
		validateSearch: (search: Record<string, unknown>) => ({
			locale: typeof search.locale === "string" ? search.locale : undefined,
		}),
		component: () => <div>Content destination</div>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([panelRoute, contentRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return router;
}

async function renderPanelRouter() {
	const router = createPanelRouter();
	const screen = await render(<RouterProvider router={router} />);
	return { router, screen };
}

describe("MediaDetailPanel usage navigation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchManifest).mockResolvedValue(manifest);
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageDetails);
		vi.mocked(updateMedia).mockResolvedValue(item);
	});

	it("uses the real content link for clean navigation", async () => {
		const { router, screen } = await renderPanelRouter();

		screen
			.getByRole("link", { name: /Launch notes/ })
			.element()
			.click();

		await vi.waitFor(() => {
			expect(router.state.location.pathname).toBe("/content/posts/post-1");
			expect(router.state.location.search).toEqual({ locale: "fr" });
		});
	});

	it("defers dirty same-tab navigation but preserves modified-link behavior", async () => {
		const { router, screen } = await renderPanelRouter();
		await screen.getByLabelText("Alt Text").fill("Changed");
		const link = screen.getByRole("link", { name: /Launch notes/ });

		link
			.element()
			.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
		await expect
			.element(screen.getByText("Discard changes?"), { timeout: 100 })
			.not.toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/");

		link.element().click();
		await expect.element(screen.getByText("Discard changes?")).toBeVisible();
		expect(router.state.location.pathname).toBe("/");

		screen.getByRole("button", { name: "Discard" }).element().click();
		await vi.waitFor(() => {
			expect(router.state.location.pathname).toBe("/content/posts/post-1");
			expect(router.state.location.search).toEqual({ locale: "fr" });
		});
	});

	it("blocks every real-link activation while a save is pending", async () => {
		vi.mocked(updateMedia).mockImplementation(() => new Promise(() => {}));
		const { router, screen } = await renderPanelRouter();
		await screen.getByLabelText("Alt Text").fill("Changed");
		screen.getByRole("button", { name: "Save" }).element().click();
		const link = screen.getByRole("link", { name: /Launch notes/ });

		await expect.element(link).toHaveAttribute("aria-disabled", "true");
		const primaryAllowed = link
			.element()
			.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		const modifiedAllowed = link
			.element()
			.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
		const auxiliaryAllowed = link
			.element()
			.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));

		expect(primaryAllowed).toBe(false);
		expect(modifiedAllowed).toBe(false);
		expect(auxiliaryAllowed).toBe(false);
		expect(router.state.location.pathname).toBe("/");
	});
});
