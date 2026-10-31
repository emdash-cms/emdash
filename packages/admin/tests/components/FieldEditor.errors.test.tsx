import {
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRouter,
} from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { ContentTypeEditor } from "../../src/components/ContentTypeEditor.js";
import { FieldEditor } from "../../src/components/FieldEditor.js";
import { fetchCollections, fetchRelations } from "../../src/lib/api";
import type { CreateFieldInput, SchemaCollectionWithFields, SchemaField } from "../../src/lib/api";
import { ApiResponseError } from "../../src/lib/api/client.js";
import type { BlockType } from "../../src/lib/api/schema.js";
import { pressOutside } from "../utils/mouse.ts";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
	return { ...actual, fetchCollections: vi.fn(), fetchRelations: vi.fn() };
});

const SHORT_TEXT = /^Short Text/;
const TAKEN_SLUG = "Another field already uses this slug. Enter a different one.";
const UNDERIVABLE_SLUG =
	"A slug cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.";

function Harness({
	field,
	onSave = vi.fn(),
}: {
	field?: SchemaField;
	onSave?: (input: CreateFieldInput) => void;
}) {
	const [open, setOpen] = React.useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open editor
			</button>
			<FieldEditor open={open} onOpenChange={setOpen} field={field} onSave={onSave} />
		</>
	);
}

async function openHarness(props: React.ComponentProps<typeof Harness> = {}) {
	const screen = await render(<Harness {...props} />);
	await screen.getByRole("button", { name: "Open editor" }).click();
	return screen;
}

async function chooseType(screen: Awaited<ReturnType<typeof openHarness>>, type: RegExp) {
	await screen
		.getByRole("dialog", { name: "Add Field" })
		.getByRole("button", { name: type })
		.click();
	const dialog = screen.getByRole("dialog", { name: "Configure Field" });
	await expect.element(dialog).toBeVisible();
	return dialog;
}

const existingField: SchemaField = {
	id: "field_01",
	collectionId: "col_01",
	slug: "excerpt",
	label: "Excerpt",
	type: "text",
	columnType: "TEXT",
	required: false,
	unique: false,
	searchable: false,
	indexed: false,
	sortOrder: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
};

