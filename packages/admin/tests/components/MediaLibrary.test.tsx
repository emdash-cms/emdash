import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MediaLibrary } from "../../src/components/MediaLibrary";
import type { LocalMediaItem, MediaFolder, MediaItem, MediaProviderItem } from "../../src/lib/api";
import { ApiResponseError, deleteMedia } from "../../src/lib/api";
import {
	MEDIA_USAGE_ACTIVATION_QUERY_KEY,
	MEDIA_USAGE_PROGRESS_QUERY_KEY,
} from "../../src/lib/api/media-usage-activation.js";
import { render } from "../utils/render.tsx";

const dndState = vi.hoisted(() => ({
	props: null as null | {
		onDragStart?: (event: any) => void;
		onDragEnd?: (event: any) => void;
		onDragCancel?: (event: any) => void;
	},
}));

vi.mock("@dnd-kit/core", async () => {
	const ReactModule = await import("react");
	return {
		DndContext: (props: React.PropsWithChildren<Record<string, unknown>>) => {
			dndState.props = props as typeof dndState.props;
			return ReactModule.createElement(ReactModule.Fragment, null, props.children);
		},
		DragOverlay: ({ children }: React.PropsWithChildren) =>
			ReactModule.createElement(ReactModule.Fragment, null, children),
		PointerSensor: Symbol("PointerSensor"),
		pointerWithin: () => [],
		useSensor: () => ({}),
		useSensors: (...sensors: unknown[]) => sensors,
		useDraggable: () => ({
			setNodeRef: () => undefined,
			listeners: undefined,
			isDragging: false,
		}),
		useDroppable: () => ({
			setNodeRef: () => undefined,
			isOver: false,
		}),
	};
});

vi.mock("../../src/components/RouterLinkButton.js", () => ({
	RouterLinkButton: ({
		to,
		search,
		variant: _variant,
		size: _size,
		shape: _shape,
		icon: _icon,
		...props
	}: React.ComponentProps<"a"> & {
		to: string;
		search?: { folder?: string };
		variant?: string;
		size?: string;
		shape?: string;
		icon?: React.ReactNode;
	}) => (
		<a
			{...props}
			role="link"
			data-href={search?.folder ? `${to}?folder=${encodeURIComponent(search.folder)}` : to}
		/>
	),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPLOAD_CTA_PATTERN = /Upload images, videos, and documents to keep reusable assets/;
const UPLOAD_TO_LIBRARY_PATTERN = /Upload to Library/;
const UPLOAD_FILES_PATTERN = /Upload Files/;
const setupMocks = vi.hoisted(() => ({
	fetchStatus: vi.fn(),
	fetchProgress: vi.fn(),
	role: 40,
}));

vi.mock("../../src/lib/api/media-usage-activation.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/lib/api/media-usage-activation.js")
	>("../../src/lib/api/media-usage-activation.js");
	return {
		...actual,
		fetchMediaUsageActivationStatus: setupMocks.fetchStatus,
		fetchMediaUsageProgress: setupMocks.fetchProgress,
	};
});

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "user-1", role: setupMocks.role } }),
}));

function setInputFiles(input: HTMLInputElement, files: File[]) {
	const transfer = new DataTransfer();
	for (const file of files) transfer.items.add(file);
	input.files = transfer.files;
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

function dropFiles(target: EventTarget, files: File[]) {
	const transfer = new DataTransfer();
	for (const file of files) transfer.items.add(file);
	target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true }));
	target.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
}

async function simulateMediaDrop(item: LocalMediaItem, folder: MediaFolder) {
	const active = { data: { current: { kind: "local-media", item } } };
	dndState.props?.onDragStart?.({ active });
	dndState.props?.onDragEnd?.({
		active,
		over: { data: { current: { kind: "media-folder-target", folder } } },
	});
	window.dispatchEvent(new PointerEvent("pointerup"));
	document
		.querySelector("[data-media-library]")
		?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
		uploadToProvider: vi.fn().mockResolvedValue({}),
		updateMedia: vi.fn().mockResolvedValue({}),
		deleteMedia: vi.fn().mockResolvedValue({}),
	};
});

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<Toasty>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</Toasty>
	);
}

function renderLibrary(
	props: Partial<React.ComponentProps<typeof MediaLibrary>> = {},
	queryClient?: QueryClient,
) {
	const defaultProps: React.ComponentProps<typeof MediaLibrary> = {
		items: [],
		isLoading: false,
		onUpload: vi.fn(),
		onSelect: vi.fn(),
		onItemUpdated: vi.fn(),
		...props,
	};
	const library = <MediaLibrary {...defaultProps} />;
	return render(
		queryClient ? (
			<QueryClientProvider client={queryClient}>{library}</QueryClientProvider>
		) : (
			<QueryWrapper>{library}</QueryWrapper>
		),
	);
}

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: "media_01",
		filename: "photo.jpg",
		mimeType: "image/jpeg",
		url: "https://example.com/photo.jpg",
		size: 102400,
		width: 800,
		height: 600,
		createdAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

function makeLocalMediaItem(overrides: Partial<LocalMediaItem> = {}): LocalMediaItem {
	return {
		...makeMediaItem(),
		storageKey: "media_01.jpg",
		authorId: "user_01",
		folderId: null,
		...overrides,
	};
}

function makeFolder(overrides: Partial<MediaFolder> = {}): MediaFolder {
	return { id: "folder-1", name: "Product photos", ...overrides };
}

function makePagination(
	overrides: Partial<NonNullable<React.ComponentProps<typeof MediaLibrary>["pagination"]>> = {},
): NonNullable<React.ComponentProps<typeof MediaLibrary>["pagination"]> {
	return {
		page: 1,
		perPage: 35,
		totalCount: 37,
		isPending: false,
		onPageChange: vi.fn(),
		onPageSizeChange: vi.fn(),
		...overrides,
	};
}

