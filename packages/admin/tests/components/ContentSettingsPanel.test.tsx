import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ContentEditorProps } from "../../src/components/ContentEditor";
import {
	ContentSettingsPanel,
	SettingsActionBar,
	type ContentSettingsPanelProps,
	type SettingsActionBarProps,
} from "../../src/components/ContentSettingsPanel";
import type { BlockSidebarPanel } from "../../src/components/PortableTextEditor";
import type { ContentItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// Mock child components with their own data fetching so the panel tests
// only assert section visibility, not child behaviour.
vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => <div data-testid="revision-history">Revision History</div>,
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => <div data-testid="taxonomy-sidebar">Taxonomy</div>,
}));

vi.mock("../../src/components/editor/DocumentOutline", () => ({
	DocumentOutline: () => <div data-testid="doc-outline">Outline</div>,
}));

vi.mock("../../src/components/editor/ImageDetailPanel", () => ({
	ImageDetailPanel: () => <div data-testid="image-detail-panel">Image details</div>,
}));

vi.mock("../../src/components/SeoPanel", () => ({
	SeoPanel: () => <div data-testid="seo-panel">SEO fields</div>,
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		useNavigate: () => vi.fn(),
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
	};
});

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		data: { title: "My Post" },
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

const EDITOR_ROLE: NonNullable<ContentEditorProps["currentUser"]> = { id: "u1", role: 40 };
const AUTHOR_ROLE: NonNullable<ContentEditorProps["currentUser"]> = { id: "u2", role: 20 };
const USERS = [
	{ id: "u1", name: "Editor One", email: "editor@example.com", role: 40 },
] as ContentSettingsPanelProps["users"];

function makePanelProps(
	overrides: Partial<ContentSettingsPanelProps> = {},
): ContentSettingsPanelProps {
	return {
		collection: "posts",
		item: makeItem(),
		isNew: false,
		slug: "my-post",
		onSlugChange: vi.fn(),
		status: "draft",
		supportsDrafts: true,
		isLive: false,
		hasPendingChanges: false,
		hasSchedule: false,
		supportsRevisions: true,
		canSchedule: false,
		onDelete: vi.fn(),
		currentUser: EDITOR_ROLE,
		users: USERS,
		onAuthorChange: vi.fn(),
		activeBylines: [],
		availableBylines: [],
		availableBylinesLoaded: true,
		onBylinesChange: vi.fn(),
		i18n: { defaultLocale: "en", locales: ["en", "ar"] },
		translations: [],
		onTranslate: vi.fn(),
		hasSeo: true,
		onSeoChange: vi.fn(),
		portableTextEditor: {} as Editor,
		blockSidebarPanel: null,
		onBlockSidebarClose: vi.fn(),
		onBlockSidebarDelete: vi.fn(),
		...overrides,
	};
}

describe("ContentSettingsPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders all eight sections when every capability is enabled", async () => {
		const screen = await render(<ContentSettingsPanel {...makePanelProps()} />);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "Ownership" })).toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "Bylines" })).toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "Translations" })).toBeInTheDocument();
		await expect.element(screen.getByTestId("taxonomy-sidebar")).toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "SEO" })).toBeInTheDocument();
		await expect.element(screen.getByTestId("doc-outline")).toBeInTheDocument();
		await expect.element(screen.getByTestId("revision-history")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Move to Trash" })).toBeInTheDocument();
	});

	it("hides Ownership and Bylines for users below the editor role", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ currentUser: AUTHOR_ROLE })} />,
		);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Ownership");
		expect(screen.container.textContent).not.toContain("Bylines");
	});

	it("hides capability-gated sections when their flags are off", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					hasSeo: false,
					supportsRevisions: false,
					portableTextEditor: null,
					i18n: undefined,
				})}
			/>,
		);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(screen.container.querySelector('[data-testid="seo-panel"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="revision-history"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="doc-outline"]')).toBeNull();
		expect(screen.container.textContent).not.toContain("Translations");
	});

	it("hides item-dependent sections for new entries", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ item: null, isNew: true })} />,
		);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		// No trash, no translations, no taxonomies, no SEO, no revisions for new items
		expect(screen.container.textContent).not.toContain("Move to Trash");
		expect(screen.container.textContent).not.toContain("Translations");
		expect(screen.container.querySelector('[data-testid="taxonomy-sidebar"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="seo-panel"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="revision-history"]')).toBeNull();
	});

	it("renders the block detail panel instead of settings when a block requests the sidebar", async () => {
		const blockPanel: BlockSidebarPanel = {
			type: "image",
			attrs: {},
			onUpdate: vi.fn(),
			onReplace: vi.fn(),
			onDelete: vi.fn(),
			onClose: vi.fn(),
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ blockSidebarPanel: blockPanel })} />,
		);

		await expect.element(screen.getByTestId("image-detail-panel")).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Publish");
		expect(screen.container.textContent).not.toContain("Move to Trash");
	});

	it("keeps Move to Trash as the last section", async () => {
		const screen = await render(<ContentSettingsPanel {...makePanelProps()} />);
		const root = screen.container.firstElementChild;
		const lastSection = root?.lastElementChild;
		expect(lastSection?.textContent).toContain("Move to Trash");
	});
});

