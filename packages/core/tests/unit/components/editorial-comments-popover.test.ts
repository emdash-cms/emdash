// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	mountEditorialComments,
	type CommentsPopoverHandle,
	type CommentsPopoverOptions,
	type CommentsThreadView,
} from "../../../src/components/EditorialCommentsPopover.js";
import { EDITORIAL_TOOLBAR_LABELS, GERMAN_TOOLBAR_LABELS } from "../../utils/toolbar-labels.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const LABELS = { ...GERMAN_TOOLBAR_LABELS, ...EDITORIAL_TOOLBAR_LABELS };
const THREADS_URL = "/_emdash/api/content/posts/post-1/threads";

function thread(
	id: string,
	overrides: Partial<CommentsThreadView> = {},
	body = "Check this",
): CommentsThreadView {
	return {
		id,
		anchor: { type: "field", field: "title" },
		status: "open",
		comments: [
			{
				id: `${id}-c1`,
				author: { id: "user-1", name: "Grace" },
				body,
				createdAt: "2026-11-01T10:00:00.000Z",
				deletedAt: null,
			},
		],
		mentions: [],
		can: { resolve: true },
		...overrides,
	};
}

let handle: CommentsPopoverHandle;
let anchor: HTMLButtonElement;

function dialog(): HTMLElement {
	const element = document.querySelector<HTMLElement>('[role="dialog"]');
	if (!element) throw new Error("No comment dialog");
	return element;
}

