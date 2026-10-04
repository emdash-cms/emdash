import {
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRouter,
} from "@tanstack/react-router";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { FieldEditor } from "../../src/components/FieldEditor";
import { fetchCollections, fetchRelations } from "../../src/lib/api";
import type { SchemaField } from "../../src/lib/api";
import type { RelationWithUsage } from "../../src/lib/api/relations.js";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
	return { ...actual, fetchCollections: vi.fn(), fetchRelations: vi.fn() };
});

function renderInRouter(ui: React.ReactElement) {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => ui }),
		basepath: "/_emdash/admin",
		history: createMemoryHistory({ initialEntries: ["/_emdash/admin"] }),
	});
	return render(<RouterProvider router={router} />);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_TYPE_REGEXES = [
	/Short Text/,
	/Long Text/,
	/Number Decimal number/,
	/Integer Whole number/,
	/Boolean True\/false toggle/,
	/Date & Time/,
	/^Select Single choice/,
	/Multi Select/,
	/Rich Text/,
	/Image/,
	/^File File from/,
	/Reference/,
	/JSON/,
	/Slug URL-friendly/,
];

const SHORT_TEXT_REGEX = /Short Text/;
const LONG_TEXT_REGEX = /Long Text/;
const BOOLEAN_REGEX = /Boolean/;
const RICH_TEXT_REGEX = /Rich Text Rich text editor/;

