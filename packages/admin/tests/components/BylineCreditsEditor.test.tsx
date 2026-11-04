import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { BylineCreditsEditor } from "../../src/components/BylineCreditsEditor.js";
import { toBylineSlug, type BylineFormValues } from "../../src/components/BylineFormDialog.js";
import {
	fetchByline,
	fetchBylines,
	type BylineCreditInput,
	type BylineSummary,
} from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
		fetchByline: vi.fn(),
		fetchUsers: vi.fn(async () => ({ items: [] })),
	};
});

vi.mock("../../src/lib/api/byline-fields.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/byline-fields.js");
	return { ...actual, listBylineFields: vi.fn(async () => ({ items: [] })) };
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

function makeCreditPair() {
	const mina = makeByline();
	const guest = makeByline({ id: "guest", slug: "guest", displayName: "Guest Contributor" });
	return {
		mina,
		guest,
		credits: [mina, guest].map((byline) => ({ bylineId: byline.id, roleLabel: null })),
	};
}

function ControlledEditor({
	initialCredits = [],
	bylines = [],
	onQuickCreate,
	onQuickEdit,
}: {
	initialCredits?: BylineCreditInput[];
	bylines?: BylineSummary[];
	onQuickCreate?: (input: BylineFormValues) => Promise<BylineSummary>;
	onQuickEdit?: (bylineId: string, input: BylineFormValues) => Promise<BylineSummary>;
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

type BylineEditorScreen = Awaited<ReturnType<typeof renderBylineEditor>>;

const quickCreateByline = async (input: BylineFormValues) =>
	makeByline({ displayName: input.displayName, slug: input.slug });

function renderControlled(props: Partial<React.ComponentProps<typeof ControlledEditor>> = {}) {
	return renderBylineEditor(<ControlledEditor {...props} />);
}

async function openCreate(screen: BylineEditorScreen, name: string) {
	await screen.getByRole("button", { name: "Choose bylines" }).click();
	await screen.getByLabelText("Search bylines").fill(name);
	await screen.getByRole("button", { name: `Create ${name}` }).click();
	return screen.getByRole("dialog", { name: "New byline" });
}

describe("BylineCreditsEditor", () => {
	beforeEach(() => {
		vi.mocked(fetchBylines).mockResolvedValue({ items: [], nextCursor: null });
		vi.mocked(fetchByline).mockReset();
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

	it("creates a full, non-guest byline from the search and adds it to the post", async () => {
		const onQuickCreate = vi.fn(async (input: BylineFormValues) =>
			makeByline({ id: "rebekah", displayName: input.displayName, slug: input.slug }),
		);
		const screen = await renderControlled({ onQuickCreate });
		const dialog = await openCreate(screen, "Rebekah Aultman");

		await expect
			.element(dialog.getByRole("textbox", { name: "Display name" }))
			.toHaveValue("Rebekah Aultman");
		await expect
			.element(dialog.getByRole("textbox", { name: "Slug" }))
			.toHaveValue("rebekah-aultman");
		await expect.element(dialog.getByRole("switch", { name: "Guest byline" })).not.toBeChecked();
		await dialog.getByRole("textbox", { name: "Website URL" }).fill("https://rebekah.example");
		await dialog.getByRole("textbox", { name: "Bio" }).fill("Staff writer.");
		dialog.getByRole("button", { name: "Create and add" }).element().click();

		await vi.waitFor(() =>
			expect(onQuickCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					displayName: "Rebekah Aultman",
					slug: "rebekah-aultman",
					websiteUrl: "https://rebekah.example",
					bio: "Staff writer.",
					isGuest: false,
				}),
			),
		);
		await expect
			.element(screen.getByRole("button", { name: "More actions for Rebekah Aultman" }))
			.toBeVisible();
	});

	it("creates a byline without submitting the post form around the editor", async () => {
		const onQuickCreate = vi.fn(quickCreateByline);
		const onPostSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
		const screen = await renderBylineEditor(
			<form onSubmit={onPostSubmit}>
				<ControlledEditor onQuickCreate={onQuickCreate} />
			</form>,
		);
		const dialog = await openCreate(screen, "Mina Patel");
		dialog.getByRole("button", { name: "Create and add" }).element().click();

		await vi.waitFor(() => expect(onQuickCreate).toHaveBeenCalledOnce());
		expect(onPostSubmit).not.toHaveBeenCalled();
	});

	it("edits every byline field from the post", async () => {
		const mina = makeByline({ websiteUrl: "https://mina.example", bio: "Columnist." });
		vi.mocked(fetchByline).mockResolvedValue(mina);
		const onQuickEdit = vi.fn(async (_bylineId: string, input: BylineFormValues) =>
			makeByline({ bio: input.bio ?? null }),
		);
		const screen = await renderControlled({
			initialCredits: [{ bylineId: mina.id, roleLabel: null }],
			bylines: [mina],
			onQuickEdit,
		});

		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		await screen.getByRole("menuitem", { name: "Edit byline" }).click();
		const dialog = screen.getByRole("dialog", { name: "Edit byline" });
		await expect
			.element(dialog.getByText("Changes apply everywhere this byline appears."))
			.toBeVisible();
		await expect
			.element(dialog.getByRole("textbox", { name: "Website URL" }))
			.toHaveValue("https://mina.example");
		await dialog.getByRole("textbox", { name: "Bio" }).fill("Senior columnist.");
		dialog.getByRole("button", { name: "Save" }).element().click();

		await vi.waitFor(() =>
			expect(onQuickEdit).toHaveBeenCalledWith(
				mina.id,
				expect.objectContaining({
					displayName: "Mina Patel",
					slug: "mina-patel",
					websiteUrl: "https://mina.example",
					bio: "Senior columnist.",
					isGuest: true,
				}),
			),
		);
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps create errors in the dialog with the entered values", async () => {
		const onQuickCreate = vi.fn(async () => {
			throw new Error("A byline with this slug already exists");
		});
		const screen = await renderControlled({ onQuickCreate });
		const dialog = await openCreate(screen, "Mina Patel");
		dialog.getByRole("button", { name: "Create and add" }).element().click();

		await expect.element(dialog).toBeVisible();
		await expect
			.element(dialog.getByRole("textbox", { name: "Display name" }))
			.toHaveValue("Mina Patel");
		await expect.element(screen.getByText("A byline with this slug already exists")).toBeVisible();
	});

	it("returns to the same search after cancelling creation", async () => {
		const screen = await renderControlled({ onQuickCreate: quickCreateByline });
		const dialog = await openCreate(screen, "Mina Patel");
		dialog.getByRole("button", { name: "Cancel" }).element().click();

		await expect.element(screen.getByLabelText("Search bylines")).toBeVisible();
		await expect.element(screen.getByLabelText("Search bylines")).toHaveValue("Mina Patel");
	});

	it("ignores a completed create request after the editor unmounts", async () => {
		let resolveCreate!: (byline: BylineSummary) => void;
		const onChange = vi.fn();
		const onQuickCreate = vi.fn(
			() => new Promise<BylineSummary>((resolve) => (resolveCreate = resolve)),
		);
		const screen = await renderBylineEditor(
			<BylineCreditsEditor
				credits={[]}
				bylines={[]}
				onChange={onChange}
				onQuickCreate={onQuickCreate}
				entryLocale="en"
			/>,
		);

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByLabelText("Search bylines").fill("Late profile");
		await screen.getByRole("button", { name: "Create Late profile" }).click();
		screen
			.getByRole("dialog", { name: "New byline" })
			.getByRole("button", { name: "Create and add" })
			.element()
			.click();
		await vi.waitFor(() => expect(onQuickCreate).toHaveBeenCalledOnce());

		await screen.unmount();
		resolveCreate(makeByline({ id: "late", displayName: "Late profile", slug: "late-profile" }));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(onChange).not.toHaveBeenCalled();
	});

	it("hides results while the latest search is still debouncing", async () => {
		const mina = makeByline();
		vi.mocked(fetchBylines).mockImplementation(async ({ search }) => ({
			items: search === "Mina Patel" ? [mina] : [],
			nextCursor: null,
		}));
		const screen = await renderControlled({ onQuickCreate: quickCreateByline });

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		const search = screen.getByLabelText("Search bylines");
		await search.fill("Old profile");
		const oldCreateLocator = screen.getByRole("button", { name: "Create Old profile" });
		await expect.element(oldCreateLocator).toBeVisible();
		const oldCreate = oldCreateLocator.element();

		await search.fill("Mina Patel");

		expect(oldCreate.isConnected).toBe(false);
		await expect.element(screen.getByRole("button", { name: "Add Mina Patel" })).toBeVisible();
	});

	it("hides stale results and creation when the latest search fails", async () => {
		const mina = makeByline();
		vi.mocked(fetchBylines).mockImplementation(async ({ search }) => {
			if (search === "broken") throw new Error("Search failed");
			return { items: [mina], nextCursor: null };
		});
		const screen = await renderControlled({ onQuickCreate: quickCreateByline });

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		const search = screen.getByLabelText("Search bylines");
		await search.fill("Mina");
		await expect.element(screen.getByRole("button", { name: "Add Mina Patel" })).toBeVisible();

		await search.fill("broken");
		await expect.element(screen.getByText("Couldn’t search bylines.")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Add Mina Patel" }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: /Create broken/ }))
			.not.toBeInTheDocument();
	});

	it("edits a role only after Done and removes only the post credit", async () => {
		const mina = makeByline();
		const screen = await renderControlled({
			initialCredits: [{ bylineId: mina.id, roleLabel: null }],
			bylines: [mina],
		});

		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		await screen.getByRole("menuitem", { name: "Set role" }).click();
		await screen.getByLabelText("Role on this post (optional)").fill("Writer");
		await expect.element(screen.getByText("Writer")).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Done" }).click();
		await expect.element(screen.getByText("Writer")).toBeInTheDocument();

		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		await screen.getByRole("menuitem", { name: "Remove from post" }).click();
		await expect.element(screen.getByRole("button", { name: "Choose bylines" })).toBeVisible();
	});

	it("clears an unfinished role draft when its byline is removed", async () => {
		const mina = makeByline();
		const screen = await renderControlled({
			initialCredits: [{ bylineId: mina.id, roleLabel: null }],
			bylines: [mina],
		});

		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		await screen.getByRole("menuitem", { name: "Set role" }).click();
		await screen.getByLabelText("Role on this post (optional)").fill("Unfinished draft");
		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		await screen.getByRole("menuitem", { name: "Remove from post" }).click();

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByRole("button", { name: "Add Mina Patel" }).click();

		await expect
			.element(screen.getByLabelText("Role on this post (optional)"))
			.not.toBeInTheDocument();
	});

	it("keeps ordering actions on the drag handle instead of the row menu", async () => {
		const { mina, guest, credits } = makeCreditPair();
		const screen = await renderControlled({
			initialCredits: credits,
			bylines: [mina, guest],
			onQuickEdit: async (_bylineId, input) =>
				makeByline({ displayName: input.displayName, slug: input.slug }),
		});

		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		const menu = screen.getByRole("menu", { name: "More actions for Mina Patel" });
		await expect
			.element(menu.getByRole("menuitem", { name: "Set role", exact: true }))
			.toBeVisible();
		await expect
			.element(menu.getByRole("menuitem", { name: "Edit byline", exact: true }))
			.toBeVisible();
		await expect
			.element(menu.getByRole("menuitem", { name: "Remove from post", exact: true }))
			.toBeVisible();
		await expect.element(screen.getByRole("menuitem", { name: "Move up" })).not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("menuitem", { name: "Move down" }))
			.not.toBeInTheDocument();
	});

	it("returns focus to a byline after adding it", async () => {
		const mina = makeByline();
		const screen = await renderControlled({ bylines: [mina] });

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByRole("button", { name: "Add Mina Patel" }).click();

		const actions = screen.getByRole("button", { name: "More actions for Mina Patel" });
		await vi.waitFor(() => expect(document.activeElement).toBe(actions.element()));
	});

	it("shows the name and slug for every available byline", async () => {
		const byline = makeByline({ displayName: "the", slug: "the" });
		const customSlug = makeByline({ id: "custom", slug: "editorial-mina" });
		const generatedSlug = makeByline({
			id: "generated",
			displayName: "Guest Contributor",
			slug: "guest-contributor",
		});
		const screen = await renderControlled({ bylines: [byline, customSlug, generatedSlug] });

		await screen.getByRole("button", { name: "Choose bylines" }).click();

		await expect
			.element(screen.getByRole("button", { name: "Add the", exact: true }))
			.toBeVisible();
		await expect.element(screen.getByText("editorial-mina", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("guest-contributor", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("the", { exact: true })).toHaveLength(2);
	});

	it("reorders with the keyboard and restores translated row focus", async () => {
		const { mina, guest, credits } = makeCreditPair();
		const screen = await renderControlled({ initialCredits: credits, bylines: [mina, guest] });
		const actions = screen.getByRole("button", { name: "More actions for Mina Patel" }).element();
		const guestActions = screen
			.getByRole("button", { name: "More actions for Guest Contributor" })
			.element();
		actions.setAttribute("aria-label", "إجراءات مينا");

		const handle = screen.getByRole("button", { name: "Reorder Mina Patel" });
		handle.element().focus();
		await userEvent.keyboard(" ");
		await userEvent.keyboard("{ArrowDown}");
		await userEvent.keyboard(" ");

		expect([
			...screen.container.querySelectorAll<HTMLButtonElement>(
				"button[data-byline-actions-trigger]",
			),
		]).toEqual([guestActions, actions]);
		await vi.waitFor(() => expect(document.activeElement).toBe(actions));
	});
});
