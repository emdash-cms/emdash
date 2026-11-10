import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor";
import { EntryLockNotice } from "../../src/components/EntryLockNotice";
import {
	fetchReferenceChildren,
	type AdminManifest,
	type BylineSummary,
	type ContentItem,
} from "../../src/lib/api";
import { RoomOperationsContext, type RoomOperations } from "../../src/lib/co-editing/operations";
import { RoomSaveError, type RoomEditing } from "../../src/lib/co-editing/types";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context";
import { createRoom, SAVED, SAVING, UNSAVED } from "../co-editing/fake-room";
import { LoopbackRoom, settle } from "../co-editing/loopback-room";
import {
	resetTransportHealth,
	startSession,
	type TestSession,
} from "../co-editing/session-harness";
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
		fetchReferenceChildren: vi.fn(async () => ({ children: [] })),
		fetchRevisions: vi.fn(async () => ({ items: [], total: 0 })),
		getPreviewUrl: vi.fn(async () => ({ url: "/posts/my-post?_preview=token" })),
	};
});

const AUTOSAVE_DELAY = 2000;

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
		roomSync: null,
		...props,
	};
}

let unmounts: Array<() => Promise<void>> = [];
let sessions: TestSession[] = [];

async function renderEditor(room: RoomEditing | null, props: Partial<ContentEditorProps> = {}) {
	const screen = await render(<ContentEditor {...editorProps(room, props)} />);
	unmounts.push(() => screen.unmount());
	return screen;
}

function saveButton(): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(
		"[data-emdash-editor-bar] button:has([data-save-button-labels])",
	)!;
}

