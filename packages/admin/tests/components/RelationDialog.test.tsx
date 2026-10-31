import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { RelationDialog } from "../../src/components/RelationDialog.js";
import type { SchemaCollection } from "../../src/lib/api";
import { ApiResponseError } from "../../src/lib/api/client.js";
import { pressOutside } from "../utils/mouse.ts";
import { render } from "../utils/render.tsx";

const collections = [
	{ slug: "posts", label: "Posts", labelSingular: "Post" },
	{ slug: "authors", label: "Authors" },
] as SchemaCollection[];

const SLUG_ERROR_REGEX = /slug cannot be generated from these role names/;
const TAKEN_SLUG = "Another relation already uses this slug. Enter a different one.";

function Harness({
	initialCollections = collections,
	onSubmit = vi.fn(async () => ({})),
}: {
	initialCollections?: SchemaCollection[];
	onSubmit?: () => Promise<unknown>;
}) {
	const [open, setOpen] = React.useState(false);
	const [loaded, setLoaded] = React.useState(initialCollections);
	return (
		<>
			<button type="button" onClick={() => setLoaded(collections)}>
				Load collections
			</button>
			<button type="button" onClick={() => setOpen(true)}>
				Define relation
			</button>
			<RelationDialog
				open={open}
				onOpenChange={setOpen}
				collections={loaded}
				defaultParentCollection="posts"
				onSubmit={onSubmit}
			/>
		</>
	);
}

