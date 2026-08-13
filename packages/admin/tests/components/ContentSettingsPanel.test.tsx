import { i18n } from "@lingui/core";
import { act, fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentEditorProps } from "../../src/components/ContentEditor";
import {
	ContentSettingsPanel,
	SettingsActionBar,
	type ContentSettingsPanelProps,
	type SettingsActionBarProps,
} from "../../src/components/ContentSettingsPanel";
import type { BlockSidebarPanel } from "../../src/components/PortableTextEditor";
import type { AdminManifest, ContentItem } from "../../src/lib/api";
import type { ContentEditorPanelContext } from "../../src/lib/content-editor-panels";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context";
import { render } from "../utils/render.tsx";

// Mock child components with their own data fetching so the panel tests
// only assert section visibility, not child behaviour.
vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => <div data-testid="revision-history">Revision History</div>,
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => <div data-testid="taxonomy-sidebar">Taxonomy</div>,
	useHasApplicableTaxonomies: () => true,
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

const TEST_MANIFEST: AdminManifest = {
	version: "0.30.0",
	hash: "test",
	collections: {},
	plugins: { insights: { enabled: true } },
};

function InsightsPanel({ entry, locale }: ContentEditorPanelContext) {
	return (
		<div data-testid="insights-panel">
			Insights for {entry.slug} ({locale})
		</div>
	);
}

