import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchBylines } from "../../src/lib/api";
import { fetchManifest } from "../../src/lib/api/client.js";
import { BylinesPage } from "../../src/routes/bylines";
import { render } from "../utils/render.tsx";
import { QueryWrapper } from "../utils/test-helpers.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		useNavigate: () => vi.fn(),
		useSearch: () => ({}),
	};
});

// fetchManifest is imported from the client module directly.
vi.mock("../../src/lib/api/client.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/client.js");
	return {
		...actual,
		fetchManifest: vi.fn().mockResolvedValue({}),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(),
		fetchUsers: vi.fn().mockResolvedValue({ items: [] }),
		fetchByline: vi.fn().mockResolvedValue(null),
		fetchBylineTranslations: vi.fn().mockResolvedValue({ items: [] }),
	};
});

const fetchBylinesMock = vi.mocked(fetchBylines);

function searchArgs(): (string | undefined)[] {
	return fetchBylinesMock.mock.calls.map((call) => call[0]?.search);
}

describe("BylinesPage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fetchBylinesMock.mockResolvedValue({ items: [], nextCursor: undefined });
	});

	it("preserves unsaved edits when the active locale is selected again", async () => {
		vi.mocked(fetchManifest).mockResolvedValueOnce({
			version: "1.0.0",
			hash: "test-manifest",
			authMode: "passkey",
			collections: {},
			plugins: {},
			taxonomies: [],
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
		});
		fetchBylinesMock.mockResolvedValue({
			items: [
				{
					id: "byline-1",
					slug: "alice",
					displayName: "Alice Example",
					bio: null,
					avatarMediaId: null,
					websiteUrl: null,
					userId: null,
					isGuest: true,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					locale: "en",
					translationGroup: "group-1",
				},
			],
		});
		const screen = await render(
			<QueryWrapper>
				<BylinesPage />
			</QueryWrapper>,
		);
		await screen.getByRole("button", { name: "Alice Example alice" }).click();
		const displayName = screen.getByRole("textbox", { name: "Display name", exact: true });
		await expect.element(displayName).toHaveValue("Alice Example");
		await displayName.fill("Unsaved display name");

		await screen.getByRole("combobox", { name: "Locale", exact: true }).click();
		await screen.getByRole("option", { name: "EN (default)", exact: true }).click();

		await expect.element(screen.getByRole("listbox")).not.toBeInTheDocument();
		await expect.element(displayName).toHaveValue("Unsaved display name");
		await expect.element(screen.getByRole("heading", { name: "Edit Alice Example" })).toBeVisible();
		await expect
			.element(screen.getByRole("textbox", { name: "Slug", exact: true }))
			.toHaveValue("alice");
	});

	it("debounces rapid typing into a single refetch and keeps the input mounted", async () => {
		vi.useFakeTimers();
		try {
			const screen = await render(
				<QueryWrapper>
					<BylinesPage />
				</QueryWrapper>,
			);

			// Let the initial bylines query resolve so the full-page loader
			// gate (isLoading && !data) clears and the list view renders.
			await vi.advanceTimersByTimeAsync(0);
			expect(searchArgs()).toEqual([undefined]);

			const input = screen.getByPlaceholder("Search bylines");
			await expect.element(input).toBeInTheDocument();

			// Three keystrokes in quick succession (under the 300ms window).
			await input.fill("a");
			await input.fill("al");
			await input.fill("ali");

			// No new fetch yet: the debounce has not elapsed, and the input
			// must stay mounted/focused rather than being unmounted by a
			// full-page loader takeover on every keystroke.
			expect(searchArgs()).toEqual([undefined]);
			await expect.element(input).toHaveValue("ali");

			// After the debounce window, exactly one additional refetch fires
			// for the final value — not one per intermediate keystroke.
			await vi.advanceTimersByTimeAsync(300);
			await vi.waitFor(() => {
				expect(searchArgs()).toEqual([undefined, "ali"]);
			});

			// The list view (and its search input) is still mounted.
			await expect.element(screen.getByPlaceholder("Search bylines")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the previous results mounted while a search refetch is in flight", async () => {
		vi.useFakeTimers();
		try {
			// Initial load returns one byline; the search refetch is held
			// in-flight so we can observe what the page renders *during* the
			// new query — the moment the original full-page loader takeover
			// (#1220) blanks the screen and drops input focus.
			let resolveSearch: (value: { items: unknown[]; nextCursor: undefined }) => void = () => {};
			const pendingSearch = new Promise<{ items: unknown[]; nextCursor: undefined }>((resolve) => {
				resolveSearch = resolve;
			});
			fetchBylinesMock
				.mockResolvedValueOnce({
					items: [
						{ id: "1", slug: "alice", displayName: "Alice Example", isGuest: false, userId: null },
					],
					nextCursor: undefined,
				} as never)
				.mockReturnValueOnce(pendingSearch as never);

			const screen = await render(
				<QueryWrapper>
					<BylinesPage />
				</QueryWrapper>,
			);

			await vi.advanceTimersByTimeAsync(0);
			await expect.element(screen.getByText("Alice Example")).toBeInTheDocument();

			const input = screen.getByPlaceholder("Search bylines");
			await input.fill("ali");

			// Elapse the debounce so the (still-pending) search refetch fires.
			await vi.advanceTimersByTimeAsync(300);
			await vi.waitFor(() => {
				expect(searchArgs()).toEqual([undefined, "ali"]);
			});

			// While the refetch is in flight the page must NOT collapse into
			// the centered full-page loader: the search input keeps focus and
			// the previous results stay visible.
			await expect.element(screen.getByPlaceholder("Search bylines")).toBeInTheDocument();
			await expect.element(screen.getByText("Alice Example")).toBeInTheDocument();

			resolveSearch({ items: [], nextCursor: undefined });
		} finally {
			vi.useRealTimers();
		}
	});
});