afterEach(async () => {
	// One at a time: overlapping unmounts leave the next test's render blank.
	for (const unmount of unmounts) await unmount();
	unmounts = [];
	for (const { session } of sessions) session.dispose();
	sessions = [];
	resetTransportHealth();
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

	it("guards leaving while edits from before joining aren't kept, once the room is gone", async () => {
		await renderEditor(null, { unkeptEdits: true });
		const leave = { current: { pathname: "/content/posts/item-1" }, next: { pathname: "/" } };

		await expect.poll(() => blocker.options?.disabled).toBe(false);
		expect(await blocker.options!.shouldBlockFn(leave)).toBe(true);
	});

	it("keeps the fields' height while they load after a reset, so the page doesn't scroll", async () => {
		const fields: Record<string, FieldDescriptor> = Object.fromEntries(
			Array.from({ length: 12 }, (_, index) => [
				`line_${index}`,
				{ kind: "string", label: `Line ${index}` },
			]),
		);
		const fake = createRoom({ slug: "my-post" });
		const props = editorProps(fake.room, { fields });
		const inPage = (editor: React.ReactElement) => <div style={{ height: 600 }}>{editor}</div>;
		const screen = await render(inPage(<ContentEditor {...props} />));
		unmounts.push(() => screen.unmount());
		await expect.element(screen.getByRole("textbox", { name: "Line 11" })).toBeVisible();
		const canvas = document.querySelector<HTMLElement>("[data-emdash-editor-canvas]")!;
		canvas.scrollTop = canvas.scrollHeight;
		const top = canvas.scrollTop;
		expect(top).toBeGreaterThan(0);

		await screen.rerender(
			inPage(<ContentEditor {...props} room={null} roomResetting fieldsLoading />),
		);

		await expect.element(screen.getByRole("status", { name: "Loading" })).toBeVisible();
		expect(screen.getByRole("textbox", { name: "Line 11" }).query()).toBeNull();
		expect(canvas.scrollTop).toBe(top);
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

	it("remounts a widget after a peer's change on the room's replica, at once or when focus leaves it", async () => {
		const loopback = new LoopbackRoom({
			seed: (doc) => {
				const values = doc.getMap("fields");
				values.set("title", "My Post");
				values.set("first", "one");
				values.set("second", "two");
				values.set("slug", "my-post");
			},
		});
		const session = startSession(loopback, {}, []);
		sessions.push(session);
		await settle();
		const view = session.view();
		if (view.mode !== "room") throw new Error(`Expected a room, got ${view.mode}`);
		const peer = loopback.peer().getMap("fields");
		const widgets = countingWidgets();
		const screen = await render(
			<PluginAdminProvider pluginAdmins={widgets.pluginAdmins}>
				<ContentEditor
					{...editorProps(view.room, {
						fields: {
							title: WIDGET_FIELDS.title!,
							first: WIDGET_FIELDS.first!,
							second: WIDGET_FIELDS.second!,
						},
					})}
				/>
			</PluginAdminProvider>,
		);
		unmounts.push(() => screen.unmount());
		const first = screen.getByRole("textbox", { name: "field-first" });
		await expect.element(first).toHaveValue("one");
		expect(widgets.mounts["field-first"]).toBe(1);

		peer.set("first", "unfocused change");
		await expect.element(first).toHaveValue("unfocused change");
		await expect.poll(() => widgets.mounts["field-first"]).toBe(2);

		(first.element() as HTMLInputElement).focus();
		peer.set("first", "focused change");
		await expect.element(first).toHaveValue("focused change");
		await userEvent.keyboard("!");
		await expect.poll(() => view.room.fields.get("first")).toBe("focused change!");
		expect(widgets.mounts["field-first"]).toBe(2);

		(screen.getByRole("textbox", { name: "field-second" }).element() as HTMLInputElement).focus();
		await expect.poll(() => widgets.mounts["field-first"]).toBe(3);
		await expect.element(first).toHaveValue("focused change!");
		expect(widgets.mounts["field-second"]).toBe(1);
	});

	it("says when a widget's rich text can't be saved, and writes none of it", async () => {
		const loopback = new LoopbackRoom({
			seed: (doc) => {
				doc.getMap("fields").set("title", "My Post");
				doc.getMap("fields").set("slug", "my-post");
			},
		});
		const session = startSession(loopback, {}, ["notes"]);
		sessions.push(session);
		await settle();
		const view = session.view();
		if (view.mode !== "room") throw new Error(`Expected a room, got ${view.mode}`);
		const span = (text: string, marks: string[]) => [
			{
				_type: "block",
				_key: "k-1",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", _key: "k-1-s", text, marks }],
			},
		];
		const NotesWidget = ({ onChange }: { onChange(value: unknown): void }) => (
			<>
				<button type="button" onClick={() => onChange(span("Glowing", ["glow"]))}>
					Glow
				</button>
				<button type="button" onClick={() => onChange(span("Plain", []))}>
					Plain
				</button>
			</>
		);
		const screen = await render(
			<PluginAdminProvider pluginAdmins={{ notes: { fields: { rich: NotesWidget } } }}>
				<ContentEditor
					{...editorProps(view.room, {
						fields: {
							title: { kind: "string", label: "Title" },
							notes: { kind: "portableText", label: "Notes", widget: "notes:rich" },
						},
					})}
				/>
			</PluginAdminProvider>,
		);
		unmounts.push(() => screen.unmount());
		const refusal = screen.getByText("Your change to Notes wasn’t saved");

		await screen.getByRole("button", { name: "Glow" }).click();

		await expect.element(refusal).toBeInTheDocument();
		expect(view.room.fields.get("notes")).toEqual([]);
		expect(view.room.getSaveState().covered).toBe(true);

		await screen.getByRole("button", { name: "Plain" }).click();

		await expect.element(refusal).not.toBeInTheDocument();
		expect(view.room.fields.get("notes")).toMatchObject([{ children: [{ text: "Plain" }] }]);
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
	it("reads every state in the same place and at the same size", async () => {
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
		await screen.rerender(<ContentEditor {...props} roomSync={{ kind: "offline" }} roomBlocked />);
		await measure("Offline");
		await screen.rerender(
			<ContentEditor
				{...props}
				readOnly
				room={null}
				roomSync={{ kind: "joining", waiting: false }}
				roomBlocked
			/>,
		);
		await measure("Joining…");
		await screen.rerender(
			<ContentEditor
				{...props}
				roomSync={{ kind: "not-saved", reason: "deleted", reload: vi.fn() }}
				roomBlocked
			/>,
		);
		await measure("Not saved");

		expect(Object.keys(boxes)).toHaveLength(6);
		for (const box of Object.values(boxes)) {
			expect(box.left).toBeCloseTo(boxes.Saved!.left, 1);
			expect(box.width).toBeCloseTo(boxes.Saved!.width, 1);
			expect(box.height).toBeCloseTo(boxes.Saved!.height, 1);
		}
	});

	it("announces the save state once", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		await renderEditor(fake.room);
		const announcements = () =>
			Array.from(document.querySelectorAll('[role="status"]'), (region) =>
				region.textContent?.trim(),
			).filter(Boolean);

		await expect.poll(announcements).toEqual(["Saved"]);
		fake.setSaveState(SAVING);
		await expect.poll(announcements).toEqual(["Saving..."]);
		fake.setSaveState(UNSAVED);
		await expect.poll(announcements).toEqual(["Unsaved changes"]);
	});

	it("explains Offline when selected, without saving", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const onSave = vi.fn();
		const screen = await renderEditor(fake.room, {
			onSave,
			roomSync: { kind: "offline" },
			roomBlocked: true,
		});
		const offline = screen.getByRole("button", { name: "Offline" });
		await expect.element(offline).toBeEnabled();
		expect(screen.getByRole("dialog").query()).toBeNull();

		await screen.getByRole("textbox", { name: "Summary" }).fill("Typed offline");
		expect(fake.set).toHaveBeenLastCalledWith({ summary: "Typed offline" });
		const submitted = vi.fn((event: Event) => event.preventDefault());
		saveButton().form!.addEventListener("submit", submitted);
		await offline.click();

		const popover = screen.getByRole("dialog", { name: "You’re offline" });
		await expect.element(popover).toBeVisible();
		await expect.element(popover).toHaveTextContent(/save when you’re back online/);
		expect(submitted).not.toHaveBeenCalled();
		expect(fake.whenCovered).not.toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();

		await userEvent.keyboard("{Escape}");
		await expect.element(popover).not.toBeInTheDocument();
	});

	it("doesn't tell a reader to keep typing offline", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const screen = await renderEditor(fake.room, {
			readOnly: true,
			roomSync: { kind: "offline" },
			roomBlocked: true,
		});
		await screen.getByRole("button", { name: "Offline" }).click();

		const popover = screen.getByRole("dialog", { name: "You’re offline" });
		await expect.element(popover).toHaveTextContent(/show here again once you’re back online/);
		await expect.element(popover).not.toHaveTextContent(/Keep typing/);
	});

	it("changes state on the same button, and opens Not saved by itself without taking focus", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const props = editorProps(fake.room);
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());
		const button = saveButton();
		// Outside the button, whose contents screen readers may not announce.
		const announced = () =>
			Array.from(document.querySelectorAll('[role="status"]'), (region) =>
				region.textContent?.trim(),
			)
				.filter(Boolean)
				.join(" | ");
		expect(button.querySelector('[role="status"]')).toBeNull();
		const summary = screen.getByRole("textbox", { name: "Summary" });
		await summary.click();

		await screen.rerender(<ContentEditor {...props} roomSync={{ kind: "offline" }} roomBlocked />);
		await expect.poll(announced).toBe("Offline");
		expect(screen.getByRole("dialog").query()).toBeNull();

		await screen.rerender(
			<ContentEditor
				{...props}
				roomSync={{ kind: "not-saved", reason: "deleted", reload: vi.fn() }}
				roomBlocked
			/>,
		);
		await expect
			.element(screen.getByRole("dialog", { name: "Your last edits weren’t saved" }))
			.toBeVisible();
		expect(announced()).toBe("Not saved");
		expect(document.activeElement).toBe(summary.element());

		await screen.rerender(<ContentEditor {...props} />);
		await expect.poll(announced).toBe("Saved");
		expect(saveButton()).toBe(button);
	});

	it("closes Not saved on Escape or a second select, and moves focus in on Enter", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const screen = await renderEditor(fake.room, {
			roomSync: { kind: "not-saved", reason: "access", reload: vi.fn() },
			roomBlocked: true,
		});
		const popover = screen.getByRole("dialog", { name: "Your last edits weren’t saved" });
		await expect.element(popover).toBeVisible();

		saveButton().focus();
		await userEvent.keyboard("{Escape}");
		await expect.element(popover).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Not saved" }).click();
		await expect.element(popover).toBeVisible();
		await screen.getByRole("button", { name: "Not saved" }).click();
		await expect.element(popover).not.toBeInTheDocument();

		await screen.rerender(
			<ContentEditor {...editorProps(fake.room)} roomSync={{ kind: "offline" }} roomBlocked />,
		);
		await screen.rerender(
			<ContentEditor
				{...editorProps(fake.room)}
				roomSync={{ kind: "not-saved", reason: "access", reload: vi.fn() }}
				roomBlocked
			/>,
		);
		await expect.element(popover).toBeVisible();
		saveButton().focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(popover.getByRole("button", { name: "Copy my edits" })).toHaveFocus();
	});

	it("keeps a reader's other bar actions disabled while Joining… explains", async () => {
		await renderEditor(null, {
			readOnly: true,
			roomSync: { kind: "joining", waiting: false },
			roomBlocked: true,
			supportsDrafts: true,
			supportsPreview: true,
			onPublish: vi.fn(),
			onUnpublish: vi.fn(),
		});
		await expect.element(page.getByRole("button", { name: "Joining…" })).toBeEnabled();

		const others = [
			...document.querySelectorAll<HTMLButtonElement>("[data-emdash-editor-bar] button"),
		].filter(
			(button) =>
				button !== saveButton() &&
				!/distraction-free/i.test(button.getAttribute("aria-label") ?? ""),
		);
		expect(others.length).toBeGreaterThan(1);
		for (const button of others) {
			expect(button.matches(":disabled"), button.textContent ?? "").toBe(true);
		}
	});
});