function pluginWrapper(pluginAdmins: PluginAdmins) {
	return function PluginWrapper({ children }: React.PropsWithChildren) {
		return <PluginAdminProvider pluginAdmins={pluginAdmins}>{children}</PluginAdminProvider>;
	};
}

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
	afterEach(() => {
		vi.restoreAllMocks();
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

	it("shows the normalized pending changes label", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ isLive: true, hasPendingChanges: true })} />,
		);

		await expect.element(screen.getByText("Pending changes")).toBeInTheDocument();
	});

	it("shows Scheduled without a Draft companion", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ hasSchedule: true })} />,
		);

		await expect.element(screen.getByText("Scheduled", { exact: true })).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Draft");
	});

	it("normalizes recognized statuses for collections without draft support", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ status: "published", supportsDrafts: false })} />,
		);
		const statusRow = screen.getByText("Status", { exact: true }).element().parentElement!;

		expect(statusRow.textContent).toContain("Published");
		expect(statusRow.querySelector("svg")).not.toBeNull();
	});

	it("preserves custom statuses for collections without draft support", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ status: "reviewing", supportsDrafts: false })} />,
		);
		const statusRow = screen.getByText("Status", { exact: true }).element().parentElement!;

		expect(statusRow.textContent).toContain("Reviewing");
		expect(statusRow.querySelector("svg")).toBeNull();
	});

	it("renders applicable trusted plugin panels in host-owned sections", async () => {
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{
						id: "summary",
						title: "Content insights",
						component: InsightsPanel,
						collections: ["posts"],
					},
				],
			},
		};
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					manifest: TEST_MANIFEST,
					entryLocale: "en",
				})}
			/>,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect
			.element(screen.getByRole("heading", { name: "Content insights" }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByTestId("insights-panel"))
			.toHaveTextContent("Insights for my-post (en)");
	});

	it("localizes trusted plugin panel titles in host-owned UI", async () => {
		const previousLocale = i18n.locale;
		i18n.load("nl", { "Content insights": "Inhoudsinzichten" });
		i18n.activate("nl");
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{
						id: "summary",
						title: "Content insights",
						component: InsightsPanel,
					},
				],
			},
		};

		try {
			const screen = await render(
				<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
				{ wrapper: pluginWrapper(pluginAdmins) },
			);

			await expect
				.element(screen.getByRole("heading", { name: "Inhoudsinzichten" }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: "Drag to reorder Inhoudsinzichten" }))
				.toBeInTheDocument();
		} finally {
			i18n.activate(previousLocale);
		}
	});

	it("omits panels when their plugin is disabled or the entry is new", async () => {
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{ id: "summary", title: "Content insights", component: InsightsPanel },
				],
			},
		};
		const disabledManifest: AdminManifest = {
			...TEST_MANIFEST,
			plugins: { insights: { enabled: false } },
		};
		const disabledScreen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: disabledManifest })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);
		expect(disabledScreen.container.querySelector('[data-testid="insights-panel"]')).toBeNull();

		const newScreen = await render(
			<ContentSettingsPanel
				{...makePanelProps({ item: null, isNew: true, manifest: TEST_MANIFEST })}
			/>,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);
		expect(newScreen.container.querySelector('[data-testid="insights-panel"]')).toBeNull();
	});

	it("contains plugin panel render failures", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		function BrokenPanel(): React.ReactNode {
			throw new Error("render failed");
		}
		function HealthyPanel(): React.ReactNode {
			return <div data-testid="healthy-panel">Healthy panel</div>;
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{ id: "broken", title: "Broken insights", component: BrokenPanel },
					{ id: "healthy", title: "Healthy insights", component: HealthyPanel },
				],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect.element(screen.getByRole("alert")).toHaveTextContent("Plugin panel unavailable.");
		await expect.element(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
		await expect.element(screen.getByTestId("healthy-panel")).toHaveTextContent("Healthy panel");
		await expect.element(screen.getByTestId("doc-outline")).toBeInTheDocument();
		expect(errorSpy).toHaveBeenCalled();
	});

	it("recovers a failed plugin panel when Retry is pressed", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		let failPanel: (() => void) | undefined;
		let mountCount = 0;
		function FlakyPanel(): React.ReactNode {
			const [failed, setFailed] = React.useState(false);
			React.useEffect(() => {
				mountCount += 1;
			}, []);
			failPanel = () => setFailed(true);
			if (failed) throw new Error("panel failed");
			return <div data-testid="flaky-panel">Recovered</div>;
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [{ id: "flaky", title: "Flaky insights", component: FlakyPanel }],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect.element(screen.getByTestId("flaky-panel")).toBeInTheDocument();
		await act(async () => failPanel?.());
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Plugin panel unavailable.");

		await screen.getByRole("button", { name: "Retry" }).click();

		await expect.element(screen.getByTestId("flaky-panel")).toBeInTheDocument();
		expect(screen.getByRole("alert").query()).toBeNull();
		expect(mountCount).toBe(2);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("remounts plugin panels when the content identity changes", async () => {
		let nextMount = 0;
		function IdentityPanel({ entry }: ContentEditorPanelContext) {
			const [mount] = React.useState(() => ++nextMount);
			return (
				<div data-testid="identity-panel">
					{entry.id}:mount-{mount}
				</div>
			);
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [{ id: "identity", title: "Identity", component: IdentityPanel }],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect.element(screen.getByTestId("identity-panel")).toHaveTextContent("item-1:mount-1");
		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ id: "item-2", slug: "second-post" }),
					manifest: TEST_MANIFEST,
				})}
			/>,
		);

		await expect.element(screen.getByTestId("identity-panel")).toHaveTextContent("item-2:mount-2");
	});

	it("remounts plugin panels when the collection changes", async () => {
		let nextMount = 0;
		function CollectionPanel({ collection }: ContentEditorPanelContext) {
			const [mount] = React.useState(() => ++nextMount);
			return (
				<div data-testid="collection-panel">
					{collection}:mount-{mount}
				</div>
			);
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [
					{ id: "collection", title: "Collection", component: CollectionPanel },
				],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect.element(screen.getByTestId("collection-panel")).toHaveTextContent("posts:mount-1");
		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					collection: "pages",
					item: makeItem({ type: "pages" }),
					manifest: TEST_MANIFEST,
				})}
			/>,
		);

		await expect.element(screen.getByTestId("collection-panel")).toHaveTextContent("pages:mount-2");
	});

	it("resets failed plugin panels when their content context changes", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		let nextMount = 0;
		function ContextPanel({ collection, entry }: ContentEditorPanelContext) {
			const [failed, setFailed] = React.useState(false);
			const [mount] = React.useState(() => ++nextMount);
			if (failed) throw new Error("context panel failed");
			return (
				<button type="button" data-testid="context-panel" onClick={() => setFailed(true)}>
					{collection}:{entry.id}:mount-{mount}
				</button>
			);
		}
		const pluginAdmins: PluginAdmins = {
			insights: {
				contentEditorPanels: [{ id: "context", title: "Context", component: ContextPanel }],
			},
		};
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ manifest: TEST_MANIFEST })} />,
			{ wrapper: pluginWrapper(pluginAdmins) },
		);

		await expect
			.element(screen.getByTestId("context-panel"))
			.toHaveTextContent("posts:item-1:mount-1");
		await screen.getByTestId("context-panel").click();
		await expect.element(screen.getByRole("alert")).toBeInTheDocument();

		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({ id: "item-2", slug: "second-post" }),
					manifest: TEST_MANIFEST,
				})}
			/>,
		);
		await expect
			.element(screen.getByTestId("context-panel"))
			.toHaveTextContent("posts:item-2:mount-2");

		await screen.getByTestId("context-panel").click();
		await expect.element(screen.getByRole("alert")).toBeInTheDocument();
		await screen.rerender(
			<ContentSettingsPanel
				{...makePanelProps({
					collection: "pages",
					item: makeItem({ id: "item-2", slug: "second-page", type: "pages" }),
					manifest: TEST_MANIFEST,
				})}
			/>,
		);
		await expect
			.element(screen.getByTestId("context-panel"))
			.toHaveTextContent("pages:item-2:mount-3");
		expect(errorSpy).toHaveBeenCalled();
	});

	it("hides Ownership and Bylines for users below the editor role", async () => {
		const screen = await render(
			<ContentSettingsPanel {...makePanelProps({ currentUser: AUTHOR_ROLE })} />,
		);

		await expect.element(screen.getByRole("heading", { name: "Publish" })).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Ownership");
		expect(screen.container.textContent).not.toContain("Bylines");
	});

	it("lets editors update the publish date of published content", async () => {
		const onPublishedAtChange = vi.fn();
		const previousLocale = i18n.locale;
		i18n.load("ar", {});
		i18n.activate("ar");
		try {
			const screen = await render(
				<div dir="rtl">
					<ContentSettingsPanel
						{...makePanelProps({
							item: makeItem({
								status: "published",
								publishedAt: "2025-01-15T10:30:00.000Z",
							}),
							isLive: true,
							onPublishedAtChange,
						})}
					/>
				</div>,
			);

			const input = screen.getByLabelText("Publish date");
			await expect.element(input).toHaveValue("2025-01-15T10:30");
			await input.fill("2020-06-01T08:45");
			await screen.getByRole("button", { name: "Update publish date" }).click();

			expect(onPublishedAtChange).toHaveBeenCalledWith("2020-06-01T08:45:00.000Z");
		} finally {
			i18n.activate(previousLocale);
		}
	});

	it("does not expose publish-date editing below the editor role", async () => {
		const screen = await render(
			<ContentSettingsPanel
				{...makePanelProps({
					item: makeItem({
						status: "published",
						publishedAt: "2025-01-15T10:30:00.000Z",
					}),
					isLive: true,
					currentUser: AUTHOR_ROLE,
					onPublishedAtChange: vi.fn(),
				})}
			/>,
		);

		expect(screen.container.querySelector('input[type="datetime-local"]')).toBeNull();
		expect(screen.container.textContent).not.toContain("Update publish date");
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

	it("hides destructive actions without collapsing their space while reordering", async () => {
		const screen = await render(<ContentSettingsPanel {...makePanelProps()} />);
		const trashActions = screen.getByTestId("content-trash-actions").element();
		const handle = screen.getByRole("button", { name: "Drag to reorder Publish" }).element();

		expect(trashActions).not.toHaveClass("invisible", "pointer-events-none");
		expect(trashActions).not.toHaveAttribute("aria-hidden");

		handle.focus();
		await act(async () => {
			fireEvent.keyDown(handle, { key: " ", code: "Space" });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(trashActions).toHaveClass("invisible", "pointer-events-none");
		expect(trashActions).toHaveAttribute("aria-hidden", "true");

		await act(async () => {
			fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(trashActions).not.toHaveClass("invisible", "pointer-events-none");
		expect(trashActions).not.toHaveAttribute("aria-hidden");
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

	it("shows Publish for an unpublished draft", async () => {
		const screen = await render(<SettingsActionBar {...makeBarProps()} />);
		const publish = screen.getByRole("button", { name: "Publish", exact: true });

		await expect.element(publish).toBeInTheDocument();
		expect(publish.element().className).toContain("button-emphasis-bg");
		expect(screen.container.textContent).not.toContain("Unpublish Post");
	});

	it("uses the normalized Publish label for every collection", async () => {
		const screen = await render(
			<SettingsActionBar {...makeBarProps({ collectionLabel: "API Docs" })} />,
		);

		await expect
			.element(screen.getByRole("button", { name: "Publish", exact: true }))
			.toBeInTheDocument();
	});

	it("shows Publish for a live item with edits", async () => {
		const props = makeBarProps({ isLive: true, hasPendingChanges: true });
		const screen = await render(<SettingsActionBar {...props} />);

		const publishChanges = screen.getByRole("button", { name: "Publish", exact: true });
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
			screen.getByRole("button", { name: "Publish", exact: true }).element(),
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
