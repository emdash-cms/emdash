import { i18n } from "@lingui/core";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { KeptNotice } from "../../src/components/co-editing/KeptNotice";
import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor";
import { EntryLockNotice } from "../../src/components/EntryLockNotice";
import type { ContentItem } from "../../src/lib/api";
import type { RichTextBinding, RoomEditing, RoomSaveState } from "../../src/lib/co-editing/types";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context";
import { render } from "../utils/render.tsx";

/** Stands in for the rich-text editor, which reads its value once, like the real one. */
const richText = vi.hoisted(() => ({
	mounts: 0,
	props: null as Record<string, unknown> | null,
}));
vi.mock("../../src/components/PortableTextEditor", () => ({
	PortableTextEditor: (props: Record<string, unknown>) => {
		richText.props = props;
		React.useEffect(() => {
			richText.mounts++;
		}, []);
		return <div data-testid="portable-text-editor" />;
	},
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => null,
	useHasApplicableTaxonomies: () => false,
}));

vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => null,
}));

type BlockerOptions = {
	shouldBlockFn: (args: {
		current: { pathname: string };
		next: { pathname: string };
	}) => boolean | Promise<boolean>;
	disabled?: boolean;
};
const blocker = vi.hoisted(() => ({ options: null as BlockerOptions | null }));
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
			<a {...props}>{children}</a>
		),
		useBlocker: (options: BlockerOptions) => {
			blocker.options = options;
			return { status: "idle" };
		},
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
		fetchRevisions: vi.fn(async () => ({ items: [], total: 0 })),
	};
});

const AUTOSAVE_DELAY = 2000;
const SAVED: RoomSaveState = { covered: true, saving: false, rev: "rev-1" };
const UNSAVED: RoomSaveState = { covered: false, saving: false, rev: "rev-1" };
const SAVING: RoomSaveState = { covered: false, saving: true, rev: "rev-1" };

/** A room's document as the editor sees it, with a way to play another client's edits. */
function createRoom(initial: Record<string, unknown>) {
	const values = new Map(Object.entries(initial));
	const fieldListeners = new Map<string, Set<() => void>>();
	const remoteVersions = new Map<string, number>();
	const saveListeners = new Set<() => void>();
	const subscriptions: string[] = [];
	const bindings = new Map<string, RichTextBinding>();
	let saveState = SAVED;

	const notify = (field: string) => {
		for (const listener of fieldListeners.get(field) ?? []) listener();
	};
	const setSaveState = (next: RoomSaveState) => {
		saveState = next;
		for (const listener of saveListeners) listener();
	};
	const set = vi.fn((changes: Readonly<Record<string, unknown>>) => {
		for (const [field, value] of Object.entries(changes)) values.set(field, value);
		for (const field of Object.keys(changes)) notify(field);
		setSaveState(UNSAVED);
	});
	const whenCovered = vi.fn((_options: { save: boolean }) => Promise.resolve());

	const room: RoomEditing = {
		id: "replica-1",
		fields: {
			subscribe(field, listener) {
				subscriptions.push(field);
				let listeners = fieldListeners.get(field);
				if (!listeners) fieldListeners.set(field, (listeners = new Set()));
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			get: (field) => values.get(field) ?? null,
			set,
			read: (fields) =>
				Object.fromEntries(fields.map((field) => [field, values.get(field) ?? null])),
			remoteVersion: (field) => remoteVersions.get(field) ?? 0,
		},
		subscribe(listener) {
			saveListeners.add(listener);
			return () => saveListeners.delete(listener);
		},
		getSaveState: () => saveState,
		whenCovered,
		richText(field) {
			let binding = bindings.get(field);
			if (!binding) bindings.set(field, (binding = { extensions: [] }));
			return binding;
		},
		captureDraft: () => ({ values: {}, rev: null, sequence: 0, replica: "replica-1" }),
		changedSince: () => false,
	};

	return {
		room,
		set,
		whenCovered,
		subscriptions,
		setSaveState,
		value: (field: string) => values.get(field),
		/** Another client's change, as the replica reports it. */
		remote(changes: Record<string, unknown>) {
			for (const [field, value] of Object.entries(changes)) {
				values.set(field, value);
				remoteVersions.set(field, (remoteVersions.get(field) ?? 0) + 1);
			}
			for (const field of Object.keys(changes)) notify(field);
		},
	};
}

const FIELDS: Record<string, FieldDescriptor> = {
	title: { kind: "string", label: "Title" },
	summary: { kind: "string", label: "Summary" },
};

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "my-post",
		status: "draft",
		data: { title: "My Post", summary: "Stored summary" },
		authorId: null,
		createdAt: "2026-01-15T10:30:00Z",
		updatedAt: "2026-01-15T10:30:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		...overrides,
	};
}