describe("ContentEditor's presence in a room", () => {
	afterEach(async () => {
		await page.viewport(1280, 800);
	});

	it.each([
		[1280, 4],
		[375, 4],
	])(
		"shows who else is here at %ipx without moving the bar or the fields",
		async (width, circles) => {
			await page.viewport(width, 800);
			const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
			await renderEditor(fake.room, { currentUser: { id: "u-me", role: 50 } });
			const bar = () => document.querySelector("[data-emdash-editor-bar]")!.getBoundingClientRect();
			const field = (name: string) =>
				document.querySelector(`[data-co-editing-field="${name}"]`)!.getBoundingClientRect();
			const layout = () => ({
				bar: bar().height,
				save: saveButton().getBoundingClientRect().left,
				title: field("title").top,
				summary: field("summary").top,
			});
			await expect.element(page.getByRole("button", { name: "Saved" })).toBeVisible();
			const alone = layout();
			const avatars = () =>
				document.querySelectorAll("[data-emdash-editor-bar] [role=group] button").length;
			const pills = (name: string) =>
				Array.from(
					document.querySelectorAll(`[data-co-editing-field="${name}"] .emdash-presence-pill`),
					(pill) => pill.textContent,
				);

			fake.present("u-me", "Me in another tab", "summary");
			fake.present("u-ana", "Ana Lima", "title");
			await expect.poll(() => pills("title")).toEqual(["Ana Lima"]);
			expect(pills("summary")).toEqual([]);
			expect(layout()).toEqual(alone);

			for (const [id, name] of [
				["u-ben", "Ben Okafor"],
				["u-cleo", "Cleo Park"],
				["u-dev", "Dev Iyer"],
			]) {
				fake.present(id!, name!);
			}
			await expect.poll(avatars).toBe(circles);
			expect(layout()).toEqual(alone);

			fake.present("u-eli", "Eli Cohen");
			fake.present("u-fay", "Fay Wong");
			await expect
				.poll(() => document.querySelector("[data-emdash-editor-bar] [role=group]")?.textContent)
				.toContain("+3");
			expect(avatars()).toBe(circles);
			expect(layout()).toEqual(alone);

			for (const id of ["u-ana", "u-ben", "u-cleo", "u-dev", "u-eli", "u-fay"]) fake.leave(id);
			await expect.poll(avatars).toBe(0);
			expect(pills("title")).toEqual([]);
			expect(layout()).toEqual(alone);
		},
	);
});