function makeBarProps(overrides: Partial<SettingsActionBarProps> = {}): SettingsActionBarProps {
	return {
		collectionLabel: "Post",
		isNew: false,
		isDirty: false,
		isSaving: false,
		isLive: false,
		hasPendingChanges: false,
		liveViewUrl: null,
		supportsPreview: false,
		isLoadingPreview: false,
		onPreview: vi.fn(),
		onPublish: vi.fn(),
		onUnpublish: vi.fn(),
		announceSaveStatus: true,
		...overrides,
	};
}

describe("SettingsActionBar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows Publish Post for an unpublished draft", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps()} />);
		const publish = screen.getByRole("button", { name: "Publish Post" });

		await expect.element(publish).toBeInTheDocument();
		expect(publish.element().className).toContain("button-emphasis-bg");
		expect(screen.container.textContent).not.toContain("Unpublish Post");
	});

	it("preserves configured collection label casing", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ collectionLabel: "API Docs" })} />,
		);

		await expect
			.element(screen.getByRole("button", { name: "Publish API Docs", exact: true }))
			.toBeInTheDocument();
	});

	it("shows Publish updates for a live item with edits", async () => {
		const props = makeBarProps({ isLive: true, hasPendingChanges: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const publishChanges = screen.getByRole("button", { name: "Publish updates" });
		await expect.element(publishChanges).toBeInTheDocument();
		expect(publishChanges.element().className).toContain("button-emphasis-bg");

		await publishChanges.click();
		expect(props.onPublish).toHaveBeenCalled();
	});

	it("shows Unpublish Post for a clean live item", async () => {
		const props = makeBarProps({ isLive: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const unpublish = screen.getByRole("button", { name: "Unpublish Post" });
		await expect.element(unpublish).toBeInTheDocument();

		await unpublish.click();
		expect(props.onUnpublish).toHaveBeenCalled();
	});

	it("renders Live View when a live URL is provided", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ liveViewUrl: "https://example.com/my-post" })} />,
		);
		const link = screen.getByRole("link", { name: /Live View/ });
		await expect.element(link).toBeInTheDocument();
		await expect.element(link).toHaveAttribute("href", "https://example.com/my-post");
	});

	it("renders Preview when preview is supported", async () => {
		const props = makeBarProps({ supportsPreview: true, hasPendingChanges: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const preview = screen.getByRole("button", { name: "Preview draft" });
		await expect.element(preview).toBeInTheDocument();

		await preview.click();
		expect(props.onPreview).toHaveBeenCalled();
	});

	it("gives every action an intrinsic flexible layout slot", async () => {
		const screen = await render(
			<SettingsActionBar
				{...makeBarProps({
					isLive: true,
					hasPendingChanges: true,
					liveViewUrl: "https://example.com/my-post",
					supportsPreview: true,
				})}
			/>,
		);
		const actions = [
			screen.getByRole("button", { name: "Saved" }).element(),
			screen.getByRole("link", { name: "Live View" }).element(),
			screen.getByRole("button", { name: "Preview draft" }).element(),
			screen.getByRole("button", { name: "Publish updates" }).element(),
		];
		const slots = actions.map((action) => action.parentElement);

		expect(new Set(slots)).toHaveLength(actions.length);
		for (const slot of slots) {
			expect(slot).toHaveClass("min-w-max", "flex-[1_1_auto]");
		}
		expect(slots[0]?.parentElement).toHaveClass("items-stretch");
	});

	it("hides the publish cluster for new items", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps({ isNew: true })} />);

		expect(screen.container.textContent).not.toContain("Publish");
		expect(screen.container.textContent).not.toContain("Unpublish");
		// Save is still available
		await expect.element(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
	});

	it("shows autosave progress in the Save button", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ isDirty: true, isAutosaving: true })} />,
		);
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
		expect(screen.getByRole("status").element().textContent).toBe("Saving...");
	});

	it("can suppress its live region when another mounted copy announces status", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ announceSaveStatus: false })} />,
		);
		expect(screen.container.querySelector('span[role="status"][aria-live="polite"]')).toBeNull();
	});

	it("marks the Save button dirty state", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps({ isDirty: true })} />);
		await expect
			.element(screen.getByRole("button", { name: "Save", exact: true }))
			.toBeInTheDocument();
	});
});
