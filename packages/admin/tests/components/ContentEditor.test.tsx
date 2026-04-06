import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";

import {
	ContentEditor,
	type FieldDescriptor,
	type ContentEditorProps,
} from "../../src/components/ContentEditor";
import type { ContentItem } from "../../src/lib/api";

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

		it("loads json fields into a syntax-highlighted editor for existing items", async () => {
			const metadata = { theme: "dark", nested: { enabled: true } };
			const screen = await renderEditor({
				fields: { metadata: { kind: "json", label: "Metadata" } },
				isNew: false,
				item: makeItem({ data: { metadata } }),
			});

			// The CodeMirror editor has role="textbox" and is labelled by the
			// "Metadata" heading via aria-labelledby.
			const editor = screen.getByRole("textbox", { name: "Metadata" });
			await expect.element(editor).toBeInTheDocument();
			// CodeMirror renders each line in a separate div, so DOM textContent
			// has no newlines between lines. Check for key strings instead.
			await expect.element(editor).toHaveTextContent(/"theme"/);
			await expect.element(editor).toHaveTextContent(/"dark"/);
			await expect.element(editor).toHaveTextContent(/"nested"/);
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

		it("save form parses json editor content back into structured data", async () => {
			const onSave = vi.fn();
			const screen = await renderEditor({
				isNew: false,
				onSave,
				fields: { metadata: { kind: "json", label: "Metadata" } },
				item: makeItem({ data: { metadata: { enabled: false } } }),
			});

			const editor = screen.getByRole("textbox", { name: "Metadata" });
			await editor.fill('{"enabled":true,"count":2}');

			const saveBtn = screen.getByRole("button", { name: "Save" });
			await saveBtn.click();

			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						metadata: { enabled: true, count: 2 },
					}),
				}),
			);
		});

		it("disables save when json editor content is invalid", async () => {
			const onSave = vi.fn();
			const screen = await renderEditor({
				isNew: false,
				onSave,
				fields: { metadata: { kind: "json", label: "Metadata" } },
				item: makeItem({ data: { metadata: { enabled: false } } }),
			});

			const editor = screen.getByRole("textbox", { name: "Metadata" });
			await editor.fill('{"enabled": true');

			const saveBtn = screen.getByRole("button", { name: "Save" });
			await expect.element(saveBtn).toBeDisabled();
			expect(onSave).not.toHaveBeenCalled();
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
