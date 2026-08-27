import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { BylineCreditsEditor, toBylineSlug } from "../../src/components/BylineCreditsEditor.js";
import { fetchBylines, type BylineCreditInput, type BylineSummary } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
	};
});

function makeByline(overrides: Partial<BylineSummary> = {}): BylineSummary {
	return {
		id: "byline-1",
		slug: "mina-patel",
		displayName: "Mina Patel",
		bio: null,
		avatarMediaId: null,
		websiteUrl: null,
		userId: null,
		isGuest: true,
		createdAt: "2026-08-26T12:00:00Z",
		updatedAt: "2026-08-26T12:00:00Z",
		locale: "en",
		translationGroup: null,
		...overrides,
	};
}

function ControlledEditor({
	initialCredits = [],
	bylines,
	onQuickCreate,
	onQuickEdit,
}: {
	initialCredits?: BylineCreditInput[];
	bylines: BylineSummary[];
	onQuickCreate?: (input: { slug: string; displayName: string }) => Promise<BylineSummary>;
	onQuickEdit?: (
		bylineId: string,
		input: { slug: string; displayName: string },
	) => Promise<BylineSummary>;
}) {
	const [credits, setCredits] = React.useState(initialCredits);
	return (
		<BylineCreditsEditor
			credits={credits}
			bylines={bylines}
			selectedBylineDetails={bylines}
			bylinesLoaded
			onChange={setCredits}
			onQuickCreate={onQuickCreate}
			onQuickEdit={onQuickEdit}
			entryLocale="en"
		/>
	);
}

function renderBylineEditor(ui: React.ReactElement) {
	return render(ui, {
		wrapper: ({ children }) => <Toasty>{children}</Toasty>,
	});
}

