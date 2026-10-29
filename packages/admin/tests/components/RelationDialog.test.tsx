import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { RelationDialog } from "../../src/components/RelationDialog.js";
import type { SchemaCollection } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

const collections = [
	{ slug: "posts", label: "Posts", labelSingular: "Post" },
	{ slug: "authors", label: "Authors" },
] as SchemaCollection[];

function Harness({
	initialCollections = collections,
}: {
	initialCollections?: SchemaCollection[];
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
				onSubmit={vi.fn(async () => ({}))}
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
});