describe("ContentEditor's notices in a room", () => {
	it.each([
		{ locale: "en", dir: "ltr" },
		{ locale: "ar", dir: "rtl" },
	])(
		"explains edits it can no longer save and offers to copy them ($dir)",
		async ({ locale, dir }) => {
			const previousLocale = i18n.locale;
			const previousDir = document.documentElement.dir;
			i18n.load(locale, {});
			i18n.activate(locale);
			document.documentElement.dir = dir;
			const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
			try {
				const fake = createRoom({ title: "My Post", summary: "Kept summary", slug: "my-post" });
				fake.setSaveState(UNSAVED);
				const reload = vi.fn();
				const screen = await renderEditor(fake.room, {
					roomSync: { kind: "not-saved", reason: "access", reload },
					roomBlocked: true,
				});

				const popover = screen.getByRole("dialog", { name: "Your last edits weren’t saved" });
				await expect.element(popover).toBeVisible();
				await expect.element(popover).toHaveTextContent(/no longer have edit access/);
				await expect.element(screen.getByRole("button", { name: "Not saved" })).toBeEnabled();
				await expect.element(screen.getByRole("textbox", { name: "Summary" })).toBeEnabled();

				const copy = popover.getByRole("button", { name: "Copy my edits" });
				const reloadButton = popover.getByRole("button", { name: "Reload" });
				const [copyBox, reloadBox] = [copy, reloadButton].map((button) =>
					button.element().getBoundingClientRect(),
				);
				if (dir === "rtl") expect(copyBox!.left).toBeGreaterThan(reloadBox!.left);
				else expect(copyBox!.left).toBeLessThan(reloadBox!.left);

				await copy.click();
				expect(writeText).toHaveBeenCalledExactlyOnceWith(
					"Title\nMy Post\n\nSummary\nKept summary",
				);
				await expect.element(popover.getByRole("button", { name: "Copied" })).toBeVisible();

				await reloadButton.click();
				expect(reload).toHaveBeenCalledOnce();
				expect(fake.whenCovered).not.toHaveBeenCalled();
			} finally {
				writeText.mockRestore();
				document.documentElement.dir = previousDir;
				i18n.activate(previousLocale);
			}
		},
	);

	it("says when the edits couldn't be copied", async () => {
		const writeText = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
		try {
			const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
			const screen = await renderEditor(fake.room, {
				roomSync: { kind: "not-saved", reason: "recovery-failed", reload: vi.fn() },
				roomBlocked: true,
			});
			const popover = screen.getByRole("dialog", { name: "Your last edits weren’t saved" });
			await expect.element(popover).toHaveTextContent(/couldn’t merge them/);

			await popover.getByRole("button", { name: "Copy my edits" }).click();

			await expect
				.element(popover.getByRole("alert"))
				.toHaveTextContent("Couldn’t copy. Select the text on the page and copy it instead.");
		} finally {
			writeText.mockRestore();
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
				const props = editorProps(fake.room, {
					roomSync: { kind: "offline" },
					roomBlocked: true,
				});
				const screen = await render(<ContentEditor {...props} />);
				unmounts.push(() => screen.unmount());
				await expect.element(screen.getByRole("button", { name: "Offline" })).toBeVisible();
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
						roomSync={{ kind: "joining", waiting: true }}
					/>,
				);
				const joining = screen.getByRole("button", { name: "Joining…" });
				await expect.element(joining).toBeEnabled();
				await expect.element(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
				expect(screen.getByRole("dialog").query()).toBeNull();
				await joining.click();
				await expect
					.element(screen.getByRole("dialog", { name: "Waiting to join" }))
					.toHaveTextContent(/keeps trying every few seconds/);
			} finally {
				document.documentElement.dir = previousDir;
				i18n.activate(previousLocale);
			}
		},
	);
});

