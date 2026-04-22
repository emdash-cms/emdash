import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
	ContentEditor,
	type FieldDescriptor,
	type ContentEditorProps,
} from "../../src/components/ContentEditor";
import type { ContentItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// Mock child components that have complex dependencies
vi.mock("../../src/components/PortableTextEditor", () => ({
	PortableTextEditor: ({ placeholder }: any) => (
		<div data-testid="portable-text-editor">{placeholder}</div>
	),
}));

vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => <div data-testid="revision-history">Revision History</div>,
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => <div data-testid="taxonomy-sidebar">Taxonomy</div>,
}));

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DocumentOutline", () => ({
	DocumentOutline: () => <div data-testid="doc-outline">Outline</div>,
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		getPreviewUrl: vi.fn().mockResolvedValue({ url: "https://example.com/preview" }),
	};
});

const defaultFields: Record<string, FieldDescriptor> = {
	title: { kind: "string", label: "Title", required: true },
	body: { kind: "string", label: "Body" },
};

const MOVE_TO_TRASH_PATTERN = /Move to Trash/i;

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		data: { title: "My Post", body: "Some content" },
		authorId: null,
		createdAt: "2025-01-15T10:30:00Z",
		updatedAt: "2025-01-15T10:30:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		...overrides,
	};
}

function renderEditor(props: Partial<ContentEditorProps> = {}) {
	const defaultProps: ContentEditorProps = {
		collection: "posts",
		collectionLabel: "Post",
		fields: defaultFields,
		isNew: true,
		onSave: vi.fn(),
		...props,
	};
	return render(<ContentEditor {...defaultProps} />);
}