function editorProps(
	room: RoomEditing | null,
	props: Partial<ContentEditorProps> = {},
): ContentEditorProps {
	return {
		collection: "posts",
		collectionLabel: "Post",
		fields: FIELDS,
		item: makeItem(),
		onSave: vi.fn(),
		onAutosave: vi.fn(),
		room,
		roomOffline: false,
		...props,
	};
}

let unmounts: Array<() => Promise<void>> = [];

async function renderEditor(room: RoomEditing | null, props: Partial<ContentEditorProps> = {}) {
	const screen = await render(<ContentEditor {...editorProps(room, props)} />);
	unmounts.push(() => screen.unmount());
	return screen;
}

function saveButton(): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(
		'[data-emdash-editor-bar] button[type="submit"]',
	)!;
}

afterEach(async () => {
	// One at a time: overlapping unmounts leave the next test's render blank.
	for (const unmount of unmounts) await unmount();
	unmounts = [];
	blocker.options = null;
	richText.mounts = 0;
	richText.props = null;
});

describe("ContentEditor in a room", () => {
	it("writes edits to the room and never saves them itself", async () => {
		const fake = createRoom({ title: "My Post", summary: "Room summary", slug: "my-post" });
		const onSave = vi.fn();
		const onAutosave = vi.fn();
		const screen = await renderEditor(fake.room, { onSave, onAutosave });
		const summary = screen.getByRole("textbox", { name: "Summary" });

		await expect.element(summary).toHaveValue("Room summary");
		await summary.fill("Typed in the room");
		expect(fake.set).toHaveBeenLastCalledWith({ summary: "Typed in the room" });
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();

		await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY + 500));
		expect(onAutosave).not.toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("keeps the caret where the writer types when the value round-trips through the room", async () => {
		const fake = createRoom({ title: "My Post", summary: "ac", slug: "my-post" });
		const screen = await renderEditor(fake.room);
		const summary = screen.getByRole("textbox", { name: "Summary" });
		const input = summary.element() as HTMLInputElement;

		input.focus();
		input.setSelectionRange(1, 1);
		await userEvent.keyboard("b");

		expect(fake.value("summary")).toBe("abc");
		expect(input.selectionStart).toBe(2);
	});

	it("saves by asking the room for a kept checkpoint", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const onSave = vi.fn();
		const screen = await renderEditor(fake.room, { onSave });

		await expect.element(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
		fake.setSaveState(UNSAVED);
		await screen.getByRole("button", { name: "Save" }).click();

		expect(fake.whenCovered).toHaveBeenCalledExactlyOnceWith({ save: true });
		expect(onSave).not.toHaveBeenCalled();
		fake.setSaveState(SAVING);
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeVisible();
		fake.setSaveState(SAVED);
		await expect.element(screen.getByRole("button", { name: "Saved" })).toBeVisible();
	});

	it("guards leaving while the room hasn't saved this tab's edits", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		await renderEditor(fake.room);
		const leave = { current: { pathname: "/content/posts/item-1" }, next: { pathname: "/" } };

		expect(blocker.options?.disabled).toBe(true);
		fake.setSaveState(UNSAVED);
		await expect.poll(() => blocker.options?.disabled).toBe(false);

		// The room saves in time: leave without asking, and without asking it for a kept save.
		await expect(blocker.options!.shouldBlockFn(leave)).resolves.toBe(false);
		expect(fake.whenCovered).toHaveBeenLastCalledWith({ save: false });

		// It doesn't: ask once the wait is over.
		fake.whenCovered.mockImplementation(() => new Promise(() => {}));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const blocked = Promise.resolve(blocker.options!.shouldBlockFn(leave));
			let settled = false;
			void blocked.finally(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(2900);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(100);
			await expect(blocked).resolves.toBe(true);
		} finally {
			vi.useRealTimers();
		}

		// A refused or offline save asks at once.
		fake.whenCovered.mockImplementation(() => Promise.reject(new Error("offline")));
		await expect(blocker.options!.shouldBlockFn(leave)).resolves.toBe(true);

		fake.setSaveState(SAVED);
		await expect.poll(() => blocker.options?.disabled).toBe(true);
	});
});