describe("RelationDialog", () => {
	it("finishes closing, then opens with a fresh form", async () => {
		const screen = await render(<Harness />);

		await screen.getByRole("button", { name: "Define relation" }).click();
		const dialog = screen.getByRole("dialog", { name: "New Relation" });
		await expect.element(dialog).toBeVisible();
		await screen.getByLabelText("Linked side (plural)").fill("Writers");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Define relation" }).click();
		await expect.element(screen.getByLabelText("Linked side (plural)")).toHaveValue("");
	});

	it("names the linking side from collections that loaded after it mounted", async () => {
		const screen = await render(<Harness initialCollections={[]} />);

		await screen.getByRole("button", { name: "Load collections" }).click();
		await screen.getByRole("button", { name: "Define relation" }).click();

		await expect.element(screen.getByLabelText("Linking side (plural)")).toHaveValue("Posts");
		await expect.element(screen.getByLabelText("Linking side (singular)")).toHaveValue("Post");
	});

	it("points at each missing field when submitted, and sends nothing until they are filled", async () => {
		const onSubmit = vi.fn(async () => ({}));
		const screen = await render(<Harness onSubmit={onSubmit} />);

		await screen.getByRole("button", { name: "Define relation" }).click();
		const dialog = screen.getByRole("dialog", { name: "New Relation" });
		await expect.element(dialog).toBeVisible();
		expect(dialog.getByText("Choose a content type.").query()).toBeNull();

		await dialog.getByRole("button", { name: "Create Relation" }).click();

		await expect.element(dialog.getByText("Choose a content type.")).toBeVisible();
		await expect
			.element(dialog.getByLabelText("Linked side (plural)"))
			.toHaveAttribute("aria-invalid", "true");
		await expect
			.element(dialog.getByRole("combobox", { name: "Links to", exact: true }))
			.toHaveFocus();
		expect(onSubmit).not.toHaveBeenCalled();

		await dialog.getByRole("combobox", { name: "Links to", exact: true }).click();
		await page.getByRole("option", { name: "Authors" }).click();
		await expect.element(dialog.getByText("Choose a content type.")).not.toBeInTheDocument();
		await expect
			.element(dialog.getByLabelText("Linked side (plural)"))
			.not.toHaveAttribute("aria-invalid");

		await dialog.getByRole("button", { name: "Create Relation" }).click();
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
	});

	it("explains why no slug can be made from the role names, and points at it on submit", async () => {
		const onSubmit = vi.fn(async () => ({}));
		const screen = await render(<Harness onSubmit={onSubmit} />);

		await screen.getByRole("button", { name: "Define relation" }).click();
		const dialog = screen.getByRole("dialog", { name: "New Relation" });
		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await dialog.getByRole("combobox", { name: "Links to", exact: true }).click();
		await page.getByRole("option", { name: "Authors" }).click();
		await screen.getByLabelText("Linking side (plural)").fill("記事");
		await screen.getByLabelText("Linked side (plural)").fill("作者");
		await expect.element(dialog.getByText(SLUG_ERROR_REGEX)).toBeVisible();
		await expect.element(slug).not.toHaveAttribute("aria-invalid");

		await dialog.getByRole("button", { name: "Create Relation" }).click();

		await expect.element(dialog.getByText(SLUG_ERROR_REGEX)).toBeVisible();
		await expect.element(slug).toHaveAttribute("aria-invalid", "true");
		await expect.element(slug).toHaveFocus();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("refuses role names longer than the server allows", async () => {
		const onSubmit = vi.fn(async () => ({}));
		const screen = await render(<Harness onSubmit={onSubmit} />);

		await screen.getByRole("button", { name: "Define relation" }).click();
		const dialog = screen.getByRole("dialog", { name: "New Relation" });
		await dialog.getByRole("combobox", { name: "Links to", exact: true }).click();
		await page.getByRole("option", { name: "Authors" }).click();
		const plural = dialog.getByLabelText("Linking side (plural)");
		const singular = dialog.getByLabelText("Linked side (singular)");
		await plural.fill("p".repeat(201));
		await singular.fill("s".repeat(201));

		await dialog.getByRole("button", { name: "Create Relation" }).click();

		await expect.element(plural).toHaveAttribute("aria-invalid", "true");
		await expect.element(singular).toHaveAttribute("aria-invalid", "true");
		expect(dialog.getByText("Use 200 characters or fewer.").elements()).toHaveLength(2);
		await expect.element(plural).toHaveFocus();
		expect(onSubmit).not.toHaveBeenCalled();

		await plural.fill("Posts");
		await singular.fill("Author");
		await dialog.getByRole("button", { name: "Create Relation" }).click();
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
	});

	it("shows a slug another relation uses on the slug field", async () => {
		const onSubmit = vi.fn(async () => {
			throw new ApiResponseError(409, "CONFLICT", "A relation with this slug already exists");
		});
		const screen = await render(<Harness onSubmit={onSubmit} />);

		await screen.getByRole("button", { name: "Define relation" }).click();
		const dialog = screen.getByRole("dialog", { name: "New Relation" });
		await dialog.getByRole("combobox", { name: "Links to", exact: true }).click();
		await page.getByRole("option", { name: "Authors" }).click();
		await dialog.getByRole("button", { name: "Create Relation" }).click();

		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await expect.element(dialog.getByText(TAKEN_SLUG)).toBeVisible();
		await expect.element(slug).toHaveFocus();
		expect(dialog.getByText("A relation with this slug already exists").query()).toBeNull();

		await slug.fill("posts_writers");
		await expect.element(dialog.getByText(TAKEN_SLUG)).not.toBeInTheDocument();
	});

	it("keeps typed input through a press outside, and still closes on Cancel", async () => {
		const screen = await render(<Harness />);

		await screen.getByRole("button", { name: "Define relation" }).click();
		const dialog = screen.getByRole("dialog", { name: "New Relation" });
		await expect.element(dialog).toBeVisible();
		await screen.getByLabelText("Linked side (plural)").fill("Writers");

		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect.element(screen.getByLabelText("Linked side (plural)")).toHaveValue("Writers");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("closes on a press outside when nothing was typed", async () => {
		const screen = await render(<Harness />);

		await screen.getByRole("button", { name: "Define relation" }).click();
		const dialog = screen.getByRole("dialog", { name: "New Relation" });
		await expect.element(dialog).toBeVisible();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();
	});
});