function button(name: string, within: ParentNode = dialog()): HTMLButtonElement {
	const found = [...within.querySelectorAll("button")].find(
		(candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
	);
	if (!found) throw new Error(`No button named "${name}"`);
	return found;
}

async function type(textarea: HTMLTextAreaElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
		setter.call(textarea, value);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function open(overrides: Partial<CommentsPopoverOptions> = {}) {
	const options: CommentsPopoverOptions = {
		anchor,
		title: "Comments on Title",
		field: "title",
		threads: [],
		loadFailed: false,
		labels: LABELS,
		threadsUrl: THREADS_URL,
		adminUrl: "/_emdash/admin/content/posts/post-1",
		adminTarget: "emdash-admin-posts/post-1",
		request: vi.fn(),
		onThreadChange: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
	await act(async () => handle.open(options));
	// FloatingFocusManager moves focus to the dialog on a later tick.
	await vi.waitFor(() => expect(document.activeElement).toBe(dialog()));
	return options;
}

beforeEach(() => {
	actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
	anchor = document.createElement("button");
	anchor.textContent = "1";
	document.body.append(anchor);
	handle = mountEditorialComments();
});

afterEach(async () => {
	await act(async () => handle.close());
	document.body.innerHTML = "";
	delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
	vi.restoreAllMocks();
});

describe("editorial comments popover", () => {
	it("shows comment bodies as text, with mention tokens as the mentioned users' names", async () => {
		await open({
			threads: [
				thread(
					"t-1",
					{ mentions: [{ id: "user-2", name: "Ada <b>Lovelace</b>" }] },
					'<img src=x onerror="alert(1)"> ask <@user-2> or <@gone>',
				),
			],
		});

		const text = dialog().querySelector(".emdash-comments-text")!;
		expect(text.querySelector("img, b")).toBeNull();
		expect(text.textContent).toBe(
			'<img src=x onerror="alert(1)"> ask @Ada <b>Lovelace</b> or @Unknown user',
		);
		expect(
			Array.from(
				text.querySelectorAll(".emdash-comments-mention"),
				(mention) => mention.textContent,
			),
		).toEqual(["@Ada <b>Lovelace</b>", "@Unknown user"]);
	});

	it("offers Resolve only on threads the user may resolve, and links each thread to the admin", async () => {
		await open({ threads: [thread("t-mine"), thread("t-theirs", { can: { resolve: false } })] });

		const threads = [...dialog().querySelectorAll(".emdash-comments-thread")];
		expect(
			threads.map((item) =>
				Array.from(item.querySelectorAll("button"), (control) => control.textContent),
			),
		).toEqual([["Reply", "Resolve"], ["Reply"]]);
		expect(threads.map((item) => item.querySelector("a")!.getAttribute("href"))).toEqual([
			"/_emdash/admin/content/posts/post-1?thread=t-mine",
			"/_emdash/admin/content/posts/post-1?thread=t-theirs",
		]);
	});

	it("posts a reply, shows it and keeps focus in that thread's reply box", async () => {
		const replied = thread("t-1");
		replied.comments.push({ ...replied.comments[0]!, id: "t-1-c2", body: "Fixed" });
		const options = await open({
			threads: [thread("t-1")],
			request: vi.fn(async () => replied),
		});

		const reply = dialog().querySelector<HTMLTextAreaElement>(".emdash-comments-thread textarea")!;
		await type(reply, "Fixed");
		await act(async () => button("Reply").click());

		expect(options.request).toHaveBeenCalledWith(`${THREADS_URL}/t-1/comments`, "POST", {
			body: "Fixed",
		});
		expect(options.onThreadChange).toHaveBeenCalledWith(replied);
		expect(
			Array.from(dialog().querySelectorAll(".emdash-comments-text"), (text) => text.textContent),
		).toEqual(["Check this", "Fixed"]);
		expect(document.activeElement).toBe(dialog().querySelector(".emdash-comments-thread textarea"));
	});

	it("removes a resolved thread and moves focus to the dialog", async () => {
		const options = await open({
			threads: [thread("t-1")],
			request: vi.fn(async () => thread("t-1", { status: "resolved" })),
		});

		await act(async () => button("Resolve").click());

		expect(options.request).toHaveBeenCalledWith(`${THREADS_URL}/t-1`, "PATCH", {
			status: "resolved",
		});
		expect(dialog().textContent).toContain("No open comments");
		expect(document.activeElement).toBe(dialog());
	});

	it("starts a field thread, or an entry thread without a field", async () => {
		for (const field of ["seo", null]) {
			const created = thread("t-new", {
				anchor: field ? { type: "field", field } : { type: "entry" },
			});
			const options = await open({ field, request: vi.fn(async () => created) });

			const textarea = dialog().querySelector<HTMLTextAreaElement>(
				".emdash-comments-body > form textarea",
			)!;
			await type(textarea, "Needs work");
			await act(async () => button("Comment").click());

			expect(options.request).toHaveBeenCalledWith(THREADS_URL, "POST", {
				anchor: field ? { type: "field", field } : { type: "entry" },
				body: "Needs work",
			});
			expect(dialog().querySelectorAll(".emdash-comments-thread")).toHaveLength(1);
			expect(document.activeElement).toBe(
				dialog().querySelector(".emdash-comments-body > form textarea"),
			);
		}
	});

	it("keeps the text and says so when a comment can't be saved", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		await open({ request: vi.fn(async () => Promise.reject(new Error("500"))) });

		const textarea = dialog().querySelector<HTMLTextAreaElement>("textarea")!;
		await type(textarea, "Needs work");
		await act(async () => button("Comment").click());

		expect(textarea.value).toBe("Needs work");
		expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("Couldn't save. Try again.");
	});

	it("focuses the dialog when it opens, and returns focus to the badge on Escape", async () => {
		const options = await open({ threads: [thread("t-1")] });
		await vi.waitFor(() => expect(document.activeElement).toBe(dialog()));
		expect(dialog().getAttribute("aria-labelledby")).toBe(dialog().querySelector("h2")!.id);

		await act(async () => {
			dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(options.onClose).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(anchor);
	});

	it("says the comments couldn't load instead of listing none", async () => {
		await open({ loadFailed: true });
		expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("Couldn't load comments");
		expect(dialog().textContent).not.toContain("No open comments");
	});

	it("shows a comment saved after the comments couldn't load", async () => {
		const created = thread("t-new", {}, "Needs work");
		await open({ loadFailed: true, request: vi.fn(async () => created) });

		await type(dialog().querySelector<HTMLTextAreaElement>("textarea")!, "Needs work");
		await act(async () => button("Comment").click());

		expect(dialog().querySelectorAll(".emdash-comments-thread")).toHaveLength(1);
		expect(dialog().textContent).toContain("Needs work");
		expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("Couldn't load comments");
	});

	it("keeps unsent replies and comments when the popover closes and opens again", async () => {
		await open({ threads: [thread("t-1")] });
		await type(dialog().querySelector(".emdash-comments-thread textarea")!, "Half a reply");
		await type(dialog().querySelector(".emdash-comments-body > form textarea")!, "Half a thread");
		await act(async () => button("Close").click());

		await open({ threads: [thread("t-1")] });

		expect(
			dialog().querySelector<HTMLTextAreaElement>(".emdash-comments-thread textarea")!.value,
		).toBe("Half a reply");
		expect(
			dialog().querySelector<HTMLTextAreaElement>(".emdash-comments-body > form textarea")!.value,
		).toBe("Half a thread");
	});

	it("doesn't take edits while a reply is sending, and forgets the reply once it's sent", async () => {
		let finish!: (value: CommentsThreadView) => void;
		await open({
			threads: [thread("t-1")],
			request: vi.fn(() => new Promise<CommentsThreadView>((resolve) => (finish = resolve))),
		});
		const reply = dialog().querySelector<HTMLTextAreaElement>(".emdash-comments-thread textarea")!;
		await type(reply, "Fixed");
		await act(async () => button("Reply").click());

		expect(reply.readOnly).toBe(true);
		await act(async () => finish(thread("t-1")));
		expect(reply.readOnly).toBe(false);
		await act(async () => button("Close").click());
		await open({ threads: [thread("t-1")] });
		expect(
			dialog().querySelector<HTMLTextAreaElement>(".emdash-comments-thread textarea")!.value,
		).toBe("");
	});

	it("keeps a reply sending while the popover closes and opens again, and doesn't let it clear newer text", async () => {
		let finish!: (value: CommentsThreadView) => void;
		const request = vi.fn(() => new Promise<CommentsThreadView>((resolve) => (finish = resolve)));
		await open({ threads: [thread("t-1")], request });
		const replyBox = () =>
			dialog().querySelector<HTMLTextAreaElement>(".emdash-comments-thread textarea")!;
		await type(replyBox(), "Fixed");
		await act(async () => button("Reply").click());
		await act(async () => button("Close").click());

		await open({ threads: [thread("t-1")], request });
		expect(replyBox().value).toBe("Fixed");
		expect(replyBox().readOnly).toBe(true);
		await act(async () => button("Reply").click());
		expect(request).toHaveBeenCalledTimes(1);

		await act(async () => finish(thread("t-1")));
		expect(replyBox().value).toBe("");
		expect(replyBox().readOnly).toBe(false);
		await type(replyBox(), "One more thing");
		await act(async () => button("Close").click());

		await open({ threads: [thread("t-1")], request });
		expect(replyBox().value).toBe("One more thing");
	});

	it("sends a typed mention token as text, so it can't mention anyone", async () => {
		const options = await open({
			threads: [thread("t-1")],
			request: vi.fn(async () => thread("t-1")),
		});

		await type(dialog().querySelector(".emdash-comments-thread textarea")!, "use <@user-2> syntax");
		await act(async () => button("Reply").click());

		expect(options.request).toHaveBeenCalledWith(`${THREADS_URL}/t-1/comments`, "POST", {
			body: "use <\u200B@user-2> syntax",
		});
	});

	it("names users with a blank name as unnamed, in the author line and in mentions", async () => {
		const blank = thread("t-1", { mentions: [{ id: "user-2", name: "  " }] }, "ask <@user-2>");
		blank.comments[0]!.author = { id: "user-2", name: " " };
		await open({ threads: [blank] });

		expect(dialog().querySelector(".emdash-comments-author")!.textContent).toBe("Unnamed user");
		expect(dialog().querySelector(".emdash-comments-mention")!.textContent).toBe("@Unnamed user");
	});

	it("names the field of each thread in an entry's popover", async () => {
		await open({
			field: null,
			threads: [thread("t-1", { anchor: { type: "field", field: "theme_color" } })],
			fieldLabels: { theme_color: "Theme colour" },
		});

		expect(dialog().querySelector(".emdash-comments-quote")!.textContent).toBe("On Theme colour");
	});
});