describe("MediaLibrary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dndState.props = null;
		setupMocks.role = 40;
		setupMocks.fetchStatus.mockResolvedValue({ state: "active" });
		setupMocks.fetchProgress.mockResolvedValue({
			status: "ready",
			readyCollections: 2,
			totalCollections: 2,
		});
	});

	describe("Media Usage setup discovery", () => {
		it("shows an administrator one setup action while activation is off", async () => {
			setupMocks.role = 50;
			setupMocks.fetchStatus.mockResolvedValue({ state: "expanded" });

			const screen = await renderLibrary();

			await expect.element(screen.getByText("Set up media usage tracking")).toBeInTheDocument();
			await expect.element(screen.getByRole("link", { name: "Open setup" })).toBeInTheDocument();
		});

		it("links to the automatic setup status while activation is running", async () => {
			setupMocks.role = 50;
			setupMocks.fetchStatus.mockResolvedValue({ state: "activating" });

			const screen = await renderLibrary();

			await expect
				.element(screen.getByText("Media usage tracking is setting up"))
				.toBeInTheDocument();
			await expect.element(screen.getByRole("link", { name: "View setup" })).toBeInTheDocument();
		});

		it("keeps the setup link while existing content is indexing", async () => {
			setupMocks.role = 50;
			setupMocks.fetchStatus.mockResolvedValue({ state: "active" });
			setupMocks.fetchProgress.mockResolvedValue({
				status: "indexing",
				readyCollections: 1,
				totalCollections: 2,
			});

			const screen = await renderLibrary();

			await expect
				.element(screen.getByText("Media usage tracking is indexing existing content"))
				.toBeVisible();
			await expect.element(screen.getByRole("link", { name: "View setup" })).toBeVisible();
		});

		it("waits for progress before labelling an active site as incomplete", async () => {
			setupMocks.role = 50;
			setupMocks.fetchStatus.mockResolvedValue({ state: "active" });
			let finishProgress!: (value: {
				status: "indexing";
				readyCollections: number;
				totalCollections: number;
			}) => void;
			setupMocks.fetchProgress.mockImplementation(
				() => new Promise((resolve) => (finishProgress = resolve)),
			);

			const screen = await renderLibrary();

			await vi.waitFor(() => expect(setupMocks.fetchProgress).toHaveBeenCalledOnce());
			expect(screen.getByRole("link", { name: "View setup" }).query()).toBeNull();
			expect(
				screen.getByText("Media usage tracking is indexing existing content").query(),
			).toBeNull();

			finishProgress({ status: "indexing", readyCollections: 1, totalCollections: 2 });
			await expect.element(screen.getByRole("link", { name: "View setup" })).toBeVisible();
		});

		it("does not label an unreadable progress state as indexing", async () => {
			setupMocks.role = 50;
			setupMocks.fetchStatus.mockResolvedValue({ state: "active" });
			setupMocks.fetchProgress.mockRejectedValue(new Error("status unavailable"));

			const screen = await renderLibrary();

			await expect.element(screen.getByText("Media usage tracking needs attention")).toBeVisible();
			await expect.element(screen.getByRole("link", { name: "View setup" })).toBeVisible();
		});

		it("refreshes fresh cached indexing state when the library mounts", async () => {
			setupMocks.role = 50;
			const queryClient = new QueryClient({
				defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
			});
			queryClient.setQueryData(MEDIA_USAGE_ACTIVATION_QUERY_KEY, { state: "active" });
			queryClient.setQueryData(MEDIA_USAGE_PROGRESS_QUERY_KEY, {
				status: "indexing",
				readyCollections: 1,
				totalCollections: 2,
			});
			setupMocks.fetchStatus.mockResolvedValue({ state: "active" });
			setupMocks.fetchProgress.mockResolvedValue({
				status: "ready",
				readyCollections: 2,
				totalCollections: 2,
			});

			const screen = await renderLibrary({}, queryClient);

			await vi.waitFor(() => expect(setupMocks.fetchStatus).toHaveBeenCalledOnce());
			await vi.waitFor(() => expect(setupMocks.fetchProgress).toHaveBeenCalledOnce());
			await expect
				.element(screen.getByRole("link", { name: "View setup" }))
				.not.toBeInTheDocument();
		});

		it("keeps the library usable when optional setup discovery fails", async () => {
			setupMocks.role = 50;
			setupMocks.fetchStatus.mockRejectedValue(new Error("status unavailable"));

			const screen = await renderLibrary({
				items: [makeMediaItem({ id: "1", filename: "still-usable.jpg" })],
			});

			await expect.element(screen.getByAltText("still-usable.jpg")).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }))
				.toBeInTheDocument();
			expect(screen.getByText("Set up media usage tracking").query()).toBeNull();
		});
	});

	describe("rendering items", () => {
		it("keeps direct consumers provider-safe when drag feedback is enabled", async () => {
			const queryClient = new QueryClient({
				defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
			});
			const screen = await render(
				<QueryClientProvider client={queryClient}>
					<MediaLibrary
						items={[makeLocalMediaItem()]}
						folders={[makeFolder()]}
						canMoveMedia={() => true}
						onMoveMedia={vi.fn().mockResolvedValue(undefined)}
					/>
				</QueryClientProvider>,
			);

			await expect
				.element(screen.getByRole("heading", { name: "Media Library" }))
				.toBeInTheDocument();
		});

		it("uses the concise local upload action without changing the dialog title", async () => {
			const screen = await renderLibrary({ items: [makeMediaItem()] });

			expect(screen.getByRole("button", { name: UPLOAD_TO_LIBRARY_PATTERN }).query()).toBeNull();
			screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }).element().click();
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
		});

		it("renders folders before media with navigation, edit, and load-more actions", async () => {
			const onOpenFolder = vi.fn();
			const onCreateFolder = vi.fn().mockResolvedValue(makeFolder());
			const onRenameFolder = vi.fn().mockResolvedValue(makeFolder());
			const onDeleteFolder = vi.fn().mockResolvedValue(undefined);
			const onLoadMoreFolders = vi.fn();
			const folder = makeFolder();
			const screen = await renderLibrary({
				folders: [folder],
				items: [makeMediaItem()],
				pagination: makePagination(),
				canManageFolders: true,
				hasMoreFolders: true,
				onOpenFolder,
				onCreateFolder,
				onRenameFolder,
				onDeleteFolder,
				onLoadMoreFolders,
			});

			await expect.element(screen.getByRole("heading", { name: "Folders" })).toBeInTheDocument();
			await expect.element(screen.getByText("1 folder loaded")).toBeInTheDocument();
			const folderLink = screen.getByRole("link", { name: "Open folder Product photos" });
			const folderCard = folderLink.element().closest("[data-media-folder-card]");
			expect(folderCard).not.toBeNull();
			expect(folderCard!.getBoundingClientRect().height).toBeLessThanOrEqual(72);
			expect(folderLink.element().querySelector('[dir="auto"]')).toHaveTextContent(
				"Product photos",
			);
			await folderLink.click();
			expect(onOpenFolder).toHaveBeenCalledWith(folder);
			await expect.element(screen.getByRole("heading", { name: "Media Library" })).toHaveFocus();
			const editFolder = screen.getByRole("button", { name: "Edit folder Product photos" });
			await editFolder.click();
			await expect
				.element(screen.getByRole("heading", { name: "Edit folder" }))
				.toBeInTheDocument();
			screen.getByRole("button", { name: "Cancel" }).element().click();
			await vi.waitFor(() => expect(document.activeElement).toBe(editFolder.element()));
			await screen.getByRole("button", { name: "Add new folder" }).click();
			await expect
				.element(screen.getByRole("heading", { name: "Add new folder" }))
				.toBeInTheDocument();
			screen.getByRole("button", { name: "Cancel" }).element().click();
			await screen.getByRole("button", { name: "Load more folders" }).click();
			expect(onLoadMoreFolders).toHaveBeenCalledTimes(1);
		});

		it("moves a permitted local item from grid and list without opening another control", async () => {
			const folder = makeFolder();
			const item = makeLocalMediaItem();
			const onMoveMedia = vi.fn().mockResolvedValue(undefined);
			const onOpenFolder = vi.fn();
			const screen = await renderLibrary({
				folders: [folder],
				items: [item],
				pagination: makePagination(),
				canMoveMedia: () => true,
				onMoveMedia,
				onOpenFolder,
			});

			const gridSource = screen.getByRole("button", { name: "photo.jpg" }).element();
			expect(gridSource.querySelector("img")).toHaveAttribute("draggable", "false");
			const gridTarget = screen
				.getByRole("link", { name: "Open folder Product photos" })
				.element()
				.closest<HTMLElement>("[data-media-folder-card]");
			expect(gridTarget).not.toBeNull();
			expect(gridSource).toHaveAttribute("data-media-draggable", "true");
			await simulateMediaDrop(item, folder);
			await vi.waitFor(() => expect(onMoveMedia).toHaveBeenCalledWith(item, folder));
			expect(onOpenFolder).not.toHaveBeenCalled();
			expect(screen.getByRole("heading", { name: "Media details" }).query()).toBeNull();
			await expect
				.element(screen.getByText("Moved to Product photos", { exact: true }))
				.toBeVisible();
			const successToast = screen
				.getByRole("dialog", { name: "Moved to Product photos" })
				.element();
			expect(successToast.querySelector("[data-toast-icon]")).not.toBeNull();

			await screen.getByRole("tab", { name: "List view" }).click();
			const listSource = [...screen.getByRole("table").element().querySelectorAll("tr")].find(
				(row) => row.textContent?.includes("photo.jpg"),
			);
			const listTarget = screen
				.getByRole("link", { name: "Open folder Product photos" })
				.element()
				.closest<HTMLElement>("tr");
			expect(listSource).not.toBeNull();
			expect(listTarget).not.toBeNull();
			expect(listSource).toHaveAttribute("data-media-draggable", "true");
			await simulateMediaDrop(item, folder);
			await vi.waitFor(() => expect(onMoveMedia).toHaveBeenCalledTimes(2));
			expect(onOpenFolder).not.toHaveBeenCalled();
		});

		it("uses a Phosphor file icon in the drag preview", async () => {
			const item = makeLocalMediaItem();
			await renderLibrary({
				folders: [makeFolder()],
				items: [item],
				pagination: makePagination(),
				canMoveMedia: () => true,
				onMoveMedia: vi.fn().mockResolvedValue(undefined),
			});
			const active = { data: { current: { kind: "local-media", item } } };
			dndState.props?.onDragStart?.({ active });

			await vi.waitFor(() => {
				const overlay = document.querySelector("[data-media-drag-overlay]");
				expect(overlay).not.toBeNull();
				expect(overlay?.querySelector("svg")).not.toBeNull();
				expect(overlay).toHaveTextContent("photo.jpg");
			});
			dndState.props?.onDragCancel?.({ active });
		});

		it("keeps the ordinary media click available when drag is eligible", async () => {
			const onMoveMedia = vi.fn().mockResolvedValue(undefined);
			const screen = await renderLibrary({
				folders: [makeFolder()],
				items: [makeLocalMediaItem()],
				pagination: makePagination(),
				canMoveMedia: () => true,
				onMoveMedia,
			});
			const source = screen.getByRole("button", { name: "photo.jpg" }).element();

			source.click();

			expect(onMoveMedia).not.toHaveBeenCalled();
			await expect
				.element(screen.getByRole("heading", { name: "Media details" }))
				.toBeInTheDocument();
		});

		it("cancels drag safely and ignores the current folder and read-only media", async () => {
			const folder = makeFolder();
			const onMoveMedia = vi.fn().mockResolvedValue(undefined);
			const onOpenFolder = vi.fn();
			const screen = await renderLibrary({
				folders: [folder],
				items: [makeLocalMediaItem()],
				pagination: makePagination(),
				canMoveMedia: () => true,
				onMoveMedia,
				onOpenFolder,
			});
			const folderLink = screen.getByRole("link", { name: "Open folder Product photos" });
			const active = { data: { current: { kind: "local-media", item: makeLocalMediaItem() } } };
			dndState.props?.onDragStart?.({ active });
			dndState.props?.onDragCancel?.({ active });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(onMoveMedia).not.toHaveBeenCalled();
			expect(onOpenFolder).not.toHaveBeenCalled();
			window.dispatchEvent(new PointerEvent("pointerup"));
			const releaseClick = new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				button: 0,
			});
			folderLink.element().dispatchEvent(releaseClick);
			expect(releaseClick.defaultPrevented).toBe(true);
			expect(onOpenFolder).not.toHaveBeenCalled();
			await new Promise((resolve) => setTimeout(resolve, 1));
			const normalClick = new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				button: 0,
			});
			folderLink.element().dispatchEvent(normalClick);
			expect(onOpenFolder).toHaveBeenCalledTimes(1);
			onOpenFolder.mockClear();
			dndState.props?.onDragStart?.({ active });
			window.dispatchEvent(new Event("blur"));
			folderLink
				.element()
				.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
			expect(onOpenFolder).toHaveBeenCalledTimes(1);

			await screen.rerender(
				<QueryWrapper>
					<MediaLibrary
						folders={[folder]}
						items={[makeLocalMediaItem({ folderId: folder.id })]}
						pagination={makePagination()}
						canMoveMedia={() => true}
						onMoveMedia={onMoveMedia}
					/>
				</QueryWrapper>,
			);
			await simulateMediaDrop(makeLocalMediaItem({ folderId: folder.id }), folder);
			expect(onMoveMedia).not.toHaveBeenCalled();

			await screen.rerender(
				<QueryWrapper>
					<MediaLibrary
						folders={[folder]}
						items={[makeLocalMediaItem()]}
						pagination={makePagination()}
						canMoveMedia={() => false}
						onMoveMedia={onMoveMedia}
					/>
				</QueryWrapper>,
			);
			await simulateMediaDrop(makeLocalMediaItem(), folder);
			expect(onMoveMedia).not.toHaveBeenCalled();
		});

		it("prevents duplicate moves while pending and permits retry after localized failure", async () => {
			const folder = makeFolder();
			const item = makeLocalMediaItem();
			let resolveMove: (() => void) | undefined;
			const pendingMove = new Promise<void>((resolve) => {
				resolveMove = resolve;
			});
			const onMoveMedia = vi.fn().mockReturnValueOnce(pendingMove);
			const screen = await renderLibrary({
				folders: [folder],
				items: [item],
				pagination: makePagination(),
				canMoveMedia: () => true,
				onMoveMedia,
			});
			await simulateMediaDrop(item, folder);
			await vi.waitFor(() => expect(onMoveMedia).toHaveBeenCalledTimes(1));
			await simulateMediaDrop(item, folder);
			expect(onMoveMedia).toHaveBeenCalledTimes(1);
			resolveMove?.();
			await expect
				.element(screen.getByText("Moved to Product photos", { exact: true }))
				.toBeInTheDocument();

			onMoveMedia.mockRejectedValueOnce(
				new ApiResponseError(404, "NOT_FOUND", "Media folder not found"),
			);
			await simulateMediaDrop(item, folder);
			await expect
				.element(screen.getByText("Couldn’t move file", { exact: true }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByText("The file or folder no longer exists.", { exact: true }))
				.toBeInTheDocument();
			expect(
				screen
					.getByRole("dialog", { name: "Couldn’t move file" })
					.element()
					.querySelector("[data-toast-icon]"),
			).not.toBeNull();
			expect(screen.getByText("Media folder not found").query()).toBeNull();

			onMoveMedia.mockResolvedValueOnce(undefined);
			await simulateMediaDrop(item, folder);
			await vi.waitFor(() => expect(onMoveMedia).toHaveBeenCalledTimes(3));
		});

		it("keeps folder rows before media in list view", async () => {
			const screen = await renderLibrary({
				folders: [makeFolder()],
				items: [makeMediaItem({ filename: "photo.jpg" })],
				pagination: makePagination(),
				canManageFolders: true,
				onCreateFolder: vi.fn().mockResolvedValue(makeFolder()),
				onRenameFolder: vi.fn().mockResolvedValue(makeFolder()),
				onDeleteFolder: vi.fn().mockResolvedValue(undefined),
			});

			await screen.getByRole("tab", { name: "List view" }).click();
			expect(screen.getByRole("heading", { name: "Folders" }).query()).toBeNull();
			const rows = screen.getByRole("row").all();
			const folderRow = rows[1]?.element();
			expect(folderRow).toHaveTextContent("Product photos");
			const folderCells = folderRow?.querySelectorAll("td");
			const folderLink = screen.getByRole("link", { name: "Open folder Product photos" });
			const editFolder = screen.getByRole("button", { name: "Edit folder Product photos" });
			expect(folderCells?.[1]).toContainElement(editFolder.element());
			const folderLinkBox = folderLink.element().getBoundingClientRect();
			const editFolderBox = editFolder.element().getBoundingClientRect();
			expect(editFolderBox.left - folderLinkBox.right).toBeLessThanOrEqual(8);
			expect(folderLink.element().querySelector('[dir="auto"]')).toHaveTextContent(
				"Product photos",
			);
			expect(folderCells?.[2]).toHaveTextContent("Type: Folder");
			expect(folderCells?.[3]).toHaveTextContent("Size is not applicable to folders");
			expect(folderCells?.[4]).toHaveTextContent("Alt text is not applicable to folders");
			expect(rows[2]?.element()).toHaveTextContent("photo.jpg");
		});

		it("renders the initial folder loader and error inside the list table", async () => {
			const onRetryFolders = vi.fn();
			const screen = await renderLibrary({
				foldersLoading: true,
				items: [makeMediaItem({ filename: "photo.jpg" })],
				pagination: makePagination(),
				onRetryFolders,
			});

			await screen.getByRole("tab", { name: "List view" }).click();
			let rows = screen.getByRole("row").all();
			expect(rows[1]?.element()).toHaveTextContent("Loading folders");
			expect(rows[1]?.element().querySelector("td")).toHaveAttribute("colspan", "5");
			expect(rows[2]?.element()).toHaveTextContent("photo.jpg");

			await screen.rerender(
				<QueryWrapper>
					<MediaLibrary
						foldersError={new Error("offline")}
						items={[makeMediaItem({ filename: "photo.jpg" })]}
						pagination={makePagination()}
						onRetryFolders={onRetryFolders}
					/>
				</QueryWrapper>,
			);
			rows = screen.getByRole("row").all();
			expect(rows[1]?.element()).toHaveTextContent("Folders could not be loaded.");
			expect(rows[1]?.element().querySelector("td")).toHaveAttribute("colspan", "5");
			await screen.getByRole("button", { name: "Retry" }).click();
			expect(onRetryFolders).toHaveBeenCalledTimes(1);
			expect(rows[2]?.element()).toHaveTextContent("photo.jpg");
		});

		it("orders later folder-page errors and load more before media rows", async () => {
			const onRetryFolders = vi.fn();
			const onLoadMoreFolders = vi.fn();
			const screen = await renderLibrary({
				folders: [makeFolder()],
				foldersError: new Error("offline"),
				hasMoreFolders: true,
				onRetryFolders,
				onLoadMoreFolders,
				items: [makeMediaItem({ filename: "photo.jpg" })],
				pagination: makePagination(),
			});

			await screen.getByRole("tab", { name: "List view" }).click();
			const rows = screen.getByRole("row").all();
			expect(rows[1]?.element()).toHaveTextContent("Product photos");
			expect(rows[2]?.element()).toHaveTextContent("Folders could not be loaded.");
			expect(rows[3]?.element()).toHaveTextContent("Load more folders");
			expect(rows[4]?.element()).toHaveTextContent("photo.jpg");
			await screen.getByRole("button", { name: "Retry" }).click();
			await screen.getByRole("button", { name: "Load more folders" }).click();
			expect(onRetryFolders).toHaveBeenCalledTimes(1);
			expect(onLoadMoreFolders).toHaveBeenCalledTimes(1);
		});

		it("shows folders instead of the whole-library empty state", async () => {
			const screen = await renderLibrary({ folders: [makeFolder()], items: [] });

			await expect.element(screen.getByText("Product photos").first()).toBeInTheDocument();
			expect(screen.getByText("Your media library is empty").query()).toBeNull();
		});

		it("marks folder results busy while loading another bounded page", async () => {
			const screen = await renderLibrary({
				folders: [makeFolder()],
				isLoadingMoreFolders: true,
				hasMoreFolders: true,
				onLoadMoreFolders: vi.fn(),
			});

			const folderSection = screen
				.getByRole("heading", { name: "Folders" })
				.element()
				.closest("section");
			expect(folderSection).toHaveAttribute("aria-busy", "true");
			await expect.element(screen.getByText("Loading folders")).toBeInTheDocument();
		});

		it("shows Back and breadcrumbs inside a folder and hides local creation actions", async () => {
			const onBackToMain = vi.fn();
			const screen = await renderLibrary({
				folderId: "folder-1",
				currentFolder: makeFolder(),
				canManageFolders: true,
				onBackToMain,
			});

			const back = screen.getByRole("link", { name: "Back" });
			const modifiedClick = new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				metaKey: true,
			});
			back.element().dispatchEvent(modifiedClick);
			expect(modifiedClick.defaultPrevented).toBe(false);
			expect(onBackToMain).not.toHaveBeenCalled();
			back.element().click();
			expect(onBackToMain).toHaveBeenCalledTimes(1);
			await expect.element(screen.getByRole("heading", { name: "Media Library" })).toHaveFocus();
			const currentFolder = screen.getByText("Product photos").first();
			await expect.element(currentFolder).toBeInTheDocument();
			expect(currentFolder.element()).toHaveAttribute("dir", "auto");
			const rootCrumb = screen.getByRole("link", { name: "Media Library" }).first();
			expect(getComputedStyle(rootCrumb.element()).fontSize).toBe(
				getComputedStyle(currentFolder.element()).fontSize,
			);
			expect(screen.getByRole("button", { name: "Add new folder" }).query()).toBeNull();
			expect(screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }).query()).toBeNull();
		});

		it("keeps browsing available without folder-management permission", async () => {
			const folder = makeFolder();
			const onOpenFolder = vi.fn();
			const screen = await renderLibrary({
				folders: [folder],
				pagination: makePagination(),
				canManageFolders: false,
				onOpenFolder,
				onCreateFolder: vi.fn(),
				onRenameFolder: vi.fn(),
				onDeleteFolder: vi.fn(),
			});

			expect(screen.getByRole("button", { name: "Add new folder" }).query()).toBeNull();
			expect(screen.getByRole("button", { name: "Edit folder Product photos" }).query()).toBeNull();
			await screen.getByRole("link", { name: "Open folder Product photos" }).click();
			expect(onOpenFolder).toHaveBeenCalledWith(folder);
		});

		it("hides folders on later pages and while a MIME filter is active", async () => {
			const screen = await renderLibrary({
				folders: [makeFolder()],
				items: [makeMediaItem()],
				pagination: makePagination({ page: 2, totalCount: 70 }),
			});

			expect(screen.getByRole("heading", { name: "Folders" }).query()).toBeNull();
			await screen.rerender(
				<QueryWrapper>
					<MediaLibrary
						folders={[makeFolder()]}
						items={[makeMediaItem()]}
						pagination={makePagination({ page: 1, totalCount: 70 })}
					/>
				</QueryWrapper>,
			);
			await screen.getByRole("combobox", { name: "Filter by type" }).click();
			await screen.getByRole("option", { name: "Images" }).click();
			expect(screen.getByRole("heading", { name: "Folders" }).query()).toBeNull();
		});

		it("hides retained folder query state from a filtered list", async () => {
			const screen = await renderLibrary({
				folders: [makeFolder()],
				foldersLoading: true,
				foldersError: new Error("offline"),
				hasMoreFolders: true,
				isLoadingMoreFolders: true,
				onLoadMoreFolders: vi.fn(),
				onRetryFolders: vi.fn(),
				items: [makeMediaItem()],
				pagination: makePagination(),
			});

			await screen.getByRole("tab", { name: "List view" }).click();
			await screen.getByRole("combobox", { name: "Filter by type" }).click();
			await screen.getByRole("option", { name: "Images" }).click();

			expect(screen.getByRole("link", { name: "Open folder Product photos" }).query()).toBeNull();
			expect(screen.getByText("Loading folders").query()).toBeNull();
			expect(screen.getByText("Folders could not be loaded.").query()).toBeNull();
			expect(screen.getByRole("button", { name: "Retry" }).query()).toBeNull();
			expect(screen.getByRole("button", { name: "Load more folders" }).query()).toBeNull();
			expect(screen.getByRole("table").element()).not.toHaveAttribute("aria-busy");
		});

		it("shows global folder results while searching from a named folder", async () => {
			const onLocalSearchChange = vi.fn();
			const onOpenFolder = vi.fn();
			const screen = await renderLibrary({
				folderId: "folder-current",
				currentFolder: makeFolder({ id: "folder-current", name: "Current" }),
				folders: [makeFolder({ id: "folder-result", name: "Product photos" })],
				items: [makeMediaItem()],
				pagination: makePagination(),
				onLocalSearchChange,
				onOpenFolder,
			});

			await screen.getByRole("searchbox", { name: "Search media" }).fill("product");
			await expect.element(screen.getByRole("heading", { name: "Folders" })).toBeInTheDocument();
			await expect
				.element(screen.getByRole("link", { name: "Open folder Product photos" }))
				.toBeInTheDocument();
			await screen.getByRole("link", { name: "Open folder Product photos" }).click();
			expect(onLocalSearchChange).toHaveBeenLastCalledWith("");
			expect(onOpenFolder).toHaveBeenCalledWith(expect.objectContaining({ id: "folder-result" }));
		});

		it("disables local page-drop upload while inside a folder", async () => {
			const onUpload = vi.fn();
			const screen = await renderLibrary({
				folderId: "folder-1",
				currentFolder: makeFolder(),
				onUpload,
			});

			dropFiles(window, [new File(["image"], "dropped.jpg", { type: "image/jpeg" })]);

			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(onUpload).not.toHaveBeenCalled();
			expect(screen.getByText("Drop files to upload").query()).toBeNull();
		});

		it("keeps media usable when folders fail and offers retry", async () => {
			const onRetryFolders = vi.fn();
			const screen = await renderLibrary({
				foldersError: new Error("offline"),
				onRetryFolders,
				items: [makeMediaItem()],
				pagination: makePagination(),
			});

			await expect
				.element(screen.getByRole("alert"))
				.toHaveTextContent("Folders could not be loaded.");
			await screen.getByRole("button", { name: "Retry" }).click();
			expect(onRetryFolders).toHaveBeenCalledTimes(1);
			await expect.element(screen.getByAltText("photo.jpg")).toBeInTheDocument();
		});

		it("does not claim the library is empty when folder loading fails", async () => {
			const screen = await renderLibrary({
				foldersError: new Error("offline"),
				onRetryFolders: vi.fn(),
			});

			await expect.element(screen.getByText("Folders could not be loaded.")).toBeInTheDocument();
			expect(screen.getByText("Your media library is empty").query()).toBeNull();
		});

		it("does not claim there are no matches when folder search fails", async () => {
			const screen = await renderLibrary({
				foldersError: new Error("offline"),
				onRetryFolders: vi.fn(),
			});

			await screen.getByRole("searchbox", { name: "Search media" }).fill("missing");

			await expect.element(screen.getByText("Folders could not be loaded.")).toBeInTheDocument();
			expect(screen.getByText("No matching media").query()).toBeNull();
			expect(screen.getByRole("button", { name: "Clear search" }).query()).toBeNull();
		});

		it("displays media items in grid view by default", async () => {
			const items = [
				makeMediaItem({ id: "1", filename: "image1.jpg" }),
				makeMediaItem({ id: "2", filename: "image2.jpg" }),
			];
			const screen = await renderLibrary({ items });
			// Grid view is default — items render as buttons with alt text
			await expect.element(screen.getByRole("tab", { name: "Grid view" })).toBeInTheDocument();
			// Images should be present via their img alt attributes
			await expect.element(screen.getByAltText("image1.jpg")).toBeInTheDocument();
			await expect.element(screen.getByAltText("image2.jpg")).toBeInTheDocument();
		});

		it("grid items show image thumbnails for image mimeTypes", async () => {
			const items = [
				makeMediaItem({
					id: "1",
					filename: "pic.jpg",
					mimeType: "image/jpeg",
					focalX: 0.2,
					focalY: 0.8,
				}),
			];
			const screen = await renderLibrary({ items });
			const img = screen.getByAltText("pic.jpg");
			await expect.element(img).toBeInTheDocument();
			await expect.element(img).toHaveAttribute("src", "https://example.com/photo.jpg");
			expect(img.element().style.objectPosition).toBe("20% 80%");
		});

		it("shows filenames and file formats on local grid cards", async () => {
			const longFilename = "annual-report-final-approved-version.jpg";
			const screen = await renderLibrary({
				items: [
					makeMediaItem({
						id: "image-1",
						filename: longFilename,
						alt: "An annual report cover",
						mimeType: "image/jpeg",
					}),
					makeMediaItem({
						id: "document-1",
						filename: "annual-report.pdf",
						mimeType: "application/pdf",
					}),
				],
			});

			await expect.element(screen.getByText("JPEG", { exact: true })).toBeInTheDocument();
			await expect.element(screen.getByText("PDF", { exact: true })).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: longFilename, exact: true }))
				.toBeInTheDocument();
		});
	});

	describe("view mode toggle", () => {
		it("switches between grid and list view", async () => {
			const items = [makeMediaItem({ id: "1", filename: "test.jpg" })];
			const screen = await renderLibrary({ items });

			// Default is grid
			const listBtn = screen.getByRole("tab", { name: "List view" });
			await listBtn.click();

			// In list view, filename appears in table cell
			await expect.element(screen.getByText("test.jpg")).toBeInTheDocument();
			// Table headers should be visible
			await expect.element(screen.getByText("Filename")).toBeInTheDocument();
			await expect.element(screen.getByText("Type", { exact: true })).toBeInTheDocument();
			await expect.element(screen.getByText("Size")).toBeInTheDocument();
		});
	});

	describe("upload", () => {
		it("opens an empty upload dialog from the page action", async () => {
			const onUpload = vi.fn();
			const screen = await renderLibrary({ onUpload });

			screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }).first().element().click();

			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: "Browse files", exact: true }))
				.toBeInTheDocument();
			expect(onUpload).not.toHaveBeenCalled();
		});

		it("opens the same empty dialog from the empty-state action", async () => {
			const screen = await renderLibrary();

			screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }).last().element().click();

			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
		});

		it("opens the upload dialog and caps parallel uploads at three", async () => {
			const pending: Array<{ file: File; resolve: () => void }> = [];
			const onUpload = vi.fn(
				(file: File, _options?: { signal?: AbortSignal }) =>
					new Promise<void>((resolve) => {
						pending.push({ file, resolve });
					}),
			);
			const screen = await renderLibrary({ onUpload });
			const files = ["one.jpg", "two.jpg", "three.jpg", "four.jpg"].map(
				(name) => new File([name], name, { type: "image/jpeg" }),
			);

			screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }).first().element().click();
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
			setInputFiles(
				screen.getByLabelText("Browse files to upload").element() as HTMLInputElement,
				files,
			);

			await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(3));
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
			await expect.element(screen.getByText("Queued", { exact: true })).toBeInTheDocument();

			const firstSignal = onUpload.mock.calls[0]?.[1]?.signal;
			screen.getByRole("button", { name: "Cancel one.jpg" }).element().click();
			expect(firstSignal?.aborted).toBe(true);
			await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(4));
			pending.forEach(({ resolve }) => resolve());
		});

		it("clears the page overlay when a file drag leaves the window", async () => {
			const screen = await renderLibrary();
			const transfer = new DataTransfer();
			transfer.items.add(new File(["image"], "dragged.jpg", { type: "image/jpeg" }));
			window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true }));
			await expect.element(screen.getByText("Drop files to upload")).toBeInTheDocument();

			window.dispatchEvent(new DragEvent("dragleave", { relatedTarget: null, bubbles: true }));

			await vi.waitFor(() => expect(screen.getByText("Drop files to upload").query()).toBeNull());
		});

		it("opens the same direct-upload dialog for files dropped on the page", async () => {
			const onUpload = vi.fn().mockResolvedValue(undefined);
			const screen = await renderLibrary({ onUpload });
			const files = [
				new File(["image"], "dropped.jpg", { type: "image/jpeg" }),
				new File(["pdf"], "notes.pdf", { type: "application/pdf" }),
			];

			dropFiles(window, files);

			await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
		});

		it("retries one failed file without restarting completed files", async () => {
			const onUpload = vi
				.fn<(file: File) => Promise<void>>()
				.mockRejectedValueOnce(new Error("network"))
				.mockResolvedValue(undefined);
			const screen = await renderLibrary({ onUpload });

			screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }).first().element().click();
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
			setInputFiles(screen.getByLabelText("Browse files to upload").element() as HTMLInputElement, [
				new File(["broken"], "broken.jpg", { type: "image/jpeg" }),
			]);

			await expect.element(screen.getByText("Upload failed", { exact: true })).toBeInTheDocument();
			screen.getByRole("button", { name: "Retry broken.jpg" }).element().click();

			await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
			await expect.element(screen.getByText("Complete", { exact: true })).toBeInTheDocument();
		});
	});

	describe("item selection", () => {
		it.each([
			{
				label: "owner",
				role: 30,
				authorId: "user-1",
				duplicate: true,
				replace: true,
			},
			{
				label: "another author",
				role: 30,
				authorId: "user-2",
				duplicate: true,
				replace: false,
			},
			{
				label: "subscriber",
				role: 10,
				authorId: "user-1",
				duplicate: false,
				replace: false,
			},
		])("derives crop actions for an $label", async (testCase) => {
			setupMocks.role = testCase.role;
			const item = makeLocalMediaItem({
				status: "ready",
				authorId: testCase.authorId,
				url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'/%3E",
			});
			const screen = await renderLibrary({ items: [item] });

			await screen.getByRole("button", { name: "photo.jpg" }).click();
			screen.getByRole("tab", { name: "Edit image" }).element().click();
			const crop = screen.getByRole("tab", { name: "Crop" });
			if (!testCase.duplicate && !testCase.replace) {
				expect(crop.query()).toBeNull();
				return;
			}
			await expect.element(crop).toBeVisible();
			crop.element().click();
			await expect.element(screen.getByLabelText("Crop output dimensions")).toBeVisible();

			expect(screen.getByRole("button", { name: "Create cropped copy" }).query() !== null).toBe(
				testCase.duplicate,
			);
			expect(screen.getByRole("button", { name: "Replace original" }).query() !== null).toBe(
				testCase.replace,
			);
		});

		it("clicking an item opens detail dialog", async () => {
			const items = [makeMediaItem({ id: "1", filename: "photo.jpg", alt: "A photo" })];
			const screen = await renderLibrary({ items });

			// Click the grid item button
			await screen.getByRole("button", { name: "photo.jpg" }).click();

			// MediaDetailPanel should open showing the item details
			await expect.element(screen.getByText("Media details")).toBeInTheDocument();
		});

		it("opens the detail dialog on an animation frame so Kumo entry animation runs", async () => {
			let openFrame: FrameRequestCallback | undefined;
			const requestAnimationFrameSpy = vi
				.spyOn(window, "requestAnimationFrame")
				.mockImplementation((callback) => {
					openFrame = callback;
					return 1;
				});
			const cancelAnimationFrameSpy = vi
				.spyOn(window, "cancelAnimationFrame")
				.mockImplementation(() => undefined);

			try {
				const items = [makeMediaItem({ id: "1", filename: "photo.jpg", alt: "A photo" })];
				const screen = await renderLibrary({ items });

				await screen.getByRole("button", { name: "photo.jpg" }).click();

				expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
				await expect
					.element(screen.getByText("Media details"), { timeout: 100 })
					.not.toBeInTheDocument();

				openFrame?.(performance.now());

				await expect.element(screen.getByText("Media details")).toBeInTheDocument();
			} finally {
				requestAnimationFrameSpy.mockRestore();
				cancelAnimationFrameSpy.mockRestore();
			}
		});

		it("preserves unsaved alt text when the media list refetches the same item", async () => {
			const item = makeMediaItem({ id: "1", filename: "photo.jpg", alt: "Server alt" });
			const screen = await renderLibrary({ items: [item] });

			await screen.getByRole("button", { name: "photo.jpg" }).click();
			await screen.getByLabelText("Alt Text").fill("Unsaved alt");

			await screen.rerender(
				<QueryWrapper>
					<MediaLibrary
						items={[makeMediaItem({ id: "1", filename: "photo.jpg", alt: "Refetched alt" })]}
						isLoading={false}
					/>
				</QueryWrapper>,
			);

			await expect.element(screen.getByLabelText("Alt Text")).toHaveValue("Unsaved alt");
		});

		it("deletes from the detail dialog with one local delete call", async () => {
			const onItemUpdated = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "photo.jpg" })];
			const screen = await renderLibrary({ items, onItemUpdated });

			await screen.getByRole("button", { name: "photo.jpg" }).click();
			screen.getByRole("button", { name: "Delete" }).element().click();
			await expect.element(screen.getByText("Delete media?")).toBeInTheDocument();
			screen.getByRole("button", { name: "Delete" }).all().at(-1)!.element().click();

			await vi.waitFor(() => {
				expect(deleteMedia).toHaveBeenCalledTimes(1);
				expect(deleteMedia).toHaveBeenCalledWith("1");
				expect(onItemUpdated).toHaveBeenCalledTimes(1);
			});
		});

		it("focuses the persistent heading after deleting the last asset", async () => {
			function Harness() {
				const [items, setItems] = React.useState([
					makeMediaItem({ id: "1", filename: "photo.jpg" }),
				]);
				return <MediaLibrary items={items} isLoading={false} onItemUpdated={() => setItems([])} />;
			}

			const screen = await render(
				<QueryWrapper>
					<Harness />
				</QueryWrapper>,
			);

			await screen.getByRole("button", { name: "photo.jpg" }).click();
			screen.getByRole("button", { name: "Delete" }).element().click();
			await expect.element(screen.getByText("Delete media?")).toBeInTheDocument();
			screen.getByRole("button", { name: "Delete" }).all().at(-1)!.element().click();

			await vi.waitFor(() => {
				expect(document.activeElement).toBe(
					screen.getByRole("heading", { name: "Media Library", exact: true }).element(),
				);
			});
		});
	});

	describe("empty state", () => {
		it("shows upload CTA when no items", async () => {
			const screen = await renderLibrary({ items: [] });
			await expect.element(screen.getByText("Your media library is empty")).toBeInTheDocument();
			await expect.element(screen.getByText(UPLOAD_CTA_PATTERN)).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }).last())
				.toBeInTheDocument();
		});
	});

	describe("loading state", () => {
		it("displays loading state", async () => {
			const screen = await renderLibrary({ isLoading: true });
			// When loading, neither empty state nor items are shown
			expect(screen.getByText("Your media library is empty").query()).toBeNull();
		});
	});

	describe("list view details", () => {
		it("list view shows table with filename and details", async () => {
			const items = [
				makeMediaItem({
					id: "1",
					filename: "document.pdf",
					mimeType: "application/pdf",
					size: 1048576,
				}),
			];
			const screen = await renderLibrary({ items });

			// Switch to list view
			await screen.getByRole("tab", { name: "List view" }).click();

			await expect.element(screen.getByText("document.pdf")).toBeInTheDocument();
			await expect.element(screen.getByText("application/pdf")).toBeInTheDocument();
			await expect.element(screen.getByText("1 MB")).toBeInTheDocument();
		});
	});

	describe("header", () => {
		it("shows Media Library heading", async () => {
			const screen = await renderLibrary();
			await expect
				.element(screen.getByRole("heading", { name: "Media Library", exact: true }))
				.toBeInTheDocument();
		});
	});

	describe("legacy load more compatibility", () => {
		it("keeps hasMore and onLoadMore working when numbered pagination is absent", async () => {
			const onLoadMore = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, hasMore: true, onLoadMore });

			await screen.getByRole("button", { name: "Load More" }).click();

			expect(onLoadMore).toHaveBeenCalledTimes(1);
		});

		it("uses numbered pagination instead when both prop shapes are provided", async () => {
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({
				items,
				hasMore: true,
				onLoadMore: vi.fn(),
				pagination: makePagination(),
			});

			await expect
				.element(screen.getByRole("navigation", { name: "Media pagination" }))
				.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Load More" }).query()).toBeNull();
		});
	});

	describe("numbered pagination", () => {
		it("renders localized Kumo controls with the exact range and total", async () => {
			const onPageChange = vi.fn();
			const onPageSizeChange = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({
				items,
				pagination: makePagination({ onPageChange, onPageSizeChange }),
			});

			await expect
				.element(screen.getByRole("navigation", { name: "Media pagination" }))
				.toBeInTheDocument();
			await expect.element(screen.getByText("Showing 1-35 of 37")).toBeInTheDocument();
			expect(screen.getByText("37 items", { exact: true }).query()).toBeNull();
			await expect
				.element(screen.getByRole("combobox", { name: "Page number" }))
				.toBeInTheDocument();

			await screen.getByRole("button", { name: "Next page" }).click();
			expect(onPageChange).toHaveBeenCalledWith(2);

			await screen.getByRole("combobox", { name: "Page size" }).click();
			await screen.getByRole("option", { name: "70" }).click();
			expect(onPageSizeChange).toHaveBeenCalledWith(70);
		});

		it("uses the page input above the dropdown page-count bound", async () => {
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({
				items,
				pagination: makePagination({ totalCount: 3535 }),
			});

			await expect
				.element(screen.getByRole("textbox", { name: "Page number" }))
				.toBeInTheDocument();
			expect(screen.getByRole("combobox", { name: "Page number" }).query()).toBeNull();
		});

		it("keeps control styling stable while another page loads", async () => {
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({
				items,
				pagination: makePagination({ isPending: true }),
			});

			const nextPage = screen.getByRole("button", { name: "Next page" });
			await expect.element(nextPage).not.toBeDisabled();
			expect(nextPage.element().closest("[inert]")).not.toBeNull();
		});

		it("restores focus to the pagination control after a page finishes loading", async () => {
			function Harness() {
				const [page, setPage] = React.useState(1);
				const [isPending, setIsPending] = React.useState(false);
				return (
					<>
						<MediaLibrary
							items={[makeMediaItem({ id: String(page), filename: `page-${page}.jpg` })]}
							pagination={makePagination({
								page,
								totalCount: 90,
								isPending,
								onPageChange(nextPage) {
									setPage(nextPage);
									setIsPending(true);
								},
							})}
						/>
						<button type="button" onClick={() => setIsPending(false)}>
							Finish page request
						</button>
					</>
				);
			}

			const screen = await render(
				<QueryWrapper>
					<Harness />
				</QueryWrapper>,
			);

			const nextPage = screen.getByRole("button", { name: "Next page" });
			await nextPage.click();
			await screen.getByRole("button", { name: "Finish page request" }).click();

			await vi.waitFor(() => {
				expect(document.activeElement).toBe(nextPage.element());
			});
		});
	});

	// #1221: the local library gained filename search + a type filter.
	describe("local search and filter", () => {
		it("reports the debounced filename query upward", async () => {
			const onLocalSearchChange = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, onLocalSearchChange });

			await screen.getByRole("searchbox", { name: "Search media" }).fill("vacation");

			await vi.waitFor(() => {
				expect(onLocalSearchChange).toHaveBeenCalledWith("vacation");
			});
		});

		it("reports a MIME filter when a type is chosen", async () => {
			const onLocalMimeFilterChange = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, onLocalMimeFilterChange });

			// Open the type filter and choose Images.
			await screen.getByRole("combobox", { name: "Filter by type" }).click();
			await screen.getByRole("option", { name: "Images" }).click();

			expect(onLocalMimeFilterChange).toHaveBeenCalledWith("image/");
		});

		it("does not flash the empty-library state while clearing a zero-result search", async () => {
			function Harness() {
				const [search, setSearch] = React.useState("");
				const items = search ? [] : [makeMediaItem({ id: "1", filename: "restored.jpg" })];

				return <MediaLibrary items={items} onLocalSearchChange={setSearch} isLoading={false} />;
			}

			const screen = await render(
				<QueryWrapper>
					<Harness />
				</QueryWrapper>,
			);

			await screen.getByRole("searchbox", { name: "Search media" }).fill("missing");
			await expect.element(screen.getByText("No matching media")).toBeInTheDocument();

			await screen.getByRole("searchbox", { name: "Search media" }).fill("");

			expect(screen.getByText("Your media library is empty").query()).toBeNull();
			await expect.element(screen.getByAltText("restored.jpg")).toBeInTheDocument();
		});

		it("does not make provider media draggable into local folders", async () => {
			const api = await import("../../src/lib/api");
			(api.fetchMediaProviders as any).mockResolvedValueOnce([
				{
					id: "cloudflare-images",
					name: "Cloudflare Images",
					capabilities: { browse: true, search: false, upload: false, delete: false },
				},
			]);
			(api.fetchProviderMedia as any).mockResolvedValueOnce({
				items: [
					{
						id: "provider-1",
						filename: "provider.jpg",
						mimeType: "image/jpeg",
						previewUrl: "https://example.com/provider.jpg",
						size: 100,
					},
				],
			});

			const screen = await renderLibrary({
				items: [makeLocalMediaItem()],
				folders: [makeFolder()],
				pagination: makePagination(),
				canMoveMedia: () => true,
				onMoveMedia: vi.fn().mockResolvedValue(undefined),
			});
			await screen.getByRole("tab", { name: "Cloudflare Images" }).click();

			const providerCard = screen.getByRole("button", { name: "provider.jpg" });
			await expect.element(providerCard).toBeInTheDocument();
			expect(providerCard.element()).not.toHaveAttribute("data-media-draggable");
			expect(screen.getByRole("heading", { name: "Folders" }).query()).toBeNull();
		});

		it("does not keep the local filter toolbar visible on empty provider tabs", async () => {
			const api = await import("../../src/lib/api");
			(api.fetchMediaProviders as any).mockResolvedValueOnce([
				{
					id: "cloudflare-images",
					name: "Cloudflare Images",
					capabilities: { browse: true, search: false, upload: false, delete: false },
				},
			]);

			const screen = await renderLibrary({
				items: [makeMediaItem({ id: "1", filename: "a.jpg" })],
				folders: [makeFolder()],
				pagination: makePagination(),
			});

			await screen.getByRole("combobox", { name: "Filter by type" }).click();
			await screen.getByRole("option", { name: "Images" }).click();
			await screen.getByRole("tab", { name: "Cloudflare Images" }).click();

			await expect.element(screen.getByText("No media found")).toBeInTheDocument();
			expect(screen.getByRole("navigation", { name: "Media pagination" }).query()).toBeNull();
			expect(screen.getByRole("tab", { name: "Grid view" }).query()).toBeNull();
			expect(screen.getByRole("tab", { name: "List view" }).query()).toBeNull();
			expect(screen.getByRole("heading", { name: "Folders" }).query()).toBeNull();
		});
	});

	describe("provider items", () => {
		const STREAM_SIZE = 75431883;
		const STREAM_POSTER =
			"https://customer-abc123.cloudflarestream.com/UID/thumbnails/thumbnail.jpg";

		// A Cloudflare Stream item: not an image, poster in `previewUrl`, and the
		// byte size reported only under `meta`.
		function makeStreamProviderItem(overrides: Partial<MediaProviderItem> = {}): MediaProviderItem {
			return {
				id: "6a4677c7694f6e2e4270540231dd47ff",
				filename: "webinar.mp4",
				mimeType: "video/mp4",
				previewUrl: STREAM_POSTER,
				width: 1280,
				height: 720,
				meta: { size: STREAM_SIZE },
				...overrides,
			};
		}

		async function renderStreamTab(item: MediaProviderItem = makeStreamProviderItem()) {
			const api = await import("../../src/lib/api");
			(api.fetchMediaProviders as any).mockResolvedValue([
				{
					id: "cloudflare-stream",
					name: "Cloudflare Stream",
					capabilities: { browse: true, search: false, upload: false, delete: false },
				},
			]);
			(api.fetchProviderMedia as any).mockResolvedValue({ items: [item] });

			const screen = await renderLibrary({ items: [] });
			await screen.getByRole("tab", { name: "Cloudflare Stream" }).click();
			return screen;
		}

		it("renders the provider poster for an item that is not an image", async () => {
			const screen = await renderStreamTab();

			const poster = screen.getByAltText("webinar.mp4");
			await expect.element(poster).toBeInTheDocument();
			expect(poster.element().getAttribute("src")).toBe(STREAM_POSTER);
			await expect.element(screen.getByText("MP4", { exact: true })).toBeInTheDocument();
		});

		it("shows a size the provider reports only under meta", async () => {
			const screen = await renderStreamTab();
			await screen.getByRole("tab", { name: "List view" }).click();

			await expect.element(screen.getByText("71.9 MB")).toBeInTheDocument();
		});
	});
});
