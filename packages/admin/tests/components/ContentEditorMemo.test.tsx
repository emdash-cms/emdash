/**
 * Enforces the ContentSettingsPanel memoization contract.
 *
 * The panel is React.memo'd and ContentEditor promises that every prop it
 * passes is referentially stable across editor keystrokes (see the useCallback
 * scaffolding in ContentEditor.tsx and router.tsx). One future inline arrow
 * among those props silently defeats the memo — the panel re-renders on every
 * keystroke with green CI. This suite pins the contract by counting probe
 * renders while typing.
 */

import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { ContentEditor, type ContentEditorProps } from "../../src/components/ContentEditor";
import type { FieldDescriptor } from "../../src/components/ContentEditor";
import type { ContentItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

let panelRenderCount = 0;

// Replace only the panel with a memoized render-counting probe; the action
// bar and the rest of the module stay real. The probe must be memo'd exactly
// like the real panel so a re-render means "a prop identity changed".
vi.mock("../../src/components/ContentSettingsPanel", async () => {
	const actual = await vi.importActual<typeof import("../../src/components/ContentSettingsPanel")>(
		"../../src/components/ContentSettingsPanel",
	);
	return {
		...actual,
		ContentSettingsPanel: React.memo(function PanelProbe() {
			panelRenderCount++;
			return <div data-testid="panel-probe" />;
		}),
	};
});

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

const fields: Record<string, FieldDescriptor> = {
	title: { kind: "string", label: "Title", required: true },
	body: { kind: "string", label: "Body" },
};

function makeItem(): ContentItem {
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
	};
}

describe("ContentSettingsPanel memo contract", () => {
	it("does not re-render the panel while the user types in the editor", async () => {
		const props: ContentEditorProps = {
			collection: "posts",
			collectionLabel: "Post",
			fields,
			isNew: false,
			item: makeItem(),
			onSave: vi.fn(),
			onAutosave: vi.fn(),
			onPublish: vi.fn(),
			onDelete: vi.fn(),
		};

		const screen = await render(<ContentEditor {...props} />);
		await expect.element(screen.getByTestId("panel-probe")).toBeInTheDocument();

		const baseline = panelRenderCount;
		expect(baseline).toBeGreaterThan(0);

		const titleInput = screen.getByLabelText("Title");
		await titleInput.fill("A completely new title");
		const bodyInput = screen.getByLabelText("Body");
		await bodyInput.fill("More typing in another field");

		// The editor itself re-rendered — the form is dirty and Save is live…
		await expect.element(screen.getByRole("button", { name: "Save" }).first()).toBeEnabled();

		// …but no panel prop changed identity, so the memo held.
		expect(panelRenderCount).toBe(baseline);
	});
});