describe("ContentEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("slug generation", () => {
		it("auto-generates slug from title for new items", async () => {
			const screen = await renderEditor({ isNew: true });
			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("Hello World Post");

			const slugInput = screen.getByLabelText("Slug");
			await expect.element(slugInput).toHaveValue("hello-world-post");
		});

		it("slug accepts manual override", async () => {
			const screen = await renderEditor({ isNew: true });
			const slugInput = screen.getByLabelText("Slug");
			await slugInput.fill("custom-slug");
			await expect.element(slugInput).toHaveValue("custom-slug");

			// After manual edit, typing in title should NOT update slug
			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("New Title");
			await expect.element(slugInput).toHaveValue("custom-slug");
		});

		it("slug is editable for new items", async () => {
			const screen = await renderEditor({ isNew: true });
			const slugInput = screen.getByLabelText("Slug");
			await expect.element(slugInput).toBeEnabled();
		});
	});

	describe("field rendering", () => {
		it("renders string fields as text inputs", async () => {
			const screen = await renderEditor({
				fields: { title: { kind: "string", label: "Title" } },
			});
			const input = screen.getByLabelText("Title");
			await expect.element(input).toBeInTheDocument();
		});

		it("renders boolean fields as switches", async () => {
			const screen = await renderEditor({
				fields: { featured: { kind: "boolean", label: "Featured" } },
			});
			const toggle = screen.getByRole("switch");
			await expect.element(toggle).toBeInTheDocument();
		});

		it("renders number fields as number inputs", async () => {
			const screen = await renderEditor({
				fields: { order: { kind: "number", label: "Order" } },
			});
			const input = screen.getByLabelText("Order");
			await expect.element(input).toHaveAttribute("type", "number");
		});

		it("renders select fields as select dropdowns", async () => {
			const screen = await renderEditor({
				fields: {
					color: {
						kind: "select",
						label: "Color",
						options: [
							{ value: "red", label: "Red" },
							{ value: "blue", label: "Blue" },
						],
					},
				},
			});
			// Select renders a combobox role
			const select = screen.getByRole("combobox");
			await expect.element(select).toBeInTheDocument();
		});

		it("renders multiSelect fields as checkbox group", async () => {
			const screen = await renderEditor({
				fields: {
					tags: {
						kind: "multiSelect",
						label: "Tags",
						options: [
							{ value: "news", label: "News" },
							{ value: "tech", label: "Tech" },
							{ value: "sports", label: "Sports" },
						],
					},
				},
			});
			const checkboxes = screen.getByRole("checkbox", { exact: false });
			await expect.element(checkboxes.first()).toBeInTheDocument();
			// All option labels should be present
			await expect.element(screen.getByText("News")).toBeInTheDocument();
			await expect.element(screen.getByText("Tech")).toBeInTheDocument();
			await expect.element(screen.getByText("Sports")).toBeInTheDocument();
		});

		it("toggling a multiSelect checkbox updates the saved value", async () => {
			const onSave = vi.fn();
			const item = makeItem({
				data: { title: "Test", tags: ["news", "sports"] },
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				onSave,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					tags: {
						kind: "multiSelect",
						label: "Tags",
						options: [
							{ value: "news", label: "News" },
							{ value: "tech", label: "Tech" },
							{ value: "sports", label: "Sports" },
						],
					},
				},
			});

			const checkboxes = screen.getByRole("checkbox", { exact: false });
			const all = checkboxes.all();

			// Uncheck "sports" (index 2, currently checked)
			await all[2]!.click();
			await expect.element(all[2]!).not.toBeChecked();

			// Check "tech" (index 1, currently unchecked)
			await all[1]!.click();
			await expect.element(all[1]!).toBeChecked();

			// Save and verify the data sent to onSave
			const saveBtn = screen.getByRole("button", { name: "Save" });
			await saveBtn.click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						tags: ["news", "tech"],
					}),
				}),
			);
		});

		it("multiSelect checkboxes reflect existing values", async () => {
			const item = makeItem({
				data: { title: "Test", tags: ["news", "sports"] },
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					tags: {
						kind: "multiSelect",
						label: "Tags",
						options: [
							{ value: "news", label: "News" },
							{ value: "tech", label: "Tech" },
							{ value: "sports", label: "Sports" },
						],
					},
				},
			});
			// Verify the checkbox group renders with correct checked state via aria
			const checkboxes = screen.getByRole("checkbox", { exact: false });
			const all = checkboxes.all();
			// Should have 3 checkboxes
			expect(all).toHaveLength(3);
			// news (checked), tech (unchecked), sports (checked)
			await expect.element(all[0]!).toBeChecked();
			await expect.element(all[1]!).not.toBeChecked();
			await expect.element(all[2]!).toBeChecked();
		});

		it("renders file fields with a Select file button (not a plain text input)", async () => {
			// Regression test for #718: the "file" field kind used to fall through to the
			// default case and render a text input, making it impossible to actually attach
			// a file. It must render a media picker trigger instead.
			const screen = await renderEditor({
				fields: { attachment: { kind: "file", label: "Attachment" } },
				isNew: true,
			});

			// The button that opens the picker should be present and labeled with the
			// field's label (accessibility).
			const selectBtn = screen.getByRole("button", { name: /Select Attachment/i });
			await expect.element(selectBtn).toBeInTheDocument();

			// And there must not be a text input inside the file field region — the old
			// bug rendered an `<Input>` labeled "Attachment" as a plain text field.
			// Use the field id (`field-attachment`) as an unconditional positive selector.
			const fieldRoot = document.getElementById("field-attachment");
			expect(fieldRoot).not.toBeNull();
			const textInputs = fieldRoot!.querySelectorAll(
				'input:not([type="file"]):not([type="hidden"])',
			);
			expect(textInputs).toHaveLength(0);
		});

		it("renders existing file field values as a filename, not a text input", async () => {
			const item = makeItem({
				data: {
					title: "Test",
					body: "",
					attachment: {
						id: "file-1",
						filename: "report.pdf",
						mimeType: "application/pdf",
						size: 102400,
					},
				},
			});
			const screen = await renderEditor({
				isNew: false,
				item,
				fields: {
					title: { kind: "string", label: "Title", required: true },
					attachment: { kind: "file", label: "Attachment" },
				},
			});

			// Filename should be visible
			await expect.element(screen.getByText("report.pdf")).toBeInTheDocument();
			// Change button present (picker is wired up)
			await expect.element(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
		});

		it("renders json fields as a textarea", async () => {
			const screen = await renderEditor({
				fields: { metadata: { kind: "json", label: "Metadata" } },
				isNew: true,
			});
			const textarea = screen.getByLabelText("Metadata");
			await expect.element(textarea).toBeInTheDocument();
			// JSON field uses a textarea element
			expect(textarea.element().tagName).toBe("TEXTAREA");
		});

		it("renders json fields with object values as formatted JSON", async () => {
			const jsonData = { foo: "bar", num: 42 };
			const screen = await renderEditor({
				fields: { metadata: { kind: "json", label: "Metadata" } },
				item: makeItem({ data: { title: "Test", body: "", metadata: jsonData } }),
			});
			const textarea = screen.getByLabelText("Metadata");
			await expect.element(textarea).toHaveValue(JSON.stringify(jsonData, null, 2));
		});
	});

	describe("saving", () => {
		it("save form calls onSave with formData including slug", async () => {
			const onSave = vi.fn();
			const screen = await renderEditor({ isNew: true, onSave });

			const titleInput = screen.getByLabelText("Title");
			await titleInput.fill("Test Title");

			const saveBtn = screen.getByRole("button", { name: "Save" });
			await saveBtn.click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ title: "Test Title" }),
					slug: "test-title",
					bylines: [],
				}),
			);
		});

		it("SaveButton shows correct dirty state for new items", async () => {
			const screen = await renderEditor({ isNew: true });
			// New items are always dirty
			const saveBtn = screen.getByRole("button", { name: "Save" });
			await expect.element(saveBtn).toBeEnabled();
		});

		it("SaveButton is disabled (Saved) for existing item with no changes", async () => {
			const item = makeItem();
			const screen = await renderEditor({ isNew: false, item });
			const savedBtn = screen.getByRole("button", { name: "Saved" });
			await expect.element(savedBtn).toBeDisabled();
		});

		it("keeps edited values after autosave completes without queuing another autosave", async () => {
			vi.useFakeTimers();

			try {
				const item = makeItem();
				const onAutosave = vi.fn();
				const props: ContentEditorProps = {
					collection: "posts",
					collectionLabel: "Post",
					fields: defaultFields,
					isNew: false,
					item,
					onSave: vi.fn(),
					onAutosave,
					isAutosaving: false,
					lastAutosaveAt: null,
				};

				const screen = await render(<ContentEditor {...props} />);
				const titleInput = screen.getByLabelText("Title");
				await titleInput.fill("Updated title");

				await vi.advanceTimersByTimeAsync(2000);
				expect(onAutosave).toHaveBeenCalledTimes(1);

				await screen.rerender(<ContentEditor {...props} isAutosaving={true} />);
				const autosavedItem = makeItem({
					updatedAt: "2026-04-12T18:38:00Z",
					data: { title: "Updated title", body: "Some content" },
				});
				await screen.rerender(
					<ContentEditor
						{...props}
						item={autosavedItem}
						isAutosaving={false}
						lastAutosaveAt={new Date("2026-04-12T18:38:00Z")}
					/>,
				);

				await expect.element(screen.getByLabelText("Title")).toHaveValue("Updated title");
				await vi.advanceTimersByTimeAsync(2500);
				expect(onAutosave).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("delete", () => {
		it("shows delete button for existing items", async () => {
			const item = makeItem();
			const onDelete = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onDelete });
			const deleteBtn = screen.getByRole("button", { name: MOVE_TO_TRASH_PATTERN });
			await expect.element(deleteBtn).toBeInTheDocument();
		});

		it("delete button opens confirmation dialog and confirming calls onDelete", async () => {
			const item = makeItem();
			const onDelete = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onDelete });

			// Click the delete trigger button
			const deleteBtn = screen.getByRole("button", { name: MOVE_TO_TRASH_PATTERN });
			await deleteBtn.click();

			// Dialog should appear with "Move to Trash?" title
			await expect.element(screen.getByText("Move to Trash?")).toBeInTheDocument();

			// There are multiple "Move to Trash" buttons - click the last one (the dialog confirm)
			const allBtns = document.querySelectorAll("button");
			const trashBtns = [...allBtns].filter((b) => b.textContent?.trim() === "Move to Trash");
			if (trashBtns[1]) {
				trashBtns[1].click();
			}

			await vi.waitFor(() => {
				expect(onDelete).toHaveBeenCalled();
			});
		});

		it("does not show delete button for new items", async () => {
			const screen = await renderEditor({ isNew: true });
			await expect
				.element(screen.getByText("Move to Trash"), { timeout: 100 })
				.not.toBeInTheDocument();
		});
	});

	describe("publish actions", () => {
		it("shows Publish button for draft items", async () => {
			const item = makeItem({ status: "draft" });
			const onPublish = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onPublish });
			const publishBtn = screen.getByRole("button", { name: "Publish" });
			await expect.element(publishBtn).toBeInTheDocument();
		});

		it("publish button calls onPublish", async () => {
			const item = makeItem({ status: "draft" });
			const onPublish = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onPublish });
			const publishBtn = screen.getByRole("button", { name: "Publish" });
			await publishBtn.click();
			expect(onPublish).toHaveBeenCalled();
		});

		it("shows Unpublish for published items with supportsDrafts", async () => {
			const item = makeItem({
				status: "published",
				liveRevisionId: "rev-1",
				draftRevisionId: "rev-1",
			});
			const onUnpublish = vi.fn();
			const screen = await renderEditor({
				isNew: false,
				item,
				onUnpublish,
				supportsDrafts: true,
			});
			const unpublishBtn = screen.getByRole("button", { name: "Unpublish" });
			await expect.element(unpublishBtn).toBeInTheDocument();
		});

		it("unpublish button calls onUnpublish", async () => {
			const item = makeItem({
				status: "published",
				liveRevisionId: "rev-1",
				draftRevisionId: "rev-1",
			});
			const onUnpublish = vi.fn();
			const screen = await renderEditor({
				isNew: false,
				item,
				onUnpublish,
				supportsDrafts: true,
			});
			const unpublishBtn = screen.getByRole("button", { name: "Unpublish" });
			await unpublishBtn.click();
			expect(onUnpublish).toHaveBeenCalled();
		});
	});

	describe("distraction-free mode", () => {
		it("toggle adds fixed class for distraction-free mode", async () => {
			const screen = await renderEditor({ isNew: true });
			const enterBtn = screen.getByRole("button", { name: "Enter distraction-free mode" });
			await enterBtn.click();

			// The form should now have the fixed inset-0 class
			const form = document.querySelector("form");
			expect(form?.classList.toString()).toContain("fixed");
		});

		it("escape exits distraction-free mode", async () => {
			const screen = await renderEditor({ isNew: true });
			const enterBtn = screen.getByRole("button", { name: "Enter distraction-free mode" });
			await enterBtn.click();

			// Verify we're in distraction-free mode
			let form = document.querySelector("form");
			expect(form?.classList.toString()).toContain("fixed");

			// Press Escape
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

			// Wait for the state to update
			await vi.waitFor(() => {
				form = document.querySelector("form");
				expect(form?.classList.toString()).not.toContain("fixed");
			});
		});
	});

	describe("scheduler", () => {
		it("shows scheduler when Schedule for later is clicked", async () => {
			const item = makeItem({ status: "draft" });
			const onSchedule = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onSchedule });

			const scheduleBtn = screen.getByRole("button", { name: "Schedule for later" });
			await scheduleBtn.click();

			// Should now show the datetime input
			await expect.element(screen.getByLabelText("Schedule for")).toBeInTheDocument();
			// And a Schedule submit button
			await expect.element(screen.getByRole("button", { name: "Schedule" })).toBeInTheDocument();
		});

		it("shows Publish button for scheduled items", async () => {
			const item = makeItem({ status: "scheduled", scheduledAt: "2026-06-01T12:00:00Z" });
			const onPublish = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onPublish });

			const publishBtn = screen.getByRole("button", { name: "Publish" });
			await expect.element(publishBtn).toBeInTheDocument();
		});

		it("publish button on scheduled item calls onPublish", async () => {
			const item = makeItem({ status: "scheduled", scheduledAt: "2026-06-01T12:00:00Z" });
			const onPublish = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onPublish });

			const publishBtn = screen.getByRole("button", { name: "Publish" });
			await publishBtn.click();
			expect(onPublish).toHaveBeenCalled();
		});

		it("shows Unschedule button in sidebar for scheduled items", async () => {
			const item = makeItem({ status: "scheduled", scheduledAt: "2026-06-01T12:00:00Z" });
			const onUnschedule = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onUnschedule });

			// Unschedule should be in the sidebar, not in the header
			const unscheduleBtn = screen.getByRole("button", { name: "Unschedule" });
			await expect.element(unscheduleBtn).toBeInTheDocument();
		});

		it("unschedule button calls onUnschedule", async () => {
			const item = makeItem({ status: "scheduled", scheduledAt: "2026-06-01T12:00:00Z" });
			const onUnschedule = vi.fn();
			const screen = await renderEditor({ isNew: false, item, onUnschedule });

			const unscheduleBtn = screen.getByRole("button", { name: "Unschedule" });
			await unscheduleBtn.click();
			expect(onUnschedule).toHaveBeenCalled();
		});
	});

	describe("heading", () => {
		it("shows 'New Post' heading for new items", async () => {
			const screen = await renderEditor({ isNew: true, collectionLabel: "Post" });
			await expect.element(screen.getByText("New Post")).toBeInTheDocument();
		});

		it("shows 'Edit Post' heading for existing items", async () => {
			const item = makeItem();
			const screen = await renderEditor({ isNew: false, item, collectionLabel: "Post" });
			await expect.element(screen.getByText("Edit Post")).toBeInTheDocument();
		});
	});
});
