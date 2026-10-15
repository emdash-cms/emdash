import { Toast } from "@cloudflare/kumo";
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { createByline, fetchBylines } from "../../src/lib/api";
import type { BylineSummary } from "../../src/lib/api/bylines";
import { BylinesPage } from "../../src/routes/bylines";
import { render } from "../utils/render.tsx";
import { QueryWrapper } from "../utils/test-helpers.tsx";

// The bylines page reads the active locale from the URL and navigates on
// locale switches; neither matters for the search-debounce behaviour, so we
// stub the router hooks to a single-locale, no-op shape.
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
		createByline: vi.fn(),
		fetchUsers: vi.fn().mockResolvedValue({ items: [] }),
		fetchByline: vi.fn().mockResolvedValue(null),
		fetchBylineTranslations: vi.fn().mockResolvedValue({ items: [] }),
	};
});

vi.mock("../../src/lib/api/byline-fields.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/byline-fields.js");
	return { ...actual, listBylineFields: vi.fn().mockResolvedValue({ items: [] }) };
});

const fetchBylinesMock = vi.mocked(fetchBylines);
const createBylineMock = vi.mocked(createByline);

afterEach(async () => {
	await page.viewport(1280, 800);
});

function searchArgs(): (string | undefined)[] {
	return fetchBylinesMock.mock.calls.map((call) => call[0]?.search);
}

