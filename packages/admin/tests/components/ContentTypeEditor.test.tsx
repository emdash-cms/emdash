import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import {
	ContentTypeEditor,
	type ContentTypeEditorProps,
} from "../../src/components/ContentTypeEditor";
import type { SchemaCollectionWithFields, SchemaField } from "../../src/lib/api";
import { render } from "../utils/render.js";

// Regexes hoisted to module scope to avoid recompilation per call
const EDIT_TITLE_RE = /Edit Title field/i;
const EDIT_BODY_RE = /Edit Body field/i;
const URL_PATTERN_SLUG_RE = /must include.*\{slug\}/i;

// Mock tanstack router — Link renders as <a>, useNavigate is a no-op
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
		useNavigate: () => vi.fn(),
	};
});

// Mock FieldEditor — just expose open state via data attribute
vi.mock("../../src/components/FieldEditor", () => ({
	FieldEditor: ({ open }: { open: boolean }) =>
		open ? <div data-testid="field-editor-dialog">Field Editor</div> : null,
}));

const DELETE_FIELD_BUTTON_PATTERN = /Delete Title field/i;

function makeField(overrides: Partial<SchemaField> = {}): SchemaField {
	return {
		id: "field-1",
		collectionId: "col-1",
		slug: "title",
		label: "Title",
		type: "string",
		columnType: "TEXT",
		required: false,
		unique: false,
		searchable: false,
		sortOrder: 0,
		createdAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

function makeCollection(
	overrides: Partial<SchemaCollectionWithFields> = {},
): SchemaCollectionWithFields {
	return {
		id: "col-1",
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		description: "Blog posts",
		supports: ["drafts"],
		fields: [],
		hasSeo: false,
		commentsEnabled: false,
		commentsModeration: "first_time",
		commentsClosedAfterDays: 90,
		commentsAutoApproveUsers: true,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

const noop = () => {};

function defaultProps(overrides: Partial<ContentTypeEditorProps> = {}): ContentTypeEditorProps {
	return {
		onSave: noop,
		onAddField: noop,
		onUpdateField: noop,
		onDeleteField: noop,
		onReorderFields: noop,
		...overrides,
	};
}

const DRAFTS_CHECKBOX_REGEX = /Drafts/i;
const REVISIONS_CHECKBOX_REGEX = /Revisions/i;
const SAVE_CHANGES_BUTTON_REGEX = /Save Changes/i;
const CREATE_CONTENT_TYPE_BUTTON_REGEX = /Create Content Type/i;
const EDIT_FIELD_BUTTON_REGEX = /Edit .* field/i;
const DELETE_FIELD_BUTTON_REGEX = /Delete .* field/i;
const ADD_FIELD_BUTTON_REGEX = /Add Field/i;
const SAVING_BUTTON_REGEX = /Saving/i;
const CODE_DEFINED_MSG_REGEX = /This collection is defined in code/i;
const SYSTEM_FIELDS_REGEX = /6 system \+ 2 custom fields/;

describe("ContentTypeEditor", () => {
	// ---- Title for new vs edit mode ----

	it("shows 'New Content Type' title when isNew", async () => {
		const screen = await render(<ContentTypeEditor {...defaultProps()} isNew />);
		await expect.element(screen.getByText("New Content Type")).toBeInTheDocument();
	});

	it("shows collection label as title when editing", async () => {
		const collection = makeCollection({ label: "Articles" });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);
		await expect.element(screen.getByText("Articles")).toBeInTheDocument();
	});

	// ---- Auto-slug from label when isNew ----

	it("auto-generates slug from label when isNew", async () => {
		const screen = await render(<ContentTypeEditor {...defaultProps()} isNew />);

		const labelInput = screen.getByLabelText("Label (Plural)");
		await labelInput.fill("Blog Posts");

		// The slug input should auto-populate from the label
		const slugInput = screen.getByLabelText("Slug");
		await expect.element(slugInput).toHaveValue("blog_posts");
	});

	// ---- Slug disabled when editing ----

	it("does not show slug input when editing existing collection", async () => {
		const collection = makeCollection();
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		// Slug input is only rendered when isNew, so it shouldn't exist
		const slugInput = screen.getByLabelText("Slug");
		await expect.element(slugInput).not.toBeInTheDocument();
	});

	// ---- Supports checkboxes toggle correctly ----

	it("toggles support checkboxes", async () => {
		const collection = makeCollection({ supports: ["drafts"] });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		// "Drafts" should be checked initially
		const draftsCheckbox = screen.getByRole("checkbox", { name: DRAFTS_CHECKBOX_REGEX });
		await expect.element(draftsCheckbox).toBeChecked();

		// "Revisions" should not be checked
		const revisionsCheckbox = screen.getByRole("checkbox", { name: REVISIONS_CHECKBOX_REGEX });
		await expect.element(revisionsCheckbox).not.toBeChecked();

		// Toggle revisions on
		await revisionsCheckbox.click();
		await expect.element(revisionsCheckbox).toBeChecked();

		// Toggle drafts off
		await draftsCheckbox.click();
		await expect.element(draftsCheckbox).not.toBeChecked();
	});

	// ---- Save button disabled when no changes ----

	it("save button is disabled when no changes have been made", async () => {
		const collection = makeCollection();
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		const saveButton = screen.getByRole("button", { name: SAVE_CHANGES_BUTTON_REGEX });
		await expect.element(saveButton).toBeDisabled();
	});

	// ---- Save button enabled after changing a field ----

	it("save button is enabled after changing label", async () => {
		const collection = makeCollection({ label: "Posts" });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		const labelInput = screen.getByLabelText("Label (Plural)");
		await labelInput.fill("Articles");

		const saveButton = screen.getByRole("button", { name: SAVE_CHANGES_BUTTON_REGEX });
		await expect.element(saveButton).toBeEnabled();
	});

	// ---- onSave called with correct input shape ----

	it("calls onSave with correct input when creating new collection", async () => {
		const onSave = vi.fn();
		const screen = await render(<ContentTypeEditor {...defaultProps({ onSave })} isNew />);

		await screen.getByLabelText("Label (Plural)").fill("Articles");
		await screen.getByLabelText("Label (Singular)").fill("Article");

		const createButton = screen.getByRole("button", { name: CREATE_CONTENT_TYPE_BUTTON_REGEX });
		await createButton.click();

		expect(onSave).toHaveBeenCalledWith({
			slug: "articles",
			label: "Articles",
			labelSingular: "Article",
			description: undefined,
			urlPattern: undefined,
			supports: ["drafts"], // default
			hasSeo: false,
		});
	});

	it("calls onSave with correct input when editing existing collection", async () => {
		const onSave = vi.fn();
		const collection = makeCollection({ label: "Posts", supports: ["drafts"] });
		const screen = await render(
			<ContentTypeEditor {...defaultProps({ onSave })} collection={collection} />,
		);

		await screen.getByLabelText("Label (Plural)").fill("Articles");

		const saveButton = screen.getByRole("button", { name: SAVE_CHANGES_BUTTON_REGEX });
		await saveButton.click();

		expect(onSave).toHaveBeenCalledWith({
			label: "Articles",
			labelSingular: "Post",
			description: "Blog posts",
			urlPattern: undefined,
			supports: ["drafts"],
			hasSeo: false,
			commentsEnabled: false,
			commentsModeration: "first_time",
			commentsClosedAfterDays: 90,
			commentsAutoApproveUsers: true,
		});
	});

	// ---- Field list displays existing fields with type and badges ----

	it("displays custom fields with type and badges", async () => {
		const fields: SchemaField[] = [
			makeField({ slug: "title", label: "Title", type: "string", required: true, unique: true }),
			makeField({
				id: "field-2",
				slug: "body",
				label: "Body",
				type: "portableText",
				searchable: true,
			}),
		];
		const collection = makeCollection({ fields });

		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		// Verify fields render by checking their edit buttons (unique aria-labels)
		await expect.element(screen.getByRole("button", { name: EDIT_TITLE_RE })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: EDIT_BODY_RE })).toBeInTheDocument();

		// Badges — use exact: true to avoid matching system field descriptions like "Unique identifier"
		await expect.element(screen.getByText("Required", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Unique", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Searchable", { exact: true })).toBeInTheDocument();
	});

	// ---- System fields always shown ----

	it("shows system fields section", async () => {
		const collection = makeCollection();
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		await expect.element(screen.getByText("System Fields")).toBeInTheDocument();
		// System fields show descriptions — use those as unambiguous locators
		await expect.element(screen.getByText("Unique identifier (ULID)")).toBeInTheDocument();
		await expect.element(screen.getByText("URL-friendly identifier")).toBeInTheDocument();
		await expect.element(screen.getByText("draft, published, or archived")).toBeInTheDocument();
		await expect.element(screen.getByText("When the entry was created")).toBeInTheDocument();
		await expect.element(screen.getByText("When the entry was last modified")).toBeInTheDocument();
		await expect.element(screen.getByText("When the entry was published")).toBeInTheDocument();
	});

	// ---- Add field button opens FieldEditor dialog ----

	it("opens FieldEditor dialog when Add Field is clicked", async () => {
		const collection = makeCollection();
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		// Field editor should not be visible initially
		const dialog = screen.getByTestId("field-editor-dialog");
		await expect.element(dialog).not.toBeInTheDocument();

		// Click Add Field
		const addButton = screen.getByRole("button", { name: ADD_FIELD_BUTTON_REGEX });
		await addButton.click();

		// Dialog should now be visible
		await expect.element(screen.getByTestId("field-editor-dialog")).toBeInTheDocument();
	});

	// ---- Delete field with confirm dialog calls onDeleteField ----

	it("calls onDeleteField when delete is confirmed via dialog", async () => {
		const onDeleteField = vi.fn();

		const fields = [makeField({ slug: "title", label: "Title" })];
		const collection = makeCollection({ fields });

		const screen = await render(
			<ContentTypeEditor {...defaultProps({ onDeleteField })} collection={collection} />,
		);

		const deleteButton = screen.getByRole("button", { name: DELETE_FIELD_BUTTON_PATTERN });
		await deleteButton.click();

		// ConfirmDialog should appear
		await expect.element(screen.getByText("Delete Field?")).toBeInTheDocument();

		// Direct DOM click to bypass Base UI inert overlay
		screen.getByRole("button", { name: "Delete" }).element().click();

		expect(onDeleteField).toHaveBeenCalledWith("title");
	});

	it("does not call onDeleteField when delete dialog is cancelled", async () => {
		const onDeleteField = vi.fn();

		const fields = [makeField({ slug: "title", label: "Title" })];
		const collection = makeCollection({ fields });

		const screen = await render(
			<ContentTypeEditor {...defaultProps({ onDeleteField })} collection={collection} />,
		);

		const deleteButton = screen.getByRole("button", { name: DELETE_FIELD_BUTTON_REGEX });
		await deleteButton.click();

		// ConfirmDialog should appear
		await expect.element(screen.getByText("Delete Field?")).toBeInTheDocument();

		// Direct DOM click to bypass Base UI inert overlay
		screen.getByRole("button", { name: "Cancel" }).element().click();

		expect(onDeleteField).not.toHaveBeenCalled();
	});

	// ---- Code-source collections show disabled inputs and info banner ----

	it("shows info banner and disables inputs for code-source collections", async () => {
		const collection = makeCollection({ source: "code" });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		// Info banner text
		await expect.element(screen.getByText(CODE_DEFINED_MSG_REGEX)).toBeInTheDocument();

		// Label inputs should be disabled
		const labelInput = screen.getByLabelText("Label (Plural)");
		await expect.element(labelInput).toBeDisabled();

		const singularInput = screen.getByLabelText("Label (Singular)");
		await expect.element(singularInput).toBeDisabled();

		// Description uses InputArea — locate via placeholder
		const descInput = screen.getByPlaceholder("A brief description of this content type");
		await expect.element(descInput).toBeDisabled();

		// Save button should not exist for code-source collections
		const saveButton = screen.getByRole("button", { name: SAVE_CHANGES_BUTTON_REGEX });
		await expect.element(saveButton).not.toBeInTheDocument();

		// Add Field button should not exist
		const addFieldButton = screen.getByRole("button", { name: ADD_FIELD_BUTTON_REGEX });
		await expect.element(addFieldButton).not.toBeInTheDocument();
	});

	it("hides edit and delete buttons on fields for code-source collections", async () => {
		const fields = [makeField({ slug: "title", label: "Title" })];
		const collection = makeCollection({ source: "code", fields });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		const editButton = screen.getByRole("button", { name: EDIT_FIELD_BUTTON_REGEX });
		await expect.element(editButton).not.toBeInTheDocument();

		const deleteButton = screen.getByRole("button", { name: DELETE_FIELD_BUTTON_REGEX });
		await expect.element(deleteButton).not.toBeInTheDocument();
	});

	// ---- Empty field list shows "No custom fields yet" ----

	it("shows empty state when collection has no custom fields", async () => {
		const collection = makeCollection({ fields: [] });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		await expect.element(screen.getByText("No custom fields yet")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Add fields to define the structure of your content"))
			.toBeInTheDocument();
	});

	// ---- Fields section hidden for new collections ----

	it("does not show fields section when creating new collection", async () => {
		const screen = await render(<ContentTypeEditor {...defaultProps()} isNew />);

		const fieldsHeading = screen.getByRole("heading", { name: "Fields" });
		await expect.element(fieldsHeading).not.toBeInTheDocument();
	});

	// ---- isSaving shows saving state ----

	it("shows 'Saving...' when isSaving is true", async () => {
		const collection = makeCollection();
		const screen = await render(
			<ContentTypeEditor {...defaultProps()} collection={collection} isSaving />,
		);

		// The button text should show "Saving..." — but button is disabled because no changes
		// We need changes for the button to render enabled with saving text
		// Actually the button shows "Saving..." text regardless, it's just also disabled
		const saveButton = screen.getByRole("button", { name: SAVING_BUTTON_REGEX });
		await expect.element(saveButton).toBeInTheDocument();
	});

	// ---- URL Pattern field ----

	it("shows URL Pattern input", async () => {
		const collection = makeCollection();
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		const input = screen.getByLabelText("URL Pattern");
		await expect.element(input).toBeInTheDocument();
		await expect.element(input).toHaveValue("");
	});

	it("populates URL Pattern from collection", async () => {
		const collection = makeCollection({ urlPattern: "/blog/{slug}" });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		const input = screen.getByLabelText("URL Pattern");
		await expect.element(input).toHaveValue("/blog/{slug}");
	});

	it("includes urlPattern in onSave when set", async () => {
		const onSave = vi.fn();
		const collection = makeCollection();
		const screen = await render(
			<ContentTypeEditor {...defaultProps({ onSave })} collection={collection} />,
		);

		await screen.getByLabelText("URL Pattern").fill("/blog/{slug}");

		const saveButton = screen.getByRole("button", { name: SAVE_CHANGES_BUTTON_REGEX });
		await saveButton.click();

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ urlPattern: "/blog/{slug}" }));
	});

	it("shows validation error when pattern lacks {slug}", async () => {
		const collection = makeCollection();
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		await screen.getByLabelText("URL Pattern").fill("/blog/broken");

		await expect.element(screen.getByText(URL_PATTERN_SLUG_RE)).toBeInTheDocument();
	});

	it("disables save button when pattern lacks {slug}", async () => {
		const collection = makeCollection();
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		await screen.getByLabelText("URL Pattern").fill("/blog/broken");

		const saveButton = screen.getByRole("button", { name: SAVE_CHANGES_BUTTON_REGEX });
		await expect.element(saveButton).toBeDisabled();
	});

	it("enables save button when pattern includes {slug}", async () => {
		const collection = makeCollection();
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		await screen.getByLabelText("URL Pattern").fill("/blog/{slug}");

		const saveButton = screen.getByRole("button", { name: SAVE_CHANGES_BUTTON_REGEX });
		await expect.element(saveButton).toBeEnabled();
	});

	it("allows empty URL Pattern (field is optional)", async () => {
		const onSave = vi.fn();
		const collection = makeCollection({ label: "Posts" });
		const screen = await render(
			<ContentTypeEditor {...defaultProps({ onSave })} collection={collection} />,
		);

		// Change label to enable save (urlPattern empty is fine)
		await screen.getByLabelText("Label (Plural)").fill("Articles");

		const saveButton = screen.getByRole("button", { name: SAVE_CHANGES_BUTTON_REGEX });
		await expect.element(saveButton).toBeEnabled();
		await saveButton.click();

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ urlPattern: undefined }));
	});

	it("disables URL Pattern input for code-source collections", async () => {
		const collection = makeCollection({ source: "code", urlPattern: "/blog/{slug}" });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		const input = screen.getByLabelText("URL Pattern");
		await expect.element(input).toBeDisabled();
	});

	it("shows field count in header", async () => {
		const fields = [
			makeField({ slug: "title", label: "Title" }),
			makeField({ id: "field-2", slug: "body", label: "Body" }),
		];
		const collection = makeCollection({ fields });
		const screen = await render(<ContentTypeEditor {...defaultProps()} collection={collection} />);

		// Should show "6 system + 2 custom fields"
		await expect.element(screen.getByText(SYSTEM_FIELDS_REGEX)).toBeInTheDocument();
	});
});
