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

	it("renders a Live View link in the Publish section when a live URL is provided", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ liveViewUrl: "https://example.com/my-post" })} />,
		);
		const link = screen.getByRole("link", { name: /Live View/ });
		await expect.element(link).toBeInTheDocument();
		await expect.element(link).toHaveAttribute("href", "https://example.com/my-post");
	});
});

function makeBarProps(overrides: Partial<SettingsActionBarProps> = {}): SettingsActionBarProps {
	return {
		isNew: false,
		isDirty: false,
		isSaving: false,
		showAutosave: false,
		status: "draft",
		supportsDrafts: true,
		isLive: false,
		hasPendingChanges: false,
		hasSchedule: false,
		supportsPreview: false,
		isLoadingPreview: false,
		onPreview: vi.fn(),
		onPublish: vi.fn(),
		onUnpublish: vi.fn(),
		onDiscardDraft: vi.fn(),
		...overrides,
	};
}

describe("SettingsActionBar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows Publish and the Draft badge for an unpublished draft", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps()} />);

		await expect.element(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
		await expect.element(screen.getByText("Draft")).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Unpublish");
		expect(screen.container.textContent).not.toContain("Discard changes");
	});

	it("shows Publish changes, Pending changes badge, and Discard for a live item with edits", async () => {
		const props = makeBarProps({ isLive: true, hasPendingChanges: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const publishChanges = screen.getByRole("button", { name: "Publish changes" });
		await expect.element(publishChanges).toBeInTheDocument();
		await expect.element(screen.getByText("Pending changes")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Discard changes" }))
			.toBeInTheDocument();

		await publishChanges.click();
		expect(props.onPublish).toHaveBeenCalled();
	});

	it("shows Unpublish for a clean live item", async () => {
		const props = makeBarProps({ isLive: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const unpublish = screen.getByRole("button", { name: "Unpublish" });
		await expect.element(unpublish).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Discard changes");

		await unpublish.click();
		expect(props.onUnpublish).toHaveBeenCalled();
	});

	it("shows the Scheduled badge when a schedule exists", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps({ hasSchedule: true })} />);
		await expect.element(screen.getByText("Scheduled")).toBeInTheDocument();
	});

	it("hides the publish cluster for new items", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps({ isNew: true })} />);

		expect(screen.container.textContent).not.toContain("Publish");
		expect(screen.container.textContent).not.toContain("Unpublish");
		// Save is still available
		await expect.element(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
	});

	it("shows the in-flight autosave indicator", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ showAutosave: true, isAutosaving: true })} />,
		);
		await expect.element(screen.getByText("Saving...")).toBeInTheDocument();
	});

	it("shows the saved autosave indicator after an autosave", async () => {
		const screen = await render(
			<SettingsActionBar
				{...makeBarProps({ showAutosave: true, lastAutosaveAt: new Date("2025-01-15") })}
			/>,
		);
		// Scoped to the status region — the Save button also reads "Saved" when clean
		await expect.element(screen.getByRole("status").getByText("Saved")).toBeInTheDocument();
	});

	it("marks the Save button dirty state", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps({ isDirty: true })} />);
		await expect
			.element(screen.getByRole("button", { name: "Save", exact: true }))
			.toBeInTheDocument();
	});
});