describe("BylinesPage search", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fetchBylinesMock.mockResolvedValue({ items: [], nextCursor: undefined });
	});

	it("debounces rapid typing into a single refetch and keeps the input mounted", async () => {
		vi.useFakeTimers();
		try {
			const screen = await render(
				<QueryWrapper>
					<Toast.Provider>
						<BylinesPage />
					</Toast.Provider>
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
					<Toast.Provider>
						<BylinesPage />
					</Toast.Provider>
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

describe("BylinesPage directory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fetchBylinesMock.mockResolvedValue({
			items: [
				{
					id: "guest",
					slug: "guest-contributor",
					displayName: "Guest Contributor",
					bio: "A visiting writer",
					avatarMediaId: null,
					websiteUrl: null,
					userId: null,
					isGuest: true,
					locale: "en",
					translationGroup: null,
					createdAt: "2026-01-01",
					updatedAt: "2026-01-01",
				} satisfies BylineSummary,
			],
			nextCursor: undefined,
		});
	});

	it("keeps the create dialog and its actions within a narrow viewport", async () => {
		await page.viewport(320, 640);
		const screen = await render(
			<QueryWrapper>
				<Toast.Provider>
					<BylinesPage />
				</Toast.Provider>
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: "New byline" }).first().click();
		const dialog = screen.getByRole("dialog", { name: "New byline" });
		await expect.element(dialog).toBeVisible();
		const bounds = dialog.element().getBoundingClientRect();
		expect(bounds.left).toBeGreaterThanOrEqual(0);
		expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("scrolls the edit dialog down to its last control with the mouse wheel", async () => {
		await page.viewport(1280, 400);
		const screen = await render(
			<QueryWrapper>
				<Toast.Provider>
					<BylinesPage />
				</Toast.Provider>
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: "Edit Guest Contributor" }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit byline" });
		const displayName = dialog.getByRole("textbox", { name: "Display name" });
		const lastControl = dialog.getByRole("switch", { name: "Guest byline" });
		await expect.element(displayName).toBeEnabled();
		await expect.element(lastControl).not.toBeInViewport();

		await userEvent.wheel(displayName, { delta: { y: 5000 } });

		await expect.element(lastControl).toBeInViewport({ ratio: 1 });
	});

	it("includes the visible delete label in the action's accessible name", async () => {
		const screen = await render(
			<QueryWrapper>
				<Toast.Provider>
					<BylinesPage />
				</Toast.Provider>
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: "More actions for Guest Contributor" }).click();
		await expect
			.element(screen.getByRole("menuitem", { name: "Delete byline Guest Contributor" }))
			.toBeVisible();
	});

	it("shows byline identities and discards edits when the profile dialog is cancelled", async () => {
		const screen = await render(
			<QueryWrapper>
				<Toast.Provider>
					<BylinesPage />
				</Toast.Provider>
			</QueryWrapper>,
		);

		await expect.element(screen.getByText("Guest Contributor")).toBeInTheDocument();
		await expect.element(screen.getByText("A visiting writer")).toBeInTheDocument();
		await expect.element(screen.getByText("Guest", { exact: true })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("textbox", { name: "Display name" }))
			.not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Edit Guest Contributor" }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit byline" });
		await expect.element(dialog).toBeInTheDocument();
		await expect
			.element(dialog.getByRole("textbox", { name: "Display name" }))
			.toHaveValue("Guest Contributor");
		await dialog.getByRole("textbox", { name: "Display name" }).fill("Unsaved name");
		dialog.getByRole("button", { name: "Cancel" }).element().focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Edit Guest Contributor" }).click();
		await expect
			.element(
				screen
					.getByRole("dialog", { name: "Edit byline" })
					.getByRole("textbox", { name: "Display name" }),
			)
			.toHaveValue("Guest Contributor");
	});

	it("creates a byline from just a display name", async () => {
		createBylineMock.mockResolvedValue({ id: "new" } as BylineSummary);
		const screen = await render(
			<QueryWrapper>
				<Toast.Provider>
					<BylinesPage />
				</Toast.Provider>
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: "New byline" }).first().click();
		const dialog = screen.getByRole("dialog", { name: "New byline" });
		await dialog.getByRole("textbox", { name: "Display name" }).fill("Laurel Wamsley");
		await expect
			.element(dialog.getByRole("textbox", { name: "Slug" }))
			.toHaveValue("laurel-wamsley");
		await dialog.getByRole("button", { name: "Create" }).click();

		await vi.waitFor(() =>
			expect(createBylineMock).toHaveBeenCalledWith(
				expect.objectContaining({ displayName: "Laurel Wamsley", slug: "laurel-wamsley" }),
			),
		);
	});

	it("stops filling the slug once it is edited and never rewrites an existing slug", async () => {
		const screen = await render(
			<QueryWrapper>
				<Toast.Provider>
					<BylinesPage />
				</Toast.Provider>
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: "New byline" }).first().click();
		const createDialog = screen.getByRole("dialog", { name: "New byline" });
		const createName = createDialog.getByRole("textbox", { name: "Display name" });
		const createSlug = createDialog.getByRole("textbox", { name: "Slug" });
		await createName.fill("Laurel Wamsley");
		await createSlug.fill("laurel");
		await createName.fill("Laurel A. Wamsley");
		await expect.element(createSlug).toHaveValue("laurel");
		await createSlug.fill("");
		await createName.fill("Laurel Wamsley");
		await expect.element(createSlug).toHaveValue("laurel-wamsley");
		await createDialog.getByRole("button", { name: "Cancel" }).click();

		await screen.getByRole("button", { name: "Edit Guest Contributor" }).click();
		const editDialog = screen.getByRole("dialog", { name: "Edit byline" });
		await editDialog.getByRole("textbox", { name: "Display name" }).fill("Guest Writer");
		await expect
			.element(editDialog.getByRole("textbox", { name: "Slug" }))
			.toHaveValue("guest-contributor");
	});

	it("explains missing and invalid fields instead of disabling Create", async () => {
		const screen = await render(
			<QueryWrapper>
				<Toast.Provider>
					<BylinesPage />
				</Toast.Provider>
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: "New byline" }).first().click();
		const dialog = screen.getByRole("dialog", { name: "New byline" });
		const displayName = dialog.getByRole("textbox", { name: "Display name" });
		const slug = dialog.getByRole("textbox", { name: "Slug" });
		const create = dialog.getByRole("button", { name: "Create" });
		let announcedOnFocus: { invalid: string | null; description: string } | undefined;
		displayName.element().addEventListener(
			"focus",
			(event) => {
				const input = event.currentTarget as HTMLInputElement;
				announcedOnFocus = {
					invalid: input.getAttribute("aria-invalid"),
					description: (input.getAttribute("aria-describedby") ?? "")
						.split(" ")
						.map((id) => document.getElementById(id)?.textContent ?? "")
						.join(" "),
				};
			},
			{ once: true },
		);

		await create.click();
		await expect.element(dialog.getByText("Enter a display name.")).toBeVisible();
		await expect.element(displayName).toHaveFocus();
		expect(announcedOnFocus?.invalid).toBe("true");
		expect(announcedOnFocus?.description).toContain("Enter a display name.");

		await displayName.fill("Laurel");
		await expect.element(dialog.getByText("Enter a display name.")).not.toBeInTheDocument();
		await slug.fill("Laurel Wamsley");
		await dialog.getByRole("textbox", { name: "Website URL" }).fill("laurel.example");
		await create.click();
		await expect
			.element(
				dialog.getByText("Use lowercase letters, numbers, and hyphens, starting with a letter."),
			)
			.toBeVisible();
		await expect
			.element(dialog.getByText("Enter a full URL that starts with https:// or http://."))
			.toBeVisible();
		await expect.element(slug).toHaveFocus();
		expect(createBylineMock).not.toHaveBeenCalled();
	});

	it("keeps the optional linked user select named", async () => {
		const screen = await render(
			<QueryWrapper>
				<Toast.Provider>
					<BylinesPage />
				</Toast.Provider>
			</QueryWrapper>,
		);

		await screen.getByRole("button", { name: "New byline" }).first().click();
		await expect
			.element(
				screen
					.getByRole("dialog", { name: "New byline" })
					.getByRole("combobox", { name: "Linked user" }),
			)
			.toBeInTheDocument();
	});
});