function makeField(overrides: Partial<SchemaField> = {}): SchemaField {
	return {
		id: "field_01",
		collectionId: "col_01",
		slug: "title",
		label: "Title",
		type: "string",
		columnType: "TEXT",
		required: true,
		unique: false,
		searchable: true,
		indexed: false,
		sortOrder: 0,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

// The kumo Dialog renders a `data-base-ui-inert` overlay that blocks pointer
// events inside the dialog in Playwright's actionability checks. Assertions
// (toBeInTheDocument, toHaveValue, etc.) work fine; only click() is blocked.
//
// Strategy:
// - Type selection step: assert type buttons exist (no clicking needed)
// - Config step: use edit mode (pass field prop) to go directly to config
// - onSave/callbacks: use edit mode fields to test form submission

describe("FieldEditor", () => {
	const defaultProps = {
		open: true,
		onOpenChange: vi.fn(),
		onSave: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchCollections).mockResolvedValue([
			{ slug: "posts", label: "Posts", labelSingular: "Post" },
			{ slug: "authors", label: "Authors", labelSingular: "Author" },
			{ slug: "pages", label: "Pages", labelSingular: "Page" },
		] as Awaited<ReturnType<typeof fetchCollections>>);
		vi.mocked(fetchRelations).mockResolvedValue([]);
	});

	describe("type selection step", () => {
		it("shows type selection grid when creating new field", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} />);
			await expect.element(screen.getByText("Add Field")).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: SHORT_TEXT_REGEX }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: LONG_TEXT_REGEX }))
				.toBeInTheDocument();
			await expect.element(screen.getByRole("button", { name: BOOLEAN_REGEX })).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: RICH_TEXT_REGEX }))
				.toBeInTheDocument();
		});

		it("shows all 14 field types as buttons", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} />);
			// Each type renders as a button with label and description
			for (const name of FIELD_TYPE_REGEXES) {
				await expect.element(screen.getByRole("button", { name })).toBeInTheDocument();
			}
		});

		it("does not show config form on initial render", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} />);
			// Label and Slug inputs should NOT be present in type selection step
			expect(screen.getByLabelText("Label").query()).toBeNull();
			expect(screen.getByLabelText("Slug").query()).toBeNull();
		});
	});

	describe("config step (string field)", () => {
		// Use a minimal string field to go directly to config step
		const stringField = makeField({
			slug: "",
			label: "",
			type: "string",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows Configure Field title for string type", async () => {
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} field={makeField({ type: "string" })} />,
			);
			await expect.element(screen.getByText("Edit Field")).toBeInTheDocument();
		});

		it("shows label and slug inputs", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByLabelText("Label")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Slug")).toBeInTheDocument();
		});

		it("shows searchable checkbox for string type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByText("Searchable")).toBeInTheDocument();
			await expect.element(screen.getByText("Indexed")).toBeInTheDocument();
		});

		it("shows min/max length validation for string type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByText("Validation")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Min Length")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Max Length")).toBeInTheDocument();
		});

		it("shows pattern input for string type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByLabelText("Pattern (Regex)")).toBeInTheDocument();
		});

		it("shows required and unique checkboxes", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={stringField} />);
			await expect.element(screen.getByText("Required")).toBeInTheDocument();
			await expect.element(screen.getByText("Unique")).toBeInTheDocument();
		});
	});

	describe("config step (number field)", () => {
		const numberField = makeField({
			slug: "",
			label: "",
			type: "number",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows min/max value for number type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={numberField} />);
			await expect.element(screen.getByLabelText("Min Value")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Max Value")).toBeInTheDocument();
			await expect.element(screen.getByText("Indexed")).toBeInTheDocument();
		});

		it("does not show searchable for number type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={numberField} />);
			expect(screen.getByText("Searchable").query()).toBeNull();
		});

		it("does not show pattern for number type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={numberField} />);
			expect(screen.getByLabelText("Pattern (Regex)").query()).toBeNull();
		});

		it("does not show min/max length for number type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={numberField} />);
			expect(screen.getByLabelText("Min Length").query()).toBeNull();
			expect(screen.getByLabelText("Max Length").query()).toBeNull();
		});
	});

	describe("config step (text field)", () => {
		const textField = makeField({
			slug: "",
			label: "",
			type: "text",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows min/max length but no pattern for text type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={textField} />);
			await expect.element(screen.getByLabelText("Min Length")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Max Length")).toBeInTheDocument();
			expect(screen.getByLabelText("Pattern (Regex)").query()).toBeNull();
		});

		it("shows searchable checkbox for text type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={textField} />);
			await expect.element(screen.getByText("Searchable")).toBeInTheDocument();
			expect(screen.getByText("Indexed").query()).toBeNull();
		});
	});

	describe("config step (select field)", () => {
		const selectField = makeField({
			slug: "",
			label: "",
			type: "select",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows options textarea for select type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={selectField} />);
			await expect.element(screen.getByText("Options (one per line)")).toBeInTheDocument();
			// Textarea should have the placeholder
			await expect.element(screen.getByPlaceholder("Option 1")).toBeInTheDocument();
		});
	});

	describe("config step (multiSelect field)", () => {
		const multiSelectField = makeField({
			slug: "",
			label: "",
			type: "multiSelect",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows options textarea for multi-select type", async () => {
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} field={multiSelectField} />,
			);
			await expect.element(screen.getByText("Options (one per line)")).toBeInTheDocument();
			await expect.element(screen.getByPlaceholder("Option 1")).toBeInTheDocument();
		});
	});

	describe("edit mode", () => {
		const existingField = makeField({
			validation: { maxLength: 200 },
		});

		it("skips type selection and shows config directly", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByText("Edit Field")).toBeInTheDocument();
			await expect.element(screen.getByLabelText("Label")).toHaveValue("Title");
		});

		it("disables slug input in edit mode", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByLabelText("Slug")).toBeDisabled();
		});

		it("shows hint about slug immutability", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			await expect
				.element(screen.getByText("Field slugs cannot be changed after creation"))
				.toBeInTheDocument();
		});

		it("does not show Change button in edit mode", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			expect(screen.getByRole("button", { name: "Change" }).query()).toBeNull();
		});

		it("shows Update Field button instead of Add Field", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			await expect
				.element(screen.getByRole("button", { name: "Update Field" }))
				.toBeInTheDocument();
		});

		it("pre-populates validation values", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByLabelText("Max Length")).toHaveValue(200);
		});

		it("pre-populates slug value", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByLabelText("Slug")).toHaveValue("title");
		});

		it("pre-populates required checkbox", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			// The Required checkbox text should be present (the field has required: true)
			await expect.element(screen.getByText("Required")).toBeInTheDocument();
		});

		it("does not auto-generate slug when editing label in edit mode", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			await screen.getByLabelText("Label").fill("New Label");
			// Slug should remain "title", not change to "new_label"
			await expect.element(screen.getByLabelText("Slug")).toHaveValue("title");
		});

		it("shows type indicator with field type info", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={existingField} />);
			await expect.element(screen.getByText("Short Text")).toBeInTheDocument();
			await expect.element(screen.getByText("Single line text input")).toBeInTheDocument();
		});
	});

	describe("saving state", () => {
		it("shows Saving... when isSaving is true", async () => {
			const field = makeField();
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} isSaving={true} field={field} />,
			);
			await expect.element(screen.getByText("Saving...")).toBeInTheDocument();
		});

		it("disables cancel button when saving", async () => {
			const field = makeField();
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} isSaving={true} field={field} />,
			);
			await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		});

		it("disables update button when saving", async () => {
			const field = makeField();
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} isSaving={true} field={field} />,
			);
			await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
		});
	});

	describe("button state", () => {
		it("disables save button when label is empty", async () => {
			const field = makeField({ slug: "test", label: "" });
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={field} />);
			await expect.element(screen.getByRole("button", { name: "Update Field" })).toBeDisabled();
		});

		it("enables save button when label and slug are filled", async () => {
			const field = makeField({ slug: "test", label: "Test" });
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={field} />);
			await expect.element(screen.getByRole("button", { name: "Update Field" })).toBeEnabled();
		});
	});

	describe("indexed flag", () => {
		const save = async (screen: Awaited<ReturnType<typeof render>>) => {
			const button = screen.getByRole("button", { name: "Update Field" });
			await expect.element(button).toBeEnabled();
			button.element().click();
		};

		it("clears the flag when the field type cannot be indexed", async () => {
			const onSave = vi.fn();
			const field = makeField({ slug: "body", label: "Body", type: "text", indexed: true });
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} field={field} onSave={onSave} />,
			);

			expect(screen.getByText("Indexed").query()).toBeNull();
			await save(screen);

			expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ indexed: false }));
		});

		it("keeps the flag for a field type that can be indexed", async () => {
			const onSave = vi.fn();
			const field = makeField({ slug: "priority", label: "Priority", indexed: true });
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} field={field} onSave={onSave} />,
			);

			await save(screen);

			expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ indexed: true }));
		});

		it("hides and clears the flag for a storage-less reference field", async () => {
			const onSave = vi.fn();
			const field = makeField({
				slug: "related",
				label: "Related",
				type: "reference",
				indexed: true,
				validation: { targetCollection: "posts", multiple: true },
			});
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} field={field} onSave={onSave} />,
			);

			expect(screen.getByText("Indexed").query()).toBeNull();
			await save(screen);

			expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ indexed: false }));
		});
	});

	describe("reference field that predates relations", () => {
		const legacyField = makeField({
			slug: "author",
			label: "Author",
			type: "reference",
			required: false,
			searchable: false,
			options: { collection: "authors" },
		});

		const boundField = makeField({
			slug: "author",
			label: "Author",
			type: "reference",
			required: false,
			searchable: false,
			validation: { relation: "posts_author", targetCollection: "authors" },
		});

		it("shows the collection its options named, so it can be confirmed", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={legacyField} />);

			await expect
				.element(screen.getByRole("combobox", { name: "Referenced collection" }))
				.toBeEnabled();
			await expect
				.element(screen.getByText(/Saving a collection here turns this field into an entry picker/))
				.toBeInTheDocument();
		});

		it("keeps a bound field's collection immutable", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={boundField} />);

			await expect
				.element(screen.getByRole("combobox", { name: "Referenced collection" }))
				.toBeDisabled();
			await expect
				.element(
					screen.getByText(/The relationship and the referenced collection cannot be changed/),
				)
				.toBeInTheDocument();
		});

		it("sends the collection on save so the server can bind the field", async () => {
			const onSave = vi.fn();
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} field={legacyField} onSave={onSave} />,
			);

			const button = screen.getByRole("button", { name: "Update Field" });
			await expect.element(button).toBeEnabled();
			button.element().click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					validation: expect.objectContaining({ targetCollection: "authors" }),
				}),
			);
		});
	});

	describe("binding a reference field to an existing relationship", () => {
		const relationField = makeField({
			slug: "author",
			label: "Author",
			type: "reference",
			required: false,
			searchable: false,
		});

		function relation(overrides: Partial<RelationWithUsage> = {}): RelationWithUsage {
			return {
				id: "rel-1",
				slug: "posts_authors",
				parentCollection: "posts",
				childCollection: "authors",
				parentLabel: "Posts",
				parentLabelSingular: "Post",
				childLabel: "Authors",
				childLabelSingular: "Author",
				maxChildrenPerParent: 1,
				maxParentsPerChild: null,
				boundFields: [],
				linkCount: 0,
				...overrides,
			};
		}

		async function openWithRelations(
			relations: RelationWithUsage[],
			props: Partial<React.ComponentProps<typeof FieldEditor>> = {},
		) {
			vi.mocked(fetchRelations).mockResolvedValue(relations);
			return renderInRouter(
				<FieldEditor {...defaultProps} field={relationField} collectionSlug="posts" {...props} />,
			);
		}

		/** Kumo's Select is a combobox button over a listbox; the dialog's inert
		 * overlay blocks Playwright's actionability checks, so drive it through
		 * the DOM as the other dialog tests do. */
		async function choose(
			screen: Awaited<ReturnType<typeof openWithRelations>>,
			label: string,
			option: string,
		) {
			const trigger = screen.getByRole("combobox", { name: label });
			await expect.element(trigger).toBeInTheDocument();
			trigger.element().click();
			await vi.waitFor(() => {
				screen.getByRole("option", { name: option, exact: true }).element().click();
			});
		}

		it("offers a relationship this collection can still bind to", async () => {
			const screen = await openWithRelations([relation()]);

			await expect
				.element(screen.getByRole("combobox", { name: "Relationship" }))
				.toBeInTheDocument();
		});

		// Quick create is a choice even with nothing to choose between, because it
		// is what tells the user a relationship is being made for them and where
		// to go to make one themselves.
		it("offers quick create and the relation editor when no relationship is bindable", async () => {
			const screen = await openWithRelations([]);

			await expect
				.element(screen.getByRole("combobox", { name: "Relationship" }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("link", { name: "Create the relationship yourself" }))
				.toHaveAttribute("href", "/_emdash/admin/content-types/relations");
		});

		// Both ends of this relation already have a field, so a third picker over
		// the same links has nowhere to go.
		it("leaves out a relationship whose ends are already picked from", async () => {
			const screen = await openWithRelations([
				relation({
					boundFields: [
						{ collectionSlug: "posts", fieldSlug: "author", side: "parent" },
						{ collectionSlug: "authors", fieldSlug: "posts", side: "child" },
					],
				}),
			]);

			const trigger = screen.getByRole("combobox", { name: "Relationship" });
			await expect.element(trigger).toBeInTheDocument();
			trigger.element().click();

			await expect
				.element(screen.getByRole("option", { name: "Quick create a relationship" }))
				.toBeInTheDocument();
			expect(screen.getByRole("option", { name: "posts_authors" }).query()).toBeNull();
		});

		it("derives the side and sends it with the relationship", async () => {
			const onSave = vi.fn();
			const screen = await openWithRelations([relation()], { onSave });

			await choose(screen, "Relationship", "posts_authors");
			await expect
				.element(screen.getByText(/This field will show the Authors this Post links to/))
				.toBeInTheDocument();

			screen.getByRole("button", { name: "Update Field" }).element().click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					validation: expect.objectContaining({
						relation: "posts_authors",
						relationSide: "parent",
					}),
				}),
			);
		});

		it("derives the child side when this collection is the linked end", async () => {
			const onSave = vi.fn();
			const screen = await openWithRelations(
				[relation({ parentCollection: "pages", childCollection: "posts" })],
				{ onSave },
			);

			await choose(screen, "Relationship", "posts_authors");
			await expect
				.element(screen.getByText(/This field will show the Post linking to this Author/))
				.toBeInTheDocument();

			screen.getByRole("button", { name: "Update Field" }).element().click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					validation: expect.objectContaining({ relationSide: "child" }),
				}),
			);
		});

		// Both ends are this collection, so neither is implied by the schema.
		it("offers the side as a choice on a self-referential relationship", async () => {
			const onSave = vi.fn();
			const screen = await openWithRelations(
				[relation({ slug: "posts_related", parentCollection: "posts", childCollection: "posts" })],
				{ onSave },
			);

			await choose(screen, "Relationship", "posts_related");
			await choose(screen, "This field picks", "Entries that link to this one");

			screen.getByRole("button", { name: "Update Field" }).element().click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					validation: expect.objectContaining({
						relation: "posts_related",
						relationSide: "child",
					}),
				}),
			);
		});

		// The relationship owns the target and the limits, so sending a target
		// collection alongside it would let the two disagree.
		it("sends no target collection when a relationship is chosen", async () => {
			const onSave = vi.fn();
			const screen = await openWithRelations([relation()], { onSave });

			await choose(screen, "Relationship", "posts_authors");
			screen.getByRole("button", { name: "Update Field" }).element().click();

			const validation = onSave.mock.calls[0]?.[0]?.validation as Record<string, unknown>;
			expect(validation.targetCollection).toBeUndefined();
			expect(validation.multiple).toBeUndefined();
		});

		it("still creates a relationship when none is chosen", async () => {
			const onSave = vi.fn();
			const screen = await openWithRelations([relation()], { onSave });

			await choose(screen, "Referenced collection", "Authors");
			screen.getByRole("button", { name: "Update Field" }).element().click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					validation: expect.objectContaining({ targetCollection: "authors" }),
				}),
			);
		});
	});

	describe("config step (file field)", () => {
		const fileField = makeField({
			slug: "attachment",
			label: "Attachment",
			type: "file",
			required: false,
			unique: false,
			searchable: false,
		});

		it("shows AllowedTypesEditor for file type", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={fileField} />);
			await expect.element(screen.getByText("Allowed types")).toBeInTheDocument();
		});

		it("shows AllowedTypesEditor for image type", async () => {
			const imageField = makeField({
				slug: "cover",
				label: "Cover",
				type: "image",
				required: false,
				unique: false,
				searchable: false,
			});
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={imageField} />);
			await expect.element(screen.getByText("Allowed types")).toBeInTheDocument();
		});

		it("pre-populates allowedMimeTypes from existing field validation", async () => {
			const fieldWithMimes = makeField({
				slug: "document",
				label: "Document",
				type: "file",
				required: false,
				unique: false,
				searchable: false,
				validation: { allowedMimeTypes: ["application/pdf"] },
			});
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={fieldWithMimes} />);
			await expect.element(screen.getByText("application/pdf")).toBeInTheDocument();
		});
	});

	describe("dark mode variant option (image field)", () => {
		const imageField = makeField({
			slug: "cover",
			label: "Cover",
			type: "image",
			required: false,
			unique: false,
			searchable: false,
		});

		const save = async (screen: Awaited<ReturnType<typeof render>>) => {
			const button = screen.getByRole("button", { name: "Update Field" });
			await expect.element(button).toBeEnabled();
			button.element().click();
		};

		it("is absent for file fields", async () => {
			const fileField = makeField({ ...imageField, slug: "attachment", type: "file" });
			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={fileField} />);

			expect(screen.getByRole("switch", { name: "Dark mode variant" }).query()).toBeNull();
		});

		it("saves the option when switched on", async () => {
			const onSave = vi.fn();
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} field={imageField} onSave={onSave} />,
			);

			const toggle = screen.getByRole("switch", { name: "Dark mode variant" });
			await expect.element(toggle).not.toBeChecked();
			toggle.element().click();
			await expect.element(toggle).toBeChecked();
			await save(screen);

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ options: { darkVariant: true } }),
			);
		});

		it("removes only the option when switched off and keeps other widget options", async () => {
			const onSave = vi.fn();
			const field = makeField({ ...imageField, options: { showPreview: true, darkVariant: true } });
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} field={field} onSave={onSave} />,
			);

			const toggle = screen.getByRole("switch", { name: "Dark mode variant" });
			await expect.element(toggle).toBeChecked();
			toggle.element().click();
			await expect.element(toggle).not.toBeChecked();
			await save(screen);

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ options: { showPreview: true } }),
			);
		});
	});

	// ---- A new reference field ----

	// The relationship comes first: it decides what the field points at, how
	// many entries it holds, and what it is called.
	describe("a new reference field", () => {
		function relation(overrides: Partial<RelationWithUsage> = {}): RelationWithUsage {
			return {
				id: "rel-1",
				slug: "chapters_lessons",
				parentCollection: "chapters",
				childCollection: "lessons",
				parentLabel: "Chapters",
				parentLabelSingular: "Chapter",
				childLabel: "Lessons",
				childLabelSingular: null,
				maxChildrenPerParent: null,
				maxParentsPerChild: null,
				boundFields: [],
				linkCount: 0,
				...overrides,
			};
		}

		/** Opens the dialog on a new field and picks the reference type. */
		async function openReferenceField(
			relations: RelationWithUsage[],
			props: Partial<React.ComponentProps<typeof FieldEditor>> = {},
		) {
			vi.mocked(fetchRelations).mockResolvedValue(relations);
			vi.mocked(fetchCollections).mockResolvedValue([
				{ slug: "chapters", label: "Chapters", labelSingular: "Chapter" },
				{ slug: "lessons", label: "Lessons" },
			] as Awaited<ReturnType<typeof fetchCollections>>);
			const screen = await renderInRouter(
				<FieldEditor {...defaultProps} collectionSlug="chapters" {...props} />,
			);
			screen
				.getByRole("button", { name: /^Reference/ })
				.element()
				.click();
			await expect
				.element(screen.getByRole("combobox", { name: "Relationship" }))
				.toBeInTheDocument();
			return screen;
		}

		async function choose(
			screen: Awaited<ReturnType<typeof openReferenceField>>,
			label: string,
			option: string,
		) {
			const trigger = screen.getByRole("combobox", { name: label, exact: true });
			await expect.element(trigger).toBeInTheDocument();
			trigger.element().click();
			await vi.waitFor(() => {
				screen.getByRole("option", { name: option, exact: true }).element().click();
			});
			await vi.waitFor(() => {
				if (trigger.element().getAttribute("aria-expanded") !== "false") {
					throw new Error(`The ${label} list is still open`);
				}
			});
		}

		it("asks for the relationship before the field itself", async () => {
			const screen = await openReferenceField([relation()]);

			expect(screen.getByLabelText("Label").query()).toBeNull();

			await choose(screen, "Relationship", "chapters_lessons");

			await expect.element(screen.getByLabelText("Label")).toBeInTheDocument();
		});

		it("names the field after the side it picks", async () => {
			const onSave = vi.fn();
			const screen = await openReferenceField([relation()], { onSave });

			await choose(screen, "Relationship", "chapters_lessons");

			await expect.element(screen.getByLabelText("Label")).toHaveValue("Lessons");
			await expect.element(screen.getByLabelText("Slug", { exact: true })).toHaveValue("lessons");

			screen.getByRole("button", { name: "Add Field" }).element().click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					slug: "lessons",
					label: "Lessons",
					validation: expect.objectContaining({
						relation: "chapters_lessons",
						relationSide: "parent",
					}),
				}),
			);
		});

		// The singular of the linked side is not recorded here, so it is
		// singularized the way a collection's is.
		it("says what each side of the relationship will show", async () => {
			const screen = await openReferenceField([
				relation({ parentCollection: "chapters", childCollection: "chapters" }),
			]);

			await choose(screen, "Relationship", "chapters_lessons");
			await expect
				.element(screen.getByText(/This field will show the Lessons this Chapter links to/))
				.toBeInTheDocument();

			await choose(screen, "This field picks", "Entries that link to this one");
			await expect
				.element(screen.getByText(/This field will show the Chapter linking to this Lesson/))
				.toBeInTheDocument();
			await expect.element(screen.getByLabelText("Label")).toHaveValue("Chapters");
		});

		// A field whose relationship does not exist yet makes it here, rather
		// than being sent to another page half-filled.
		it("creates the relationship it needs and comes back with it picked", async () => {
			const onCreateRelation = vi.fn(async () => relation());
			const screen = await openReferenceField([], { onCreateRelation });

			await choose(screen, "Relationship", "Create relation");
			screen.getByRole("button", { name: "Next" }).element().click();

			await expect.element(screen.getByText("New Relation")).toBeInTheDocument();
			await choose(screen, "Links to", "Lessons");
			await screen.getByLabelText("Linked side (plural)").fill("Lessons");
			screen.getByRole("button", { name: "Create Relation" }).element().click();

			await vi.waitFor(() => expect(onCreateRelation).toHaveBeenCalledTimes(1));
			await expect
				.element(screen.getByRole("combobox", { name: "Relationship" }))
				.toHaveTextContent("chapters_lessons");
			await expect.element(screen.getByLabelText("Label")).toHaveValue("Lessons");
		});
	});

	describe("dialog closed", () => {
		it("renders nothing visible when open is false", async () => {
			const screen = await renderInRouter(<FieldEditor {...defaultProps} open={false} />);
			expect(screen.getByText("Add Field").query()).toBeNull();
		});
	});

	describe("scrollable config dialog", () => {
		it("bounds the config content so save actions remain reachable with many repeater sub-fields", async () => {
			const subFields = Array.from({ length: 20 }, (_, i) => ({
				slug: `item_${i}`,
				type: "string",
				label: `Item ${i}`,
				required: false,
			}));
			const field = makeField({
				type: "repeater",
				validation: { subFields } as SchemaField["validation"],
			});

			const screen = await renderInRouter(<FieldEditor {...defaultProps} field={field} />);
			const content = document.querySelector('[data-testid="field-editor-config-content"]');

			expect(content).not.toBeNull();
			expect(content!.classList.contains("max-h-[60vh]")).toBe(true);
			expect(content!.classList.contains("overflow-y-auto")).toBe(true);
			expect(
				content!.contains(screen.getByRole("button", { name: "Update Field" }).element()),
			).toBe(false);
		});
	});
});