describe("ContentEditor fields in a room", () => {
	function countingWidgets() {
		const renders: Record<string, number> = {};
		const mounts: Record<string, number> = {};
		const Widget = ({
			id,
			value,
			onChange,
		}: {
			id: string;
			value: unknown;
			onChange(v: unknown): void;
		}) => {
			renders[id] = (renders[id] ?? 0) + 1;
			React.useEffect(() => {
				mounts[id] = (mounts[id] ?? 0) + 1;
			}, [id]);
			return (
				<input
					id={id}
					aria-label={id}
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		};
		const pluginAdmins: PluginAdmins = { counter: { fields: { text: Widget } } };
		return { renders, mounts, pluginAdmins };
	}

	const WIDGET_FIELDS: Record<string, FieldDescriptor> = {
		title: { kind: "string", label: "Title" },
		first: { kind: "string", label: "First", widget: "counter:text" },
		second: { kind: "string", label: "Second", widget: "counter:text" },
		content: { kind: "portableText", label: "Content" },
	};

	async function renderWidgets(fake: ReturnType<typeof createRoom>) {
		const widgets = countingWidgets();
		const screen = await render(
			<PluginAdminProvider pluginAdmins={widgets.pluginAdmins}>
				<ContentEditor {...editorProps(fake.room, { fields: WIDGET_FIELDS })} />
			</PluginAdminProvider>,
		);
		unmounts.push(() => screen.unmount());
		return { screen, ...widgets };
	}

	it("renders each field under its own subscription", async () => {
		const fake = createRoom({ title: "My Post", first: "one", second: "two", slug: "my-post" });
		const { screen, renders } = await renderWidgets(fake);
		await expect.element(screen.getByRole("textbox", { name: "field-first" })).toHaveValue("one");

		for (const name of ["first", "second", "content"]) {
			expect(document.querySelector(`[data-co-editing-field="${name}"]`)).not.toBeNull();
		}
		expect(fake.subscriptions.filter((field) => field === "first")).toHaveLength(1);
		expect(fake.subscriptions.filter((field) => field === "second")).toHaveLength(1);
		// The bound rich-text editor renders the room's fragment itself.
		expect(fake.subscriptions).not.toContain("content");

		const secondRenders = renders["field-second"];
		fake.remote({ first: "changed elsewhere" });
		await expect
			.element(screen.getByRole("textbox", { name: "field-first" }))
			.toHaveValue("changed elsewhere");
		expect(renders["field-second"]).toBe(secondRenders);
	});

	it("remounts a widget after another client's change, once focus has left it", async () => {
		const fake = createRoom({ title: "My Post", first: "one", second: "two", slug: "my-post" });
		const { screen, mounts } = await renderWidgets(fake);
		const first = screen.getByRole("textbox", { name: "field-first" });
		await expect.element(first).toHaveValue("one");
		expect(mounts["field-first"]).toBe(1);

		fake.remote({ first: "unfocused change" });
		await expect.poll(() => mounts["field-first"]).toBe(2);

		(first.element() as HTMLInputElement).focus();
		fake.remote({ first: "focused change" });
		await expect.element(first).toHaveValue("focused change");
		expect(mounts["field-first"]).toBe(2);
		// An own edit is no reason to remount.
		await userEvent.keyboard("!");
		expect(fake.value("first")).toBe("focused change!");
		expect(mounts["field-first"]).toBe(2);

		(screen.getByRole("textbox", { name: "field-second" }).element() as HTMLInputElement).focus();
		await expect.poll(() => mounts["field-first"]).toBe(3);
		expect(mounts["field-second"]).toBe(1);
	});

	it("binds rich text to the room and keeps the editor through a refetch", async () => {
		const fake = createRoom({ title: "My Post", slug: "my-post" });
		const fields: Record<string, FieldDescriptor> = {
			title: { kind: "string", label: "Title" },
			content: { kind: "portableText", label: "Content" },
		};
		const props = editorProps(fake.room, { fields });
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());
		await expect.element(screen.getByTestId("portable-text-editor")).toBeInTheDocument();
		expect(richText.mounts).toBe(1);
		expect(richText.props?.collaboration).toBe(fake.room.richText("content"));

		const refetched = makeItem({
			updatedAt: "2026-01-15T11:00:00Z",
			data: { title: "Saved by the room", content: [] },
		});
		await screen.rerender(<ContentEditor {...props} item={refetched} />);
		await expect.element(screen.getByRole("textbox", { name: "Title" })).toHaveValue("My Post");
		expect(richText.mounts).toBe(1);

		// The refetch never reached the single-editor form either.
		await screen.rerender(<ContentEditor {...props} item={refetched} room={null} />);
		await expect.element(screen.getByRole("textbox", { name: "Title" })).toHaveValue("My Post");
	});
});