describe("FieldEditor errors", () => {
	beforeEach(() => {
		vi.mocked(fetchCollections).mockResolvedValue([
			{ slug: "posts", label: "Posts", labelSingular: "Post" },
		] as Awaited<ReturnType<typeof fetchCollections>>);
		vi.mocked(fetchRelations).mockResolvedValue([]);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("points at every problem at once when submitted, and sends nothing until they are fixed", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^Number/);
		await dialog.getByLabelText("Min Value").fill("10");
		await dialog.getByLabelText("Max Value").fill("1");
		expect(dialog.getByText("Enter a label.").query()).toBeNull();

		await dialog.getByRole("button", { name: "Add Field" }).click();

		const label = dialog.getByLabelText("Label", { exact: true });
		await expect.element(dialog.getByText("Enter a label.")).toBeVisible();
		await expect
			.element(dialog.getByText("Enter a maximum that is at least the minimum."))
			.toBeVisible();
		await expect.element(label).toHaveAttribute("aria-invalid", "true");
		await expect
			.element(dialog.getByLabelText("Max Value"))
			.toHaveAttribute("aria-invalid", "true");
		await expect.element(label).toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();

		await label.fill("Rating");
		await expect.element(dialog.getByText("Enter a label.")).not.toBeInTheDocument();
		await dialog.getByLabelText("Max Value").fill("100");
		await expect
			.element(dialog.getByText("Enter a maximum that is at least the minimum."))
			.not.toBeInTheDocument();

		await dialog.getByRole("button", { name: "Add Field" }).click();
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ slug: "rating", validation: { min: 10, max: 100 } }),
		);
	});

	it("explains a pattern that is not a regular expression", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, SHORT_TEXT);
		await dialog.getByLabelText("Label", { exact: true }).fill("Code");
		await dialog.getByLabelText("Pattern (Regex)").fill("[A-Z");

		await dialog.getByRole("button", { name: "Add Field" }).click();

		await expect.element(dialog.getByText("Enter a valid regular expression.")).toBeVisible();
		await expect.element(dialog.getByLabelText("Pattern (Regex)")).toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("saves when Enter is pressed in a text field", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, SHORT_TEXT);
		await dialog.getByLabelText("Label", { exact: true }).fill("Subtitle");

		await userEvent.keyboard("{Enter}");

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ slug: "subtitle", label: "Subtitle" }),
		);
	});

	it("asks for an option before a select can be saved", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^Select Single choice/);
		await dialog.getByLabelText("Label", { exact: true }).fill("Mood");

		await dialog.getByRole("button", { name: "Add Field" }).click();

		const optionsInput = dialog.getByLabelText("Options (one per line)");
		await expect.element(dialog.getByText("Add at least one option.")).toBeVisible();
		await expect.element(optionsInput).toHaveAttribute("aria-invalid", "true");
		await expect.element(optionsInput).toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("saves an existing select that has no options", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({
			field: { ...existingField, slug: "mood", label: "Mood", type: "select" },
			onSave,
		});
		const dialog = screen.getByRole("dialog", { name: "Edit Field" });
		await dialog.getByLabelText("Label", { exact: true }).fill("Feeling");

		await dialog.getByRole("button", { name: "Update Field" }).click();

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ label: "Feeling" }));
		expect(dialog.getByText("Add at least one option.").query()).toBeNull();
	});

	it("drops a pattern typed for short text when the type changes", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const shortText = await chooseType(screen, SHORT_TEXT);
		await shortText.getByLabelText("Pattern (Regex)").fill("[A-Z");
		await shortText.getByRole("button", { name: "Change" }).click();
		const dialog = await chooseType(screen, /^Long Text/);
		await dialog.getByLabelText("Label", { exact: true }).fill("Notes");

		await dialog.getByRole("button", { name: "Add Field" }).click();

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ slug: "notes", type: "text", validation: null }),
		);
	});

	it("asks for the relationship of a new reference field", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^Reference/);
		const action = dialog.getByRole("button", { name: "Add Field" });
		await expect.element(action).toBeEnabled();

		await action.click();

		await expect.element(dialog.getByText("Choose a relationship.")).toBeVisible();
		await expect
			.element(dialog.getByRole("combobox", { name: "Relationship", exact: true }))
			.toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("asks for a sub-field before a repeater can be saved", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^Repeater/);
		await dialog.getByLabelText("Label", { exact: true }).fill("Steps");

		await dialog.getByRole("button", { name: "Add Field" }).click();

		await expect.element(dialog.getByRole("button", { name: "Add Sub-Field" })).toHaveFocus();
		await expect
			.element(dialog.getByRole("button", { name: "Add Sub-Field" }))
			.toHaveAccessibleDescription("Add at least one sub-field to define the repeater structure.");
		expect(onSave).not.toHaveBeenCalled();
	});

	it("asks for a block type before a blocks field can be saved", async () => {
		const blockTypes: BlockType[] = [
			{
				id: "hero-id",
				slug: "hero",
				label: "Hero",
				currentVersion: 1,
				source: "user",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				versions: [],
			},
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ success: true, data: { items: blockTypes } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
		);
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^Blocks/);
		await dialog.getByLabelText("Label", { exact: true }).fill("Layout");
		const hero = dialog.getByRole("checkbox", { name: "Hero" });
		await expect.element(hero).toBeVisible();

		await dialog.getByRole("button", { name: "Add Field" }).click();

		await expect.element(dialog.getByText("Choose at least one block type.")).toBeVisible();
		await expect.element(hero).toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();
	});

	it.each([
		{
			situation: "none exist",
			response: () => Response.json({ success: true, data: { items: [] } }),
			notice: "Create a block type before adding a blocks field.",
		},
		{
			situation: "they cannot be loaded",
			response: () =>
				Response.json(
					{ success: false, error: { code: "INTERNAL_ERROR", message: "Database unavailable" } },
					{ status: 500 },
				),
			notice: "Block types could not be loaded.",
		},
	])("saves a blocks field with no block types when $situation", async ({ response, notice }) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response()),
		);
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^Blocks/);
		await dialog.getByLabelText("Label", { exact: true }).fill("Layout");
		await expect.element(dialog.getByText(notice)).toBeVisible();

		await dialog.getByRole("button", { name: "Add Field" }).click();

		expect(dialog.getByText("Choose at least one block type.").query()).toBeNull();
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ slug: "layout", validation: { allowedTypes: [] } }),
		);
	});

	it("adds a type that was typed but never added when the field is saved", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^File File from/);
		await dialog.getByLabelText("Label", { exact: true }).fill("Attachment");
		const draft = dialog.getByRole("textbox", { name: "Add MIME type or extension" });
		await draft.fill("image/png");
		await userEvent.keyboard("{Enter}");
		await expect.element(dialog.getByText("image/png", { exact: true })).toBeVisible();
		await expect.element(draft).toHaveValue("");
		expect(onSave).not.toHaveBeenCalled();
		await draft.fill(".pdf");

		await dialog.getByRole("button", { name: "Add Field" }).click();

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				slug: "attachment",
				validation: { allowedMimeTypes: ["image/png", "application/pdf"] },
			}),
		);
	});

	it("refuses to save a typed type it cannot map, and points at it", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^File File from/);
		await dialog.getByLabelText("Label", { exact: true }).fill("Attachment");
		const draft = dialog.getByRole("textbox", { name: "Add MIME type or extension" });
		await draft.fill(".xyz");

		await dialog.getByRole("button", { name: "Add Field" }).click();

		const unmapped = 'Couldn\'t map ".xyz" to a MIME type. Type the MIME directly.';
		await expect.element(dialog.getByText(unmapped)).toBeVisible();
		await expect.element(draft).toHaveAttribute("aria-invalid", "true");
		await expect.element(draft).toHaveAccessibleDescription(unmapped);
		await expect.element(draft).toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("saves when Enter is pressed in the empty type input", async () => {
		const onSave = vi.fn();
		const screen = await openHarness({ onSave });
		const dialog = await chooseType(screen, /^File File from/);
		await dialog.getByLabelText("Label", { exact: true }).fill("Attachment");
		await dialog.getByRole("textbox", { name: "Add MIME type or extension" }).click();

		await userEvent.keyboard("{Enter}");

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ slug: "attachment" }));
	});

	it("explains a label no slug can be made from, as help first and as the error once submitted", async () => {
		const screen = await openHarness();
		const dialog = await chooseType(screen, SHORT_TEXT);
		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await dialog.getByLabelText("Label", { exact: true }).fill("عنوان");

		await expect.element(dialog.getByText(UNDERIVABLE_SLUG)).toBeVisible();
		await expect.element(slug).not.toHaveAttribute("aria-invalid");

		await dialog.getByRole("button", { name: "Add Field" }).click();

		await expect.element(slug).toHaveAttribute("aria-invalid", "true");
		await expect.element(slug).toHaveFocus();
	});

	it("keeps typed input through a press outside, and still closes on Cancel", async () => {
		const screen = await openHarness();
		const dialog = await chooseType(screen, SHORT_TEXT);
		await dialog.getByLabelText("Label", { exact: true }).fill("Subtitle");

		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByLabelText("Label", { exact: true })).toHaveValue("Subtitle");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("closes on a press outside before a type is chosen", async () => {
		const screen = await openHarness();
		const dialog = screen.getByRole("dialog", { name: "Add Field" });
		await expect.element(dialog).toBeVisible();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps an edited field open through a press outside", async () => {
		const screen = await openHarness({ field: existingField });
		const dialog = screen.getByRole("dialog", { name: "Edit Field" });
		await dialog.getByLabelText("Label", { exact: true }).fill("Summary");

		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByLabelText("Label", { exact: true })).toHaveValue("Summary");
	});

	it("closes an unchanged field on a press outside", async () => {
		const screen = await openHarness({ field: existingField });
		const dialog = screen.getByRole("dialog", { name: "Edit Field" });
		await expect.element(dialog).toBeVisible();

		await pressOutside();
		await expect.element(dialog).not.toBeInTheDocument();
	});
});

