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

type BylineEditorScreen = Awaited<ReturnType<typeof renderBylineEditor>>;

const quickCreateByline = async (input: { slug: string; displayName: string }) =>
	makeByline({ displayName: input.displayName, slug: input.slug });

function renderControlled(props: Partial<React.ComponentProps<typeof ControlledEditor>> = {}) {
	return renderBylineEditor(<ControlledEditor {...props} />);
}

async function openCreate(screen: BylineEditorScreen, name: string) {
	await screen.getByRole("button", { name: "Choose bylines" }).click();
	await screen.getByLabelText("Search bylines").fill(name);
	await screen.getByRole("button", { name: `Create ${name}` }).click();
	return screen.getByRole("dialog", { name: "Create byline" });
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
		const screen = await renderControlled({ onQuickCreate });
		const dialog = await openCreate(screen, "Starter");
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
		const screen = await renderControlled({ onQuickCreate });
		const dialog = await openCreate(screen, "Mina Patel");
		dialog.getByRole("button", { name: "Create and add" }).element().click();

		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByLabelText("Name")).toHaveValue("Mina Patel");
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
			.getByRole("dialog", { name: "Create byline" })
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
		await expect.element(screen.getByText("No byline is shown on this post.")).toBeInTheDocument();
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