describe("BylineCreditsEditor", () => {
	beforeEach(() => {
		vi.mocked(fetchBylines).mockResolvedValue({ items: [], nextCursor: null });
	});

	it.each([
		["Review Tester", "review-tester"],
		["Élodie Durand", "elodie-durand"],
		["123 Writer", "byline-123-writer"],
		["李雷", "byline-1d6w72q"],
	])("creates a valid stable slug for %s", (name, expected) => {
		expect(toBylineSlug(name)).toBe(expected);
		expect(toBylineSlug(name)).toMatch(/^[a-z][a-z0-9-]*$/);
	});

	it("keeps the generated slug in sync until the slug is edited", async () => {
		const onQuickCreate = vi.fn(async (input) =>
			makeByline({ displayName: input.displayName, slug: input.slug }),
		);
		const screen = await renderBylineEditor(
			<ControlledEditor bylines={[]} onQuickCreate={onQuickCreate} />,
		);

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByLabelText("Search bylines").fill("Starter");
		await screen.getByRole("option", { name: /Create “Starter”/ }).click();

		const dialog = screen.getByRole("dialog", { name: "Create byline" });
		const name = dialog.getByLabelText("Name");
		await name.fill("");
		await userEvent.type(name, "Review Tester");
		dialog.getByRole("button", { name: "Advanced" }).element().click();
		await expect.element(dialog.getByLabelText("URL slug")).toHaveValue("review-tester");

		await dialog.getByLabelText("URL slug").fill("reviewer");
		await userEvent.type(name, " Updated");
		await expect.element(dialog.getByLabelText("URL slug")).toHaveValue("reviewer");
	});

	it("keeps create errors in the dialog with the entered values", async () => {
		const onQuickCreate = vi.fn(async () => {
			throw new Error("A byline with this slug already exists");
		});
		const screen = await renderBylineEditor(
			<ControlledEditor bylines={[]} onQuickCreate={onQuickCreate} />,
		);

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByLabelText("Search bylines").fill("Mina Patel");
		await screen.getByRole("option", { name: /Create “Mina Patel”/ }).click();
		const dialog = screen.getByRole("dialog", { name: "Create byline" });
		dialog.getByRole("button", { name: "Create and add" }).element().click();

		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByLabelText("Name")).toHaveValue("Mina Patel");
		await expect.element(screen.getByText("A byline with this slug already exists")).toBeVisible();
	});

	it("returns to the same search after cancelling creation", async () => {
		const screen = await renderBylineEditor(
			<ControlledEditor
				bylines={[]}
				onQuickCreate={async (input) =>
					makeByline({ displayName: input.displayName, slug: input.slug })
				}
			/>,
		);

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByLabelText("Search bylines").fill("Mina Patel");
		await screen.getByRole("option", { name: /Create “Mina Patel”/ }).click();
		screen
			.getByRole("dialog", { name: "Create byline" })
			.getByRole("button", { name: "Cancel" })
			.element()
			.click();
		await new Promise((resolve) => setTimeout(resolve, 200));

		await expect.element(screen.getByLabelText("Search bylines")).toBeVisible();
		await expect.element(screen.getByLabelText("Search bylines")).toHaveValue("Mina Patel");
	});

	it("hides stale results and creation when the latest search fails", async () => {
		const mina = makeByline();
		vi.mocked(fetchBylines).mockImplementation(async ({ search }) => {
			if (search === "broken") throw new Error("Search failed");
			return { items: [mina], nextCursor: null };
		});
		const screen = await renderBylineEditor(<ControlledEditor bylines={[]} />);

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		const search = screen.getByLabelText("Search bylines");
		await search.fill("Mina");
		await expect.element(screen.getByRole("option", { name: /Mina Patel/ })).toBeVisible();

		await search.fill("broken");
		await expect.element(screen.getByText("Couldn’t search bylines.")).toBeVisible();
		await expect
			.element(screen.getByRole("option", { name: /Mina Patel/ }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByRole("option", { name: /Create/ })).not.toBeInTheDocument();
	});

	it("edits a role only after Done and removes only the post credit", async () => {
		const mina = makeByline();
		const screen = await renderBylineEditor(
			<ControlledEditor
				initialCredits={[{ bylineId: mina.id, roleLabel: null }]}
				bylines={[mina]}
			/>,
		);

		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		await screen.getByRole("menuitem", { name: "Set role" }).click();
		await screen.getByLabelText("Role on this post (optional)").fill("Writer");
		await expect.element(screen.getByText("Writer")).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Done" }).click();
		await expect.element(screen.getByText("Writer")).toBeInTheDocument();

		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		await screen.getByRole("menuitem", { name: "Remove from post" }).click();
		await expect.element(screen.getByText("No byline is shown on this post.")).toBeInTheDocument();
	});

	it("keeps ordering actions on the drag handle instead of the row menu", async () => {
		const mina = makeByline();
		const guest = makeByline({ id: "guest", slug: "guest", displayName: "Guest Contributor" });
		const screen = await renderBylineEditor(
			<ControlledEditor
				initialCredits={[
					{ bylineId: mina.id, roleLabel: null },
					{ bylineId: guest.id, roleLabel: null },
				]}
				bylines={[mina, guest]}
				onQuickEdit={async (_bylineId, input) =>
					makeByline({ displayName: input.displayName, slug: input.slug })
				}
			/>,
		);

		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		const menu = screen.getByRole("menu", { name: "More actions for Mina Patel" });
		await expect
			.element(menu.getByRole("menuitem", { name: "Set role", exact: true }))
			.toBeVisible();
		await expect
			.element(menu.getByRole("menuitem", { name: "Edit name and slug", exact: true }))
			.toBeVisible();
		await expect
			.element(menu.getByRole("menuitem", { name: "Remove from post", exact: true }))
			.toBeVisible();
		await expect.element(screen.getByRole("menuitem", { name: "Move up" })).not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("menuitem", { name: "Move down" }))
			.not.toBeInTheDocument();
	});

	it("keeps selected credits in place while the chooser is open", async () => {
		const mina = makeByline();
		const guest = makeByline({ id: "guest", slug: "guest", displayName: "Guest Contributor" });
		const screen = await renderBylineEditor(
			<ControlledEditor
				initialCredits={[
					{ bylineId: mina.id, roleLabel: null },
					{ bylineId: guest.id, roleLabel: null },
				]}
				bylines={[mina, guest]}
			/>,
		);

		await screen.getByRole("button", { name: "Add another byline" }).click();

		await expect.element(screen.getByLabelText("Search bylines")).toBeVisible();
		await expect.element(screen.getByText("Mina Patel")).toBeVisible();
		await expect.element(screen.getByText("Guest Contributor")).toBeVisible();
	});

	it("does not repeat a generated slug beneath its matching name", async () => {
		const byline = makeByline({ displayName: "the", slug: "the" });
		const customSlug = makeByline({ id: "custom", slug: "editorial-mina" });
		const screen = await renderBylineEditor(<ControlledEditor bylines={[byline, customSlug]} />);

		await screen.getByRole("button", { name: "Choose bylines" }).click();

		await expect.element(screen.getByRole("option", { name: "the", exact: true })).toBeVisible();
		await expect.element(screen.getByText("editorial-mina", { exact: true })).toBeVisible();
	});

	it("reorders credits with the keyboard drag handle", async () => {
		const mina = makeByline();
		const guest = makeByline({ id: "guest", slug: "guest", displayName: "Guest Contributor" });
		const screen = await renderBylineEditor(
			<ControlledEditor
				initialCredits={[
					{ bylineId: mina.id, roleLabel: null },
					{ bylineId: guest.id, roleLabel: null },
				]}
				bylines={[mina, guest]}
			/>,
		);

		const handle = screen.getByRole("button", { name: "Reorder Mina Patel" });
		handle.element().focus();
		await userEvent.keyboard(" ");
		await userEvent.keyboard("{ArrowDown}");
		await userEvent.keyboard(" ");

		const actions = Array.from(
			screen.container.querySelectorAll<HTMLButtonElement>(
				'button[aria-label^="More actions for"]',
			),
			(button) => button.getAttribute("aria-label"),
		);
		expect(actions).toEqual(["More actions for Guest Contributor", "More actions for Mina Patel"]);
	});

	it("keeps pointer dragging inside the credit list", async () => {
		const mina = makeByline();
		const guest = makeByline({ id: "guest", slug: "guest", displayName: "Guest Contributor" });
		const screen = await renderBylineEditor(
			<ControlledEditor
				initialCredits={[
					{ bylineId: mina.id, roleLabel: null },
					{ bylineId: guest.id, roleLabel: null },
				]}
				bylines={[mina, guest]}
			/>,
		);
		const handle = screen.getByRole("button", { name: "Reorder Mina Patel" }).element();
		const row = handle.parentElement!;
		const list = row.parentElement!;
		const handleRect = handle.getBoundingClientRect();
		const listRect = list.getBoundingClientRect();
		const pointer = {
			bubbles: true,
			isPrimary: true,
			pointerId: 1,
			pointerType: "mouse",
			clientX: handleRect.left + handleRect.width / 2,
		};

		handle.dispatchEvent(
			new PointerEvent("pointerdown", {
				...pointer,
				clientY: handleRect.top + handleRect.height / 2,
				button: 0,
				buttons: 1,
			}),
		);
		document.dispatchEvent(
			new PointerEvent("pointermove", {
				...pointer,
				clientY: handleRect.bottom + 10,
				buttons: 1,
			}),
		);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		document.dispatchEvent(
			new PointerEvent("pointermove", {
				...pointer,
				clientY: listRect.bottom + 200,
				buttons: 1,
			}),
		);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(handle.dataset.sorting).toBe("true");
		expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(listRect.bottom + 0.5);

		document.dispatchEvent(
			new PointerEvent("pointerup", {
				...pointer,
				clientY: listRect.bottom + 200,
				button: 0,
				buttons: 0,
			}),
		);
	});
});