describe("ContentEditor auto-slug in a room", () => {
	it("derives the slug while it is empty or still the title's own", async () => {
		const fake = createRoom({ title: "", summary: "", slug: null });
		const screen = await renderEditor(fake.room, { item: makeItem({ slug: null }) });
		const title = screen.getByRole("textbox", { name: "Title" });

		await title.fill("Hello");
		expect(fake.set).toHaveBeenLastCalledWith({ title: "Hello", slug: "hello" });

		// A peer's title edit carries its own slug, which this tab's next edit follows.
		fake.remote({ title: "Peer title", slug: "peer-title" });
		await expect.element(title).toHaveValue("Peer title");
		await title.fill("Peer title again");
		expect(fake.value("slug")).toBe("peer-title-again");

		// A slug someone typed stays.
		fake.remote({ slug: "typed-slug" });
		await title.fill("Another title");
		expect(fake.set).toHaveBeenLastCalledWith({ title: "Another title" });
		expect(fake.value("slug")).toBe("typed-slug");
	});

	it("leaves the slug alone for an entry that had one when it opened", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "" });
		const screen = await renderEditor(fake.room, { item: makeItem({ slug: "my-post" }) });

		await screen.getByRole("textbox", { name: "Title" }).fill("Renamed");

		expect(fake.set).toHaveBeenLastCalledWith({ title: "Renamed" });
	});
});

describe("ContentEditor's save button in a room", () => {
	it("reads Offline in the same place and at the same size as its other states", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const props = editorProps(fake.room);
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());
		const boxes: Record<string, DOMRect> = {};
		const measure = async (label: string) => {
			await expect.element(screen.getByRole("button", { name: label })).toBeVisible();
			// The label swap animates; measure once it has settled.
			await new Promise((resolve) => setTimeout(resolve, 400));
			boxes[label] = saveButton().getBoundingClientRect();
		};

		await measure("Saved");
		fake.setSaveState(UNSAVED);
		await measure("Save");
		fake.setSaveState(SAVING);
		await measure("Saving...");
		fake.setSaveState(UNSAVED);
		await screen.rerender(<ContentEditor {...props} roomOffline roomBlocked />);
		await measure("Offline");

		expect(saveButton()).toBeDisabled();
		for (const box of Object.values(boxes)) {
			expect(box.left).toBeCloseTo(boxes.Saved!.left, 1);
			expect(box.width).toBeCloseTo(boxes.Saved!.width, 1);
			expect(box.height).toBeCloseTo(boxes.Saved!.height, 1);
		}
		await screen.getByRole("textbox", { name: "Summary" }).fill("Typed offline");
		expect(fake.set).toHaveBeenLastCalledWith({ summary: "Typed offline" });
		saveButton().form?.requestSubmit();
		expect(fake.whenCovered).not.toHaveBeenCalled();
	});
});