describe("FieldEditor errors from the server", () => {
	const collection: SchemaCollectionWithFields = {
		id: "col-1",
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		supports: ["drafts"],
		fields: [],
		hasSeo: false,
		routable: true,
		editLocking: true,
		commentsEnabled: false,
		commentsModeration: "first_time",
		commentsClosedAfterDays: 90,
		commentsAutoApproveUsers: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};

	beforeEach(() => {
		vi.mocked(fetchCollections).mockResolvedValue([]);
		vi.mocked(fetchRelations).mockResolvedValue([]);
	});

	async function addField(onAddField: (input: CreateFieldInput) => Promise<unknown>) {
		const router = createRouter({
			routeTree: createRootRoute({
				component: () => (
					<ContentTypeEditor collection={collection} onSave={vi.fn()} onAddField={onAddField} />
				),
			}),
			basepath: "/_emdash/admin",
			history: createMemoryHistory({ initialEntries: ["/_emdash/admin"] }),
		});
		const screen = await render(<RouterProvider router={router} />);
		await screen.getByRole("button", { name: "Add Field" }).first().click();
		await screen
			.getByRole("dialog", { name: "Add Field" })
			.getByRole("button", { name: SHORT_TEXT })
			.click();
		const dialog = screen.getByRole("dialog", { name: "Configure Field" });
		await dialog.getByLabelText("Label", { exact: true }).fill("Title");
		return dialog;
	}

	it("shows a slug another field uses on the slug field, once per double press", async () => {
		const onAddField = vi.fn(async () => {
			throw new ApiResponseError(
				409,
				"FIELD_EXISTS",
				'Field "title" already exists in collection "posts"',
			);
		});
		const dialog = await addField(onAddField);

		const action = dialog.getByRole("button", { name: "Add Field" }).element();
		action.click();
		action.click();

		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });
		await expect.element(dialog.getByText(TAKEN_SLUG)).toBeVisible();
		await expect.element(slug).toHaveAttribute("aria-invalid", "true");
		await expect.element(slug).toHaveFocus();
		expect(onAddField).toHaveBeenCalledTimes(1);
		expect(dialog.getByText(/already exists in collection/).query()).toBeNull();

		await slug.fill("title_2");
		await expect.element(dialog.getByText(TAKEN_SLUG)).not.toBeInTheDocument();
		expect(dialog.getByRole("alert").query()).toBeNull();
	});

	it("shows any other failure below the form until the form is changed", async () => {
		const onAddField = vi.fn(async () => {
			throw new ApiResponseError(500, "CREATE_FAILED", "Failed to create field");
		});
		const dialog = await addField(onAddField);

		await dialog.getByRole("button", { name: "Add Field" }).click();

		await expect.element(dialog.getByRole("alert")).toHaveTextContent("Failed to create field");
		await dialog.getByLabelText("Label", { exact: true }).fill("Headline");
		await expect.element(dialog.getByRole("alert")).not.toBeInTheDocument();
	});

	it("reports a refused slug below the form when the slug changed during the save", async () => {
		let refuse!: () => void;
		const onAddField = vi.fn(
			() =>
				new Promise((_, reject) => {
					refuse = () =>
						reject(
							new ApiResponseError(
								409,
								"FIELD_EXISTS",
								'Field "title" already exists in collection "posts"',
							),
						);
				}),
		);
		const dialog = await addField(onAddField);
		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });

		await dialog.getByRole("button", { name: "Add Field" }).click();
		await expect.element(dialog.getByRole("button", { name: "Saving..." })).toBeVisible();
		await slug.fill("title_2");
		refuse();

		await expect
			.element(dialog.getByRole("alert"))
			.toHaveTextContent('Field "title" already exists in collection "posts"');
		await expect.element(slug).not.toHaveAttribute("aria-invalid");
	});

	it("shows a failure that comes back after an edit made during the save", async () => {
		let refuse!: () => void;
		const onAddField = vi.fn(
			() =>
				new Promise((_, reject) => {
					refuse = () =>
						reject(new ApiResponseError(500, "CREATE_FAILED", "Failed to create field"));
				}),
		);
		const dialog = await addField(onAddField);

		await dialog.getByRole("button", { name: "Add Field" }).click();
		await expect.element(dialog.getByRole("button", { name: "Saving..." })).toBeVisible();
		await dialog.getByLabelText("Label", { exact: true }).fill("Headline");
		refuse();

		await expect.element(dialog.getByRole("alert")).toHaveTextContent("Failed to create field");
	});
});