describe("ContentEditor's operations in a room", () => {
	const PUBLISHED_WITH_CHANGES = makeItem({
		status: "published",
		publishedAt: "2026-01-15T10:30:00Z",
		liveRevisionId: "rev-live",
		draftRevisionId: "rev-draft",
	});
	const operationProps = (item: ContentItem): Partial<ContentEditorProps> => ({
		item,
		supportsDrafts: true,
		supportsPreview: true,
		onPublish: vi.fn(),
		onUnpublish: vi.fn(),
		onDiscardDraft: vi.fn(),
		onSchedule: vi.fn(),
		onUnschedule: vi.fn(),
		onDelete: vi.fn(),
	});
	const editorWith = (operations: RoomOperations, props: ContentEditorProps) => (
		<RoomOperationsContext.Provider value={operations}>
			<ContentEditor {...props} />
		</RoomOperationsContext.Provider>
	);
	const buttons = (screen: Awaited<ReturnType<typeof render>>, name: string) => {
		const found = screen.getByRole("button", { name, exact: true }).elements();
		expect(found.length, name).toBeGreaterThan(0);
		return found as HTMLButtonElement[];
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disables publishing, scheduling, discarding, Trash and Preview while operations can't run", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const props = editorProps(fake.room, operationProps(PUBLISHED_WITH_CHANGES));
		const open = { prepare: vi.fn(async () => {}), blocked: false, inRoom: true };
		const blocked = { ...open, blocked: true };
		const names = [
			"Publish changes",
			"Discard changes",
			"Schedule",
			"Move to Trash",
			"Preview draft",
		];
		const screen = await render(editorWith(open, props));
		unmounts.push(() => screen.unmount());
		await expect.element(screen.getByRole("button", { name: "Move to Trash" })).toBeVisible();
		for (const name of names) {
			for (const button of buttons(screen, name)) expect(button, name).toBeEnabled();
		}

		await screen.rerender(editorWith(blocked, props));
		for (const name of names) {
			for (const button of buttons(screen, name)) expect(button, name).toBeDisabled();
		}

		const published = makeItem({
			status: "published",
			publishedAt: "2026-01-15T10:30:00Z",
			liveRevisionId: "rev-live",
		});
		await screen.rerender(editorWith(blocked, { ...props, item: published }));
		for (const button of buttons(screen, "Unpublish Post")) expect(button).toBeDisabled();
		await screen.rerender(editorWith(open, { ...props, item: published }));
		for (const button of buttons(screen, "Unpublish Post")) expect(button).toBeEnabled();
	});

	it("opens Preview's tab on the click and loads it once the room has saved, without asking for a save", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		let cover!: () => void;
		fake.whenCovered.mockImplementation(() => new Promise<void>((resolve) => (cover = resolve)));
		const tab = {
			location: { href: "about:blank" },
			opener: window,
			focus: vi.fn(),
			close: vi.fn(),
		};
		const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
		const screen = await renderEditor(fake.room, operationProps(PUBLISHED_WITH_CHANGES));

		await screen.getByRole("button", { name: "Preview draft" }).click();
		expect(open).toHaveBeenCalledExactlyOnceWith("", "emdash-preview-posts-item-1");
		expect(fake.whenCovered).toHaveBeenCalledExactlyOnceWith({ save: false });
		expect(tab.opener).toBeNull();
		expect(tab.location.href).toBe("about:blank");

		cover();
		await vi.waitFor(() => expect(tab.location.href).toBe("/posts/my-post?_preview=token"));
		expect(tab.focus).toHaveBeenCalled();
		expect(tab.close).not.toHaveBeenCalled();
	});

	it.each([
		{ tab: "the tab its click opened", location: () => ({ href: "about:blank" }), closes: true },
		{
			tab: "the entry's preview tab, already open",
			location: () => ({ href: `${window.location.origin}/posts/my-post` }),
			closes: false,
		},
		{
			tab: "the entry's preview tab, showing another site",
			location: () => {
				throw new DOMException("Blocked a frame", "SecurityError");
			},
			closes: false,
		},
	])("closes only $tab when the room's save doesn't arrive", async ({ location, closes }) => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		fake.whenCovered.mockRejectedValue(new RoomSaveError("timeout"));
		const tab = { opener: null, focus: vi.fn(), close: vi.fn() };
		Object.defineProperty(tab, "location", { get: location });
		vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
		const onPreviewNotSaved = vi.fn();
		const screen = await renderEditor(fake.room, {
			...operationProps(PUBLISHED_WITH_CHANGES),
			onPreviewNotSaved,
		});

		await screen.getByRole("button", { name: "Preview draft" }).click();
		await vi.waitFor(() => expect(onPreviewNotSaved).toHaveBeenCalledOnce());
		expect(tab.close).toHaveBeenCalledTimes(closes ? 1 : 0);
		await expect.element(screen.getByRole("button", { name: "Preview draft" })).toBeEnabled();
	});
});