describe("ContentEditor's notices in a room", () => {
	it.each([
		{ locale: "en", dir: "ltr" },
		{ locale: "ar", dir: "rtl" },
	])("keeps the edits for copying once they can't be saved ($dir)", async ({ locale, dir }) => {
		const previousLocale = i18n.locale;
		const previousDir = document.documentElement.dir;
		i18n.load(locale, {});
		i18n.activate(locale);
		document.documentElement.dir = dir;
		try {
			const fake = createRoom({ title: "My Post", summary: "Kept summary", slug: "my-post" });
			fake.setSaveState(UNSAVED);
			const onReload = vi.fn();
			const screen = await renderEditor(fake.room, {
				roomBlocked: true,
				notice: <KeptNotice onReload={onReload} />,
			});
			const notice = screen
				.getByRole("alert")
				.filter({ hasText: "These edits can no longer be saved" });
			await expect.element(notice).toBeVisible();
			await expect.element(screen.getByRole("textbox", { name: "Summary" })).toBeEnabled();
			expect(saveButton()).toBeDisabled();

			const reload = screen.getByRole("button", { name: "Reload" });
			const noticeBox = notice.element().getBoundingClientRect();
			const reloadBox = reload.element().getBoundingClientRect();
			const noticeCenter = noticeBox.left + noticeBox.width / 2;
			if (dir === "rtl") expect(reloadBox.right).toBeLessThan(noticeCenter);
			else expect(reloadBox.left).toBeGreaterThan(noticeCenter);

			await reload.click();
			expect(onReload).toHaveBeenCalledOnce();
			expect(fake.whenCovered).not.toHaveBeenCalled();
		} finally {
			document.documentElement.dir = previousDir;
			i18n.activate(previousLocale);
		}
	});

	it.each([
		{ locale: "en", dir: "ltr" },
		{ locale: "ar", dir: "rtl" },
	])(
		"shows the save button's Offline state and the join status ($dir)",
		async ({ locale, dir }) => {
			const previousLocale = i18n.locale;
			const previousDir = document.documentElement.dir;
			i18n.load(locale, {});
			i18n.activate(locale);
			document.documentElement.dir = dir;
			try {
				const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
				const props = editorProps(fake.room, { roomOffline: true, roomBlocked: true });
				const screen = await render(<ContentEditor {...props} />);
				unmounts.push(() => screen.unmount());
				const offline = screen.getByRole("button", { name: "Offline" });
				await expect.element(offline).toBeDisabled();
				const label = saveButton().querySelector("[data-save-button-visible-state] span")!;
				const [icon, text] = [label.firstElementChild!, label.lastElementChild!].map((element) =>
					element.getBoundingClientRect(),
				);
				if (dir === "rtl") expect(icon!.left).toBeGreaterThan(text!.left);
				else expect(icon!.left).toBeLessThan(text!.left);

				await screen.rerender(
					<ContentEditor
						{...props}
						readOnly
						room={null}
						roomOffline={false}
						roomStatus="waiting"
					/>,
				);
				await expect
					.element(screen.getByRole("status").filter({ hasText: "Waiting to join…" }))
					.toBeVisible();
				await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
			} finally {
				document.documentElement.dir = previousDir;
				i18n.activate(previousLocale);
			}
		},
	);
});

describe("EntryLockNotice for a room", () => {
	const ROOM_HOLDER = { userId: "", userName: null, acquiredAt: "", expiresAt: "" };

	it("offers to join the people editing together", async () => {
		const onTakeOver = vi.fn();
		const screen = await render(
			<EntryLockNotice
				state={{ status: "reading", holder: ROOM_HOLDER, room: true }}
				onTakeOver={onTakeOver}
				onReadInstead={vi.fn()}
				isTakingOver={false}
			/>,
		);

		await expect.element(screen.getByText("People are editing this entry together")).toBeVisible();
		await expect
			.element(screen.getByText("Another editor", { exact: false }))
			.not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Join" }).click();
		expect(onTakeOver).toHaveBeenCalledOnce();
	});

	it("only explains, without a dialog, once the browser session can't join rooms", async () => {
		const screen = await render(
			<EntryLockNotice
				state={{ status: "blocked", holder: ROOM_HOLDER, room: true }}
				onTakeOver={vi.fn()}
				onReadInstead={vi.fn()}
				isTakingOver={false}
				canJoin={false}
			/>,
		);

		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("This browser can’t join them, so nothing you change here will be saved.");
		expect(page.getByRole("alertdialog").elements()).toHaveLength(0);
		expect(screen.getByRole("button").elements()).toHaveLength(0);
	});
});