describe("ContentEditor's values outside a room's document", () => {
	const MINA: BylineSummary = {
		id: "byline-mina",
		slug: "mina-patel",
		displayName: "Mina Patel",
		bio: null,
		avatarMediaId: null,
		websiteUrl: null,
		userId: null,
		isGuest: false,
		createdAt: "2025-01-15T10:30:00Z",
		updatedAt: "2025-01-15T10:30:00Z",
		locale: "en",
		translationGroup: null,
	};

	const OSCAR: BylineSummary = { ...MINA, id: "byline-oscar", slug: "oscar", displayName: "Oscar" };
	const credited = (...bylines: BylineSummary[]) =>
		makeItem({
			bylines: bylines.map((byline, sortOrder) => ({ byline, sortOrder, roleLabel: null })),
		});
	/** Answers each outside save in turn, building it from `latest` as the page would. */
	function outsideSaves(latest: () => ContentItem) {
		const sent: unknown[] = [];
		const replies: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
		const onSaveOutsideValues = vi.fn(async (changes: unknown) => {
			sent.push(typeof changes === "function" ? await changes(latest()) : changes);
			return new Promise((resolve, reject) => {
				replies.push({ resolve: () => resolve(undefined), reject });
			});
		});
		return { sent, replies, onSaveOutsideValues };
	}

	it("saves bylines at once, and keeps them in place when that save fails", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const { sent, replies, onSaveOutsideValues } = outsideSaves(() => makeItem());
		const onSave = vi.fn();
		const props = editorProps(fake.room, {
			currentUser: { id: "u-1", role: 50 },
			availableBylines: [MINA],
			availableBylinesLoaded: true,
			onSaveOutsideValues,
			onSave,
		});
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByRole("button", { name: "Add Mina Patel" }).click();
		await expect
			.poll(() => sent)
			.toEqual([
				{ bylines: [{ bylineId: "byline-mina", roleLabel: null }], expected: { bylines: [] } },
			]);
		expect(fake.set).not.toHaveBeenCalled();

		replies[0]!.reject(new Error("Refused"));
		await screen.rerender(
			<ContentEditor {...props} item={makeItem({ updatedAt: "2026-01-15T11:00:00Z" })} />,
		);
		await expect
			.element(screen.getByRole("button", { name: "More actions for Mina Patel" }))
			.toBeInTheDocument();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("sends one byline save at a time, each on the entry's latest bylines", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		let latest = makeItem();
		const { sent, replies, onSaveOutsideValues } = outsideSaves(() => latest);
		const props = editorProps(fake.room, {
			currentUser: { id: "u-1", role: 50 },
			availableBylines: [MINA, OSCAR],
			availableBylinesLoaded: true,
			onSaveOutsideValues,
		});
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByRole("button", { name: "Add Mina Patel" }).click();
		await expect.poll(() => sent).toHaveLength(1);
		// Another editor credits Oscar while this tab's save is on its way.
		latest = credited(MINA, OSCAR);
		await screen.getByRole("button", { name: "More actions for Mina Patel" }).click();
		await screen.getByRole("menuitem", { name: "Remove from post" }).click();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sent).toHaveLength(1);

		replies[0]!.resolve();
		await expect.poll(() => sent).toHaveLength(2);
		expect(sent[1]).toEqual({
			bylines: [{ bylineId: "byline-oscar", roleLabel: null }],
			expected: {
				bylines: [
					{ bylineId: "byline-mina", roleLabel: null },
					{ bylineId: "byline-oscar", roleLabel: null },
				],
			},
		});
		replies[1]!.resolve();
		await expect
			.element(screen.getByRole("button", { name: "More actions for Oscar" }))
			.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "More actions for Mina Patel" }).query()).toBeNull();
	});

	it("leaves an entry's byline save out of the entry it switched to", async () => {
		const first = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const second = createRoom({ title: "Other", summary: "", slug: "other" });
		const { sent, replies, onSaveOutsideValues } = outsideSaves(() => makeItem());
		const props = editorProps(first.room, {
			currentUser: { id: "u-1", role: 50 },
			availableBylines: [MINA],
			availableBylinesLoaded: true,
			onSaveOutsideValues,
		});
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());
		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByRole("button", { name: "Add Mina Patel" }).click();
		await expect.poll(() => sent).toHaveLength(1);

		await screen.rerender(
			<ContentEditor
				{...props}
				room={second.room}
				item={makeItem({ id: "item-2", slug: "other" })}
			/>,
		);
		replies[0]!.resolve();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByRole("button", { name: "More actions for Mina Patel" }).query()).toBeNull();
	});

	it("saves a byline change it hadn't sent once the tab joins a room", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const { sent, onSaveOutsideValues } = outsideSaves(() => makeItem());
		const props = editorProps(null, {
			currentUser: { id: "u-1", role: 50 },
			availableBylines: [MINA],
			availableBylinesLoaded: true,
			onSaveOutsideValues,
		});
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());

		await screen.getByRole("button", { name: "Choose bylines" }).click();
		await screen.getByRole("button", { name: "Add Mina Patel" }).click();
		expect(onSaveOutsideValues).not.toHaveBeenCalled();
		await screen.rerender(<ContentEditor {...props} room={fake.room} />);

		await expect
			.poll(() => sent)
			.toEqual([
				{ bylines: [{ bylineId: "byline-mina", roleLabel: null }], expected: { bylines: [] } },
			]);
		await expect
			.element(screen.getByRole("button", { name: "More actions for Mina Patel" }))
			.toBeInTheDocument();
	});

	it("saves a reference change it hadn't sent once the tab joins a room", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const entry = (id: string) => ({ id, slug: id, title: id, locale: "en", translationGroup: id });
		const item = makeItem({
			references: { related: { children: [entry("one"), entry("two")] } },
		});
		const { sent, onSaveOutsideValues } = outsideSaves(() => item);
		const props = editorProps(null, {
			fields: {
				...FIELDS,
				related: {
					kind: "reference",
					label: "Related",
					validation: { relation: "rel-1", targetCollection: "posts", multiple: true },
				},
			},
			item,
			onSaveOutsideValues,
		});
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());

		await screen.getByRole("button", { name: "Remove one" }).click();
		expect(onSaveOutsideValues).not.toHaveBeenCalled();
		await screen.rerender(<ContentEditor {...props} room={fake.room} />);

		await expect
			.poll(() => sent)
			.toEqual([
				{
					references: { related: ["two"] },
					expected: { references: { related: ["one", "two"] } },
				},
			]);
		expect(screen.getByRole("button", { name: "Remove one" }).query()).toBeNull();
	});

	it("re-bases a reference change on every page of the field", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const entry = (id: string) => ({ id, slug: id, title: id, locale: "en", translationGroup: id });
		const firstPage = makeItem({
			references: { related: { children: [entry("one"), entry("two")], nextCursor: "page-2" } },
		});
		vi.mocked(fetchReferenceChildren).mockResolvedValueOnce({
			children: [entry("three")],
		} as never);
		const { sent, onSaveOutsideValues } = outsideSaves(() => firstPage);
		const screen = await render(
			<ContentEditor
				{...editorProps(fake.room, {
					fields: {
						...FIELDS,
						related: {
							kind: "reference",
							label: "Related",
							validation: { relation: "rel-1", targetCollection: "posts", multiple: true },
						},
					},
					item: firstPage,
					onSaveOutsideValues,
				})}
			/>,
		);
		unmounts.push(() => screen.unmount());
		await expect.element(screen.getByRole("button", { name: "Remove three" })).toBeInTheDocument();

		// Someone else adds an entry on the second page.
		vi.mocked(fetchReferenceChildren).mockResolvedValueOnce({
			children: [entry("three"), entry("four")],
		} as never);
		await screen.getByRole("button", { name: "Remove one" }).click();
		await expect
			.poll(() => sent)
			.toEqual([
				{
					references: { related: ["two", "three", "four"] },
					expected: { references: { related: ["one", "two", "three", "four"] } },
				},
			]);
	});
	it("keeps every page of a reference field shown through a refetch, then shows its latest pages", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const entry = (id: string) => ({ id, slug: id, title: id, locale: "en", translationGroup: id });
		const firstPage = () =>
			makeItem({
				references: { related: { children: [entry("one"), entry("two")], nextCursor: "page-2" } },
			});
		vi.mocked(fetchReferenceChildren).mockResolvedValueOnce({
			children: [entry("three")],
		} as never);
		const props = editorProps(fake.room, {
			fields: {
				...FIELDS,
				related: {
					kind: "reference",
					label: "Related",
					validation: { relation: "rel-1", targetCollection: "posts", multiple: true },
				},
			},
			item: firstPage(),
		});
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());
		await expect.element(screen.getByRole("button", { name: "Remove three" })).toBeInTheDocument();

		const readsBefore = vi.mocked(fetchReferenceChildren).mock.calls.length;
		let secondPage: (page: { children: ReturnType<typeof entry>[] }) => void = () => {};
		vi.mocked(fetchReferenceChildren).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					secondPage = resolve as typeof secondPage;
				}) as never,
		);
		await screen.rerender(<ContentEditor {...props} item={firstPage()} />);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByRole("button", { name: "Remove three" }).query()).not.toBeNull();

		// Someone else added an entry on the second page.
		secondPage({ children: [entry("three"), entry("four")] });
		await expect.element(screen.getByRole("button", { name: "Remove four" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove three" }).query()).not.toBeNull();
		expect(vi.mocked(fetchReferenceChildren).mock.calls.length - readsBefore).toBe(1);
	});
	it("doesn't show a refetch's pages over a reference change made while it read them", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const entry = (id: string) => ({ id, slug: id, title: id, locale: "en", translationGroup: id });
		const firstPage = () =>
			makeItem({
				references: { related: { children: [entry("one"), entry("two")], nextCursor: "page-2" } },
			});
		vi.mocked(fetchReferenceChildren).mockResolvedValueOnce({
			children: [entry("three")],
		} as never);
		const { sent, replies, onSaveOutsideValues } = outsideSaves(firstPage);
		const props = editorProps(fake.room, {
			fields: {
				...FIELDS,
				related: {
					kind: "reference",
					label: "Related",
					validation: { relation: "rel-1", targetCollection: "posts", multiple: true },
				},
			},
			item: firstPage(),
			onSaveOutsideValues,
		});
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());
		await expect.element(screen.getByRole("button", { name: "Remove three" })).toBeInTheDocument();

		let refetchedPage: (page: { children: ReturnType<typeof entry>[] }) => void = () => {};
		vi.mocked(fetchReferenceChildren)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						refetchedPage = resolve as typeof refetchedPage;
					}) as never,
			)
			.mockResolvedValueOnce({ children: [entry("three")] } as never);
		await screen.rerender(<ContentEditor {...props} item={firstPage()} />);
		await screen.getByRole("button", { name: "Remove one" }).click();
		await expect.poll(() => sent).toHaveLength(1);
		replies[0]!.resolve();
		await expect
			.element(screen.getByRole("button", { name: "Remove one" }))
			.not.toBeInTheDocument();

		refetchedPage({ children: [entry("three"), entry("four")] });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByRole("button", { name: "Remove one" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Remove four" }).query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Remove three" })).toBeInTheDocument();
	});
	it("shows a later refetch's list over the pages an earlier one was still reading", async () => {
		const fake = createRoom({ title: "My Post", summary: "", slug: "my-post" });
		const entry = (id: string) => ({ id, slug: id, title: id, locale: "en", translationGroup: id });
		const paged = () =>
			makeItem({
				references: { related: { children: [entry("one"), entry("two")], nextCursor: "page-2" } },
			});
		vi.mocked(fetchReferenceChildren).mockResolvedValueOnce({
			children: [entry("three")],
		} as never);
		const props = editorProps(fake.room, {
			fields: {
				...FIELDS,
				related: {
					kind: "reference",
					label: "Related",
					validation: { relation: "rel-1", targetCollection: "posts", multiple: true },
				},
			},
			item: paged(),
		});
		const screen = await render(<ContentEditor {...props} />);
		unmounts.push(() => screen.unmount());
		await expect.element(screen.getByRole("button", { name: "Remove three" })).toBeInTheDocument();

		let earlierPages: (page: { children: ReturnType<typeof entry>[] }) => void = () => {};
		vi.mocked(fetchReferenceChildren).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					earlierPages = resolve as typeof earlierPages;
				}) as never,
		);
		await screen.rerender(<ContentEditor {...props} item={paged()} />);
		// Someone else removed entries, so the field now fits on one page.
		await screen.rerender(
			<ContentEditor
				{...props}
				item={makeItem({ references: { related: { children: [entry("one")] } } })}
			/>,
		);
		await expect
			.element(screen.getByRole("button", { name: "Remove two" }))
			.not.toBeInTheDocument();

		earlierPages({ children: [entry("three")] });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByRole("button", { name: "Remove two" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Remove three" }).query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Remove one" })).toBeInTheDocument();
	});
});

describe("ContentEditor's editor-draft plugins in a room", () => {
	const MANIFEST = {
		version: "1.0.0",
		hash: "manifest-1",
		authMode: "passkey",
		collections: {},
		taxonomies: [],
		plugins: {
			writer: {
				enabled: true,
				adminMode: "blocks",
				editorActions: [
					{
						id: "suggest",
						label: "Suggest a title",
						route: "suggest",
						placement: "toolbar",
						draft: { read: { fields: ["title", "summary"] }, patch: { fields: ["title"] } },
					},
				],
			},
		},
	} as unknown as AdminManifest;

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** The plugin answers each draft with a new title, once the test lets it. */
	function stubPlugin() {
		const requests: Array<{ draft: Record<string, unknown> }> = [];
		let answer!: () => void;
		const answered = new Promise<void>((resolve) => (answer = resolve));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
					draft: Record<string, unknown>;
				};
				requests.push(body);
				await answered;
				const { draft } = body;
				return Response.json({
					data: {
						patch: {
							type: "editor-draft-patch",
							operations: [{ op: "set", field: "title", value: "Suggested title" }],
						},
						editorInvocation: {
							entryId: draft.entryId,
							locale: draft.locale,
							baseRevision: draft.baseRevision,
							generation: draft.generation,
							invocationId: draft.invocationId,
							fieldDefinitions: [
								{
									slug: "title",
									label: "Title",
									type: "string",
									required: false,
									translatable: false,
								},
							],
						},
					},
				});
			}),
		);
		return { requests, answer };
	}

	it("sends the room's values and latest save, and applies a patch after edits to other fields", async () => {
		const fake = createRoom({ title: "My Post", summary: "Room summary", slug: "my-post" });
		const plugin = stubPlugin();
		const screen = await render(
			<ContentEditor {...editorProps(fake.room, { manifest: MANIFEST })} />,
			{
				wrapper: Toasty,
			},
		);
		unmounts.push(() => screen.unmount());

		await screen.getByRole("button", { name: "Suggest a title" }).click();
		await vi.waitFor(() => expect(plugin.requests).toHaveLength(1));
		expect(plugin.requests[0]!.draft).toMatchObject({
			baseRevision: "rev-1",
			fields: { title: "My Post", summary: "Room summary" },
		});
		// Room saves change `_rev` every few seconds, and someone else edits a field the patch leaves.
		fake.setSaveState({ ...SAVED, rev: "rev-2" });
		fake.remote({ summary: "Edited elsewhere" });
		plugin.answer();

		const review = screen.getByRole("dialog", { name: "Review proposed changes" });
		await expect.element(review).toBeVisible();
		await review.getByRole("button", { name: "Apply changes" }).click();
		expect(fake.applyPatch).toHaveBeenCalledExactlyOnceWith({ title: "Suggested title" });
		expect(fake.set).not.toHaveBeenCalled();
	});

	it("refuses a patch to a field someone edited after the capture", async () => {
		const fake = createRoom({ title: "My Post", summary: "Room summary", slug: "my-post" });
		const plugin = stubPlugin();
		const screen = await render(
			<ContentEditor {...editorProps(fake.room, { manifest: MANIFEST })} />,
			{
				wrapper: Toasty,
			},
		);
		unmounts.push(() => screen.unmount());

		await screen.getByRole("button", { name: "Suggest a title" }).click();
		await vi.waitFor(() => expect(plugin.requests).toHaveLength(1));
		fake.remote({ title: "Retitled elsewhere" });
		plugin.answer();

		await expect
			.element(
				screen.getByText(
					"The plugin result is stale because the editor changed while it was working.",
				),
			)
			.toBeVisible();
		expect(screen.getByRole("dialog", { name: "Review proposed changes" }).elements()).toHaveLength(
			0,
		);
		expect(fake.applyPatch).not.toHaveBeenCalled();
	});
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
