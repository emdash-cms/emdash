import { describe, expect, it } from "vitest";

import {
	diffRevisions,
	diffVersion,
	findRestoredSource,
	restoredSources,
	restoresNothing,
	makeSnippet,
} from "../../src/lib/revision-diff";
import type {
	BlockChange,
	BlockRow,
	ChangeItem,
	DiffFieldDescriptor,
	DiffOptions,
	FieldDiff,
	RevisionDiff,
	RevisionLike,
	TextDiff,
} from "../../src/lib/revision-diff";

let keyCounter = 0;
const freshKey = () => `k${++keyCounter}`;

type Span = { _type: "span"; _key: string; text: string; marks?: string[] };

function span(text: string, marks?: string[]): Span {
	return { _type: "span", _key: freshKey(), text, ...(marks ? { marks } : {}) };
}

function block(
	content: string | Span[],
	{ key = freshKey(), ...options }: { key?: string | null } & Record<string, unknown> = {},
) {
	return {
		_type: "block",
		...(key === null ? {} : { _key: key }),
		style: "normal",
		children: typeof content === "string" ? [span(content)] : content,
		...options,
	};
}

function image(ref: string, options: Record<string, unknown> = {}) {
	return {
		_type: "image",
		_key: freshKey(),
		asset: { _ref: ref, url: `/media/${ref}` },
		...options,
	};
}

function code(source: string, options: Record<string, unknown> = {}) {
	return { _type: "code", _key: freshKey(), code: source, ...options };
}

/** Copies blocks with new block, span and mark keys, as a keyless editing session saves them. */
function rekey<T>(value: T): T {
	if (Array.isArray(value)) return value.map(rekey) as T;
	if (typeof value !== "object" || value === null) return value;
	const copy: Record<string, unknown> = {};
	for (const [name, item] of Object.entries(value)) {
		copy[name] = name === "_key" ? freshKey() : rekey(item);
	}
	return copy as T;
}

function withoutKeys<T>(value: T): T {
	if (Array.isArray(value)) return value.map(withoutKeys) as T;
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([name]) => name !== "_key")
			.map(([name, item]) => [name, withoutKeys(item)]),
	) as T;
}

const BODY = { content: { kind: "portableText", label: "Content" } } satisfies Record<
	string,
	DiffFieldDescriptor
>;

function diffBody(before: unknown[], after: unknown[], options?: DiffOptions): RevisionDiff {
	return diffRevisions({ content: before }, { content: after }, BODY, options);
}

function field(diff: RevisionDiff, slug: string): FieldDiff {
	const found = diff.fields.find((item) => item.slug === slug);
	if (!found) throw new Error(`No field ${slug}`);
	return found;
}

function rowsOf(diff: RevisionDiff, slug = "content"): readonly BlockRow[] {
	const found = field(diff, slug);
	if (found.type !== "portableText") throw new Error(`${slug} is not a Portable Text field`);
	return found.rows;
}

function statuses(diff: RevisionDiff): string[] {
	return rowsOf(diff).map((row) => row.status);
}

function changeOf(row: BlockRow | undefined): BlockChange {
	if (row?.status !== "changed") throw new Error(`Expected a changed row, got ${row?.status}`);
	return row.change;
}

function textChangeOf(row: BlockRow | undefined): TextDiff {
	const change = changeOf(row);
	if (change.kind !== "text") throw new Error(`Expected a text change, got ${change.kind}`);
	return change.text;
}

function textOf(diff: RevisionDiff, slug: string): TextDiff {
	const found = field(diff, slug);
	if (found.type !== "text") throw new Error(`${slug} is not a text field`);
	return found.text;
}

function oldText(text: TextDiff): string {
	return text.segments
		.filter((segment) => segment.change !== "added")
		.map((segment) => segment.text)
		.join("");
}

function newText(text: TextDiff): string {
	return text.segments
		.filter((segment) => segment.change !== "removed")
		.map((segment) => segment.text)
		.join("");
}

/** The diff as `same [-removed-]{+added+}` text. */
function marked(text: TextDiff): string {
	return text.segments
		.map((segment) =>
			segment.change === "added"
				? `{+${segment.text}+}`
				: segment.change === "removed"
					? `[-${segment.text}-]`
					: segment.text,
		)
		.join("")
		.replaceAll("-][-", "")
		.replaceAll("+}{+", "");
}

function textsOf(text: TextDiff, change: "added" | "removed"): string[] {
	return text.segments
		.filter((segment) => segment.change === change)
		.map((segment) => segment.text);
}

function blockItems(diff: RevisionDiff) {
	return diff.changes.filter(
		(item): item is Extract<ChangeItem, { kind: "block" }> => item.kind === "block",
	);
}

function kinds(diff: RevisionDiff): string[] {
	return diff.changes.map((item) => item.kind);
}

const STORY = [
	"Plans that live in spreadsheets drift away from what gets published.",
	"Most teams plan posts in a spreadsheet and publish them somewhere else.",
	"The calendar shows every scheduled post on the day it goes live.",
	"Drag a post to another day to move its publish date.",
];

describe("revision diff: text", () => {
	it("marks a one-word replacement as one removed and added pair", () => {
		const key = freshKey();
		const diff = diffBody(
			[block("The quick brown fox jumps", { key })],
			[block("The quick red fox jumps", { key })],
		);
		const text = textChangeOf(rowsOf(diff)[0]);
		const removed = text.segments.filter((segment) => segment.change === "removed");
		const added = text.segments.filter((segment) => segment.change === "added");

		expect(removed.map((segment) => segment.text)).toEqual(["brown"]);
		expect(added.map((segment) => segment.text)).toEqual(["red"]);
		expect(removed[0]?.hunk).not.toBeNull();
		expect(removed[0]?.hunk).toBe(added[0]?.hunk);
		expect(oldText(text)).toBe("The quick brown fox jumps");
		expect(newText(text)).toBe("The quick red fox jumps");
	});

	it("marks appended text as a single addition", () => {
		const key = freshKey();
		const diff = diffBody(
			[block("Within a week", { key })],
			[block("Within a week, and nobody notices", { key })],
		);
		const text = textChangeOf(rowsOf(diff)[0]);

		expect(text.segments.filter((segment) => segment.change !== "same")).toMatchObject([
			{ change: "added", text: ", and nobody notices" },
		]);
	});

	it("folds a short unchanged word between two edits into one replacement", () => {
		const key = freshKey();
		const diff = diffBody(
			[block("Cats and dogs stay home", { key })],
			[block("Birds and fish stay home", { key })],
		);
		const text = textChangeOf(rowsOf(diff)[0]);

		expect(marked(text)).toBe("[-Cats and dogs-]{+Birds and fish+} stay home");
		expect(new Set(text.segments.map((segment) => segment.hunk)).size).toBe(2);
	});

	it("keeps exactly the spaces the new text has", () => {
		const key = freshKey();
		const deletion = textChangeOf(
			rowsOf(diffBody([block("the big dog", { key })], [block("the dog", { key })]))[0],
		);
		expect(marked(deletion)).toBe("the [-big -]dog");
		expect(newText(deletion)).toBe("the dog");

		const replacement = textChangeOf(
			rowsOf(diffBody([block("alpha beta", { key })], [block("alpha  gamma", { key })]))[0],
		);
		expect(oldText(replacement)).toBe("alpha beta");
		expect(newText(replacement)).toBe("alpha  gamma");
		const hunks = new Map<number, { removed: string; added: string }>();
		for (const segment of replacement.segments) {
			if (segment.hunk === null) continue;
			const entry = hunks.get(segment.hunk) ?? { removed: "", added: "" };
			if (segment.change === "removed") entry.removed += segment.text;
			if (segment.change === "added") entry.added += segment.text;
			hunks.set(segment.hunk, entry);
		}
		for (const { removed, added } of hunks.values()) {
			if (!removed || !added) continue;
			expect(/^\s/u.test(removed) && /^\s/u.test(added)).toBe(false);
			expect(/\s$/u.test(removed) && /\s$/u.test(added)).toBe(false);
		}
	});

	it("keeps bold and links on unchanged, removed and added text", () => {
		const key = freshKey();
		const link = { _type: "link", _key: "docs-link", href: "/docs" };
		const diff = diffBody(
			[
				block(
					[
						span("Read the "),
						span("docs", ["docs-link"]),
						span(" for "),
						span("details", ["strong"]),
					],
					{ key, markDefs: [link] },
				),
				block([span("big plan", ["strong"])]),
			],
			[
				block([span("Read the guide for "), span("details", ["strong"])], { key }),
				block([span("big new plan", ["strong"])]),
			],
		);
		const [first, second] = rowsOf(diff);
		const text = textChangeOf(first);

		expect(text.segments.find((segment) => segment.change === "removed")).toMatchObject({
			text: "docs",
			marks: { decorators: [], annotations: [{ _type: "link", href: "/docs" }] },
		});
		expect(text.segments.find((segment) => segment.text === "details")).toMatchObject({
			change: "same",
			marks: { decorators: ["strong"] },
			formatChanged: false,
		});
		expect(
			textChangeOf(second).segments.find((segment) => segment.change === "added"),
		).toMatchObject({
			text: "new ",
			marks: { decorators: ["strong"] },
		});
	});

	it("reports a formatting-only change as restyled", () => {
		const key = freshKey();
		const diff = diffBody(
			[block("Hello world", { key })],
			[block([span("Hello "), span("world", ["strong"])], { key })],
		);
		const text = textChangeOf(rowsOf(diff)[0]);

		expect(text.textChanged).toBe(false);
		expect(text.segments).toMatchObject([
			{ text: "Hello ", change: "same", formatChanged: false },
			{ text: "world", change: "same", formatChanged: true, marks: { decorators: ["strong"] } },
		]);
		expect(blockItems(diff)).toMatchObject([
			{ action: "restyled", snippet: { text: "Hello world", truncated: false } },
		]);
	});

	it("diffs Japanese by word, without spaces", () => {
		const key = freshKey();
		const diff = diffBody(
			[block("私はカレンダーで投稿を計画します。", { key })],
			[block("私はカレンダーで記事を計画します。", { key })],
			{ locale: "ja" },
		);
		const text = textChangeOf(rowsOf(diff)[0]);

		expect(textsOf(text, "removed").join("")).toBe("投稿");
		expect(textsOf(text, "added").join("")).toBe("記事");
		expect(textsOf(text, "removed").join("")).not.toContain("カレンダー");
		expect(oldText(text)).toBe("私はカレンダーで投稿を計画します。");
		expect(newText(text)).toBe("私はカレンダーで記事を計画します。");
	});

	it("diffs Arabic by word", () => {
		const key = freshKey();
		const diff = diffBody(
			[block("تخطط معظم الفرق للمنشورات في جدول بيانات", { key })],
			[block("تخطط معظم الفرق للمقالات في جدول بيانات", { key })],
			{ locale: "ar" },
		);
		const text = textChangeOf(rowsOf(diff)[0]);

		expect(textsOf(text, "removed")).toEqual(["للمنشورات"]);
		expect(textsOf(text, "added")).toEqual(["للمقالات"]);
		expect(makeSnippet("تخطط معظم الفرق لنشر المقالات، ثم تنشرها في مكان آخر", "ar")).toEqual({
			text: "تخطط معظم الفرق لنشر المقالات",
			truncated: true,
		});
	});

	it("falls back to marking a large rewritten block as a whole", () => {
		const key = freshKey();
		const limits = { maxTokenCellsPerText: 50 };
		const rewritten = diffBody(
			[block("one two three four five six seven eight nine ten", { key })],
			[block("alpha beta gamma delta epsilon zeta eta theta iota kappa", { key })],
			{ limits },
		);
		const whole = textChangeOf(rowsOf(rewritten)[0]);

		expect(whole.mode).toBe("whole");
		expect(whole.textChanged).toBe(true);
		expect(whole.segments.every((segment) => segment.change === "same")).toBe(true);
		expect(newText(whole)).toBe("alpha beta gamma delta epsilon zeta eta theta iota kappa");
		expect(blockItems(rewritten)).toMatchObject([{ action: "edited" }]);

		const words = Array.from({ length: 400 }, (_, index) => `word${index}`);
		const edited = words.with(200, "changed");
		const inline = textChangeOf(
			rowsOf(
				diffBody([block(words.join(" "), { key })], [block(edited.join(" "), { key })], { limits }),
			)[0],
		);
		expect(inline.mode).toBe("inline");
		expect(textsOf(inline, "removed")).toEqual(["word200"]);
		expect(textsOf(inline, "added")).toEqual(["changed"]);
	});

	it("diffs plain string fields word by word and url fields as whole values", () => {
		const fields = {
			title: { kind: "string", label: "Title" },
			website: { kind: "url", label: "Website" },
		} satisfies Record<string, DiffFieldDescriptor>;
		const diff = diffRevisions(
			{ title: "Plan your week", website: "https://example.com/a" },
			{ title: "Plan your month", website: "https://example.com/b" },
			fields,
		);

		expect(marked(textOf(diff, "title"))).toBe("Plan your [-week-]{+month+}");
		expect(marked(textOf(diff, "website"))).toBe(
			"[-https://example.com/a-]{+https://example.com/b+}",
		);
	});
});

describe("revision diff: blocks", () => {
	it("places a removed block before the block added after the same anchor", () => {
		const [a, b] = [block("Anchor before"), block("Anchor after")];
		const diff = diffBody([a, code("let removed = true;"), b], [a, block("Added between"), b]);

		expect(statuses(diff)).toEqual(["unchanged", "removed", "added", "unchanged"]);
		expect(statuses(diffBody([block("Removed first"), a, b], [a, b]))).toEqual([
			"removed",
			"unchanged",
			"unchanged",
		]);
	});

	it("with stable keys, reads a paragraph deleted and rewritten in place as removed and added", () => {
		const [a, b] = [block(STORY[0] ?? ""), block(STORY[3] ?? "")];
		const diff = diffBody(
			[a, block("Old words that were deleted entirely"), b],
			[a, block("Something unrelated typed instead"), b],
		);

		expect(statuses(diff)).toEqual(["unchanged", "removed", "added", "unchanged"]);
		expect(blockItems(diff)).toMatchObject([
			{ action: "removed", snippet: { text: "Old words that were deleted" } },
			{ action: "added", snippet: { text: "Something unrelated typed instead" } },
		]);

		const keyless = diffBody(
			[a, block("Old words that were deleted entirely", { key: null }), b],
			[a, block("Something unrelated typed instead"), b],
		);
		expect(statuses(keyless)).toEqual(["unchanged", "changed", "unchanged"]);
	});

	it("with stable keys, pairs a new-key block that lightly edits the removed one", () => {
		const [a, b] = [block(STORY[0] ?? ""), block(STORY[3] ?? "")];
		const diff = diffBody(
			[a, block("The calendar shows every scheduled post on the day it goes live."), b],
			[a, block("The calendar shows each scheduled post on the day it goes live."), b],
		);

		expect(statuses(diff)).toEqual(["unchanged", "changed", "unchanged"]);
		expect(blockItems(diff)).toMatchObject([{ action: "edited" }]);
	});

	it("when every key changed, still reads a heavily rewritten paragraph as edited", () => {
		const before = [
			block(STORY[0] ?? ""),
			block("Old words that were deleted entirely"),
			block(STORY[3] ?? ""),
		];
		const after = rekey(before);
		after[1] = block("Something unrelated typed instead");
		const diff = diffBody(before, after);

		expect(statuses(diff)).toEqual(["unchanged", "changed", "unchanged"]);
		expect(blockItems(diff)).toMatchObject([{ action: "edited" }]);
	});

	it("counts every row, removed ones included, in target ids", () => {
		const [a, b] = [block("First block"), block("Last block")];
		const diff = diffBody([a, code("gone();"), b], [a, block("Inserted text"), b]);
		const rows = rowsOf(diff);

		expect(rows.map((row) => row.targetId)).toEqual([
			"b-content-0",
			"b-content-1",
			"b-content-2",
			"b-content-3",
		]);
		expect(field(diff, "content").targetId).toBe("f-content");
		expect(diff.changes.map((item) => ("target" in item ? item.target : null))).toEqual([
			"b-content-1",
			"b-content-2",
		]);
	});

	it("tells caption, alt text and asset changes apart and ignores image metadata", () => {
		const key = freshKey();
		const base = { _key: key, alt: "A calendar", caption: "The week view" };
		const before = [{ ...image("media-1"), ...base, width: 800, height: 600 }];
		const caption = diffBody(before, [{ ...image("media-1"), ...base, caption: "The month view" }]);
		const captionChange = changeOf(rowsOf(caption)[0]);

		expect(captionChange).toMatchObject({
			kind: "image",
			captionChanged: true,
			assetChanged: false,
		});
		if (captionChange.kind !== "image") throw new Error("Expected an image change");
		expect(marked(captionChange.caption)).toBe("The [-week-]{+month+} view");
		expect(caption.changes).toMatchObject([{ kind: "image", action: "captionEdited" }]);

		const replaced = diffBody(before, [{ ...image("media-2"), ...base }]);
		expect(replaced.changes).toMatchObject([{ kind: "image", action: "replaced" }]);

		const alt = diffBody(before, [{ ...image("media-1"), ...base, alt: "A month calendar" }]);
		expect(alt.changes).toMatchObject([{ kind: "image", action: "altEdited" }]);

		const both = diffBody(before, [
			{ ...image("media-1"), ...base, alt: "A month calendar", caption: "The month view" },
		]);
		expect(both.changes).toMatchObject([{ kind: "image", action: "changed" }]);

		const metadata = diffBody(before, [
			{ ...image("media-1"), ...base, width: 1600, height: 1200, blurhash: "LEHV6nWB2y" },
		]);
		expect(statuses(metadata)).toEqual(["unchanged"]);
		expect(kinds(metadata)).toEqual(["noChanges"]);
	});

	it("reports a heading level change as restyled", () => {
		const key = freshKey();
		const diff = diffBody(
			[block("Plans", { key, style: "h3" })],
			[block("Plans", { key, style: "h2" })],
		);

		expect(changeOf(rowsOf(diff)[0])).toMatchObject({ kind: "text", styleChanged: true });
		expect(blockItems(diff)).toMatchObject([
			{ action: "restyled", noun: "heading", snippet: { text: "Plans" } },
		]);
	});

	it("reports list changes as restyled and ignores the list id the editor adds", () => {
		const key = freshKey();
		const bullet = block("First step", { key, listItem: "bullet", level: 1 });
		const numbered = block("First step", { key, listItem: "number", level: 1 });
		expect(blockItems(diffBody([bullet], [numbered]))).toMatchObject([
			{ action: "restyled", noun: "listItem" },
		]);
		expect(blockItems(diffBody([bullet], [{ ...bullet, level: 2 }]))).toMatchObject([
			{ action: "restyled" },
		]);

		const legacy = [block("Step one", { key: null, listItem: "number" })];
		const saved = [
			block("Step one", { listItem: "number", level: 1, listId: "legacy:abc", listStart: 1 }),
		];
		expect(kinds(diffBody(legacy, saved))).toEqual(["noChanges"]);
	});

	it("diffs code inline and notices a language change", () => {
		const key = freshKey();
		const edited = diffBody(
			[code("const total = 1;", { _key: key, language: "js" })],
			[code("const total = 2;", { _key: key, language: "js" })],
		);
		const change = changeOf(rowsOf(edited)[0]);
		if (change.kind !== "code") throw new Error("Expected a code change");

		expect(marked(change.code)).toBe("const total = [-1-]{+2+};");
		expect(blockItems(edited)).toMatchObject([{ action: "edited", noun: "code", snippet: null }]);

		const language = changeOf(
			rowsOf(
				diffBody(
					[code("print(1)", { _key: key, language: "js" })],
					[code("print(1)", { _key: key, language: "python" })],
				),
			)[0],
		);
		expect(language).toMatchObject({ kind: "code", code: { textChanged: false } });

		const accent = changeOf(
			rowsOf(
				diffBody(
					[code('const name = "cafe";', { _key: key })],
					[code('const name = "cafe\u0301";', { _key: key })],
				),
			)[0],
		);
		if (accent.kind !== "code") throw new Error("Expected a code change");
		expect(marked(accent.code)).toBe('const name = "[-cafe-]{+cafe\u0301+}";');
	});

	it("treats custom blocks, tables and galleries as opaque", () => {
		const key = freshKey();
		const youtube = diffBody(
			[{ _type: "youtube", _key: key, id: "abc" }],
			[{ _type: "youtube", _key: key, id: "xyz" }],
		);
		expect(changeOf(rowsOf(youtube)[0])).toEqual({ kind: "opaque" });
		expect(blockItems(youtube)).toMatchObject([
			{ action: "edited", noun: "custom", snippet: null },
		]);

		const table = (cell: string) => ({
			_type: "table",
			_key: key,
			rows: [
				{
					_type: "tableRow",
					_key: freshKey(),
					cells: [{ _type: "tableCell", _key: freshKey(), content: [span(cell)] }],
				},
			],
		});
		expect(blockItems(diffBody([table("Monday")], [table("Tuesday")]))).toMatchObject([
			{ action: "edited", noun: "table" },
		]);
		expect(kinds(diffBody([table("Monday")], [rekey(table("Monday"))]))).toEqual(["noChanges"]);

		const gallery = {
			_type: "gallery",
			_key: key,
			images: [image("media-1"), image("media-2")],
		};
		expect(kinds(diffBody([gallery], [rekey(gallery)]))).toEqual(["noChanges"]);
	});

	it("pairs seeded blocks without keys with the keyed blocks of the first save", () => {
		const seeded = [
			block("Plans", { key: null, style: "h2" }),
			...STORY.map((text) => block(text, { key: null })),
		];
		const saved = [
			block("Plans", { style: "h2" }),
			block("Plans that live in spreadsheets drift away from what you publish."),
			block(STORY[1] ?? ""),
			block(STORY[2] ?? ""),
			block(STORY[3] ?? ""),
		];
		const diff = diffBody(seeded, saved);

		expect(statuses(diff)).toEqual(["unchanged", "changed", "unchanged", "unchanged", "unchanged"]);
		expect(marked(textChangeOf(rowsOf(diff)[1]))).toBe(
			"Plans that live in spreadsheets drift away from what [-gets published-]{+you publish+}.",
		);
	});

	it("separates an edit, an insertion and a removal in a keyless first save", () => {
		const seeded = [
			block("Plans", { key: null, style: "h2" }),
			...STORY.map((text) => block(text, { key: null })),
		];
		const saved = [
			block("Plans", { style: "h2" }),
			block("Plans that live in spreadsheets drift away from what you publish."),
			block("A new paragraph about weekly reviews."),
			block(STORY[1] ?? ""),
			block(STORY[3] ?? ""),
		];

		expect(statuses(diffBody(seeded, saved))).toEqual([
			"unchanged",
			"changed",
			"added",
			"unchanged",
			"removed",
			"unchanged",
		]);
	});

	it("finds the one edit when every key changed between saves", () => {
		const before = STORY.map((text) => block(text));
		const after = rekey(before);
		after[2] = block("The calendar shows each scheduled post on its publish day.");
		const diff = diffBody(before, after);

		expect(statuses(diff)).toEqual(["unchanged", "unchanged", "changed", "unchanged"]);
		expect(blockItems(diff)).toMatchObject([{ action: "edited", target: "b-content-2" }]);
	});

	it("doesn't pair blocks by keys numbered from the start on every save", () => {
		const numbered = (texts: string[]) =>
			texts.map((text, index) => block(text, { key: `k${index}` }));
		const [a = "", b = "", c = ""] = STORY;
		const diff = diffBody(
			numbered([a, b, c]),
			numbered(["A new opening paragraph for the post.", a, b, `${c} Today.`]),
		);

		expect(statuses(diff)).toEqual(["added", "unchanged", "unchanged", "changed"]);
		expect(marked(textChangeOf(rowsOf(diff)[3]))).toBe(`${c}{+ Today.+}`);
	});

	it("doesn't pair blocks by a key that occurs twice", () => {
		const first = block("The first paragraph stays the same.", { key: "dup" });
		const second = block("The second paragraph stays as well.", { key: "dup" });
		const diff = diffBody([first, second], [second, first]);

		expect(rowsOf(diff).every((row) => row.status === "unchanged")).toBe(true);
		expect(blockItems(diff)).toMatchObject([{ action: "moved" }]);
	});

	it("pairs keyless blocks between keyed ones", () => {
		const heading = block("Plans", { style: "h2" });
		const closing = block("That is the whole plan.");
		const diff = diffBody(
			[heading, block("Paragraph without a key, first draft.", { key: null }), closing],
			[
				heading,
				block("Paragraph without a key, second draft."),
				block("Brand new words here.", { key: null }),
				closing,
			],
		);

		expect(statuses(diff)).toEqual(["unchanged", "changed", "added", "unchanged"]);
	});

	it("shows a split paragraph as a trimmed first half and an added second half", () => {
		const key = freshKey();
		const diff = diffBody(
			[block("First sentence here. Second sentence follows.", { key })],
			[block("First sentence here.", { key }), block("Second sentence follows.")],
		);
		const rows = rowsOf(diff);

		expect(statuses(diff)).toEqual(["changed", "added"]);
		expect(marked(textChangeOf(rows[0]))).toBe("First sentence here.[- Second sentence follows.-]");
	});

	it("detects moved blocks, with or without keys", () => {
		const [a, b, c] = STORY.map((text) => block(text));
		if (!a || !b || !c) throw new Error("Missing blocks");

		const moved = diffBody([a, b, c], [b, c, a]);
		expect(rowsOf(moved).map((row) => row.status === "unchanged" && row.moved)).toEqual([
			false,
			false,
			true,
		]);
		expect(blockItems(moved)).toMatchObject([
			{ action: "moved", snippet: { text: "Plans that live in spreadsheets" } },
		]);

		const editedA = { ...a, children: [span(`${STORY[0]} Today.`)] };
		expect(blockItems(diffBody([a, b, c], [b, c, editedA]))).toMatchObject([{ action: "edited" }]);

		const keyless = [a, b, c].map(withoutKeys);
		const [ka, kb, kc] = keyless;
		expect(blockItems(diffBody(keyless, [kb, kc, ka]))).toMatchObject([{ action: "moved" }]);

		const empty = block("", { key: null });
		expect(kinds(diffBody([empty, kb, kc], [kb, kc, withoutKeys(empty)]))).toEqual(["noChanges"]);
	});

	it("lists no change for added or removed empty paragraphs", () => {
		const a = block(STORY[0] ?? "");
		expect(kinds(diffBody([a], [a, block("")]))).toEqual(["noChanges"]);
		expect(kinds(diffBody([a, block(" ")], [a]))).toEqual(["noChanges"]);
	});
});

describe("revision diff: fields", () => {
	const fields = {
		title: { kind: "string", label: "Title" },
		excerpt: { kind: "richText", label: "Excerpt" },
		featured: { kind: "boolean", label: "Featured post" },
		content: { kind: "portableText", label: "Content" },
	} satisfies Record<string, DiffFieldDescriptor>;

	it("reports no changes for identical data and for differences it ignores", () => {
		const content = [block("One paragraph", { listItem: "number", listId: "a" })];
		const data = { title: "Hello", excerpt: "", featured: false, content };
		expect(diffRevisions(data, data, fields).changes).toEqual([{ kind: "noChanges" }]);

		const ignored = diffRevisions(
			{ ...data, _referencesBaseline: { related: ["g1"] }, _wp: { id: 1 }, removed: "old" },
			{
				...data,
				content: [{ ...rekey(content[0]), listId: "b" }],
				_referencesBaseline: { related: ["g2"] },
				_wp: { id: 2 },
				removed: "new",
			},
			fields,
		);
		expect(ignored.changes).toEqual([{ kind: "noChanges" }]);
	});

	it("describes a first version without marking anything", () => {
		const data = { title: "Hello", content: [block("Hello world")] };
		const created = diffRevisions(null, data, fields);

		expect(created.hasPrevious).toBe(false);
		expect(created.changes).toEqual([{ kind: "created" }]);
		expect(diffRevisions(null, data, fields, { noPrevious: "earliest" }).changes).toEqual([
			{ kind: "earliest" },
		]);
		expect(created.fields.every((item) => item.status === "unchanged")).toBe(true);
		expect(textOf(created, "title").segments.map((segment) => segment.change)).toEqual(["same"]);
		expect(statuses(created)).toEqual(["unchanged"]);
	});

	it("compares the slug only when both versions record one", () => {
		expect(diffRevisions({ title: "A" }, { title: "A", _slug: "a" }, fields).slug).toBeNull();
		expect(kinds(diffRevisions({ title: "A" }, { title: "A", _slug: "a" }, fields))).toEqual([
			"noChanges",
		]);
		expect(kinds(diffRevisions({ _slug: "" }, { _slug: null }, fields))).toEqual(["noChanges"]);

		const renamed = diffRevisions(
			{ title: "A", _slug: "old" },
			{ title: "B", _slug: "new" },
			fields,
			{
				titleField: "title",
			},
		);
		expect(renamed.slug).toEqual({ status: "changed", before: "old", after: "new" });
		expect(renamed.changes.at(-1)).toEqual({ kind: "slug", after: "new" });
	});

	it("reads booleans stored as 0 and 1", () => {
		expect(diffRevisions({ featured: false }, { featured: true }, fields).changes).toMatchObject([
			{ kind: "toggle", on: true, field: { label: "Featured post" }, target: "f-featured" },
		]);
		expect(diffRevisions({ featured: 1 }, { featured: 0 }, fields).changes).toMatchObject([
			{ kind: "toggle", on: false },
		]);
		expect(kinds(diffRevisions({ featured: 1 }, { featured: true }, fields))).toEqual([
			"noChanges",
		]);
		expect(kinds(diffRevisions({}, { featured: false }, fields))).toEqual(["noChanges"]);
	});

	it("names a field without a label the way the editor does", () => {
		expect(
			diffRevisions({ subtitle: "Old" }, { subtitle: "New" }, { subtitle: { kind: "string" } })
				.changes,
		).toMatchObject([{ kind: "text", field: { label: "Subtitle" } }]);
	});

	it("lists changes in field order with the slug last", () => {
		const key = freshKey();
		const diff = diffRevisions(
			{
				title: "Hello",
				excerpt: "",
				featured: false,
				content: [block("Body", { key })],
				_slug: "a",
			},
			{
				title: "Hello there",
				excerpt: "Short summary",
				featured: true,
				content: [block("Body text", { key })],
				_slug: "b",
			},
			fields,
			{ titleField: "title" },
		);

		expect(diff.changes).toMatchObject([
			{ kind: "title", target: "f-title" },
			{ kind: "text", change: "added", field: { slug: "excerpt" } },
			{ kind: "toggle", on: true },
			{ kind: "block", action: "edited" },
			{ kind: "slug" },
		]);
		expect(
			diffRevisions({ excerpt: "Short summary" }, { excerpt: "" }, fields).changes,
		).toMatchObject([{ kind: "text", change: "removed" }]);
	});

	it("compares relation-bound references through staged references", () => {
		const related = {
			related: { kind: "reference", label: "Related", validation: { relation: "related-posts" } },
		} satisfies Record<string, DiffFieldDescriptor>;

		expect(
			diffRevisions(
				{ _references: { related: ["g1"] } },
				{ _references: { related: ["g2"] } },
				related,
			).changes,
		).toMatchObject([{ kind: "field", field: { slug: "related" } }]);
		expect(kinds(diffRevisions({ _references: { related: ["g1"] } }, {}, related))).toEqual([
			"noChanges",
		]);
		expect(
			kinds(
				diffRevisions(
					{},
					{ _references: { related: ["g1"] }, _referencesBaseline: { related: ["g1"] } },
					related,
				),
			),
		).toEqual(["noChanges"]);
	});

	it("compares other field kinds by value", () => {
		const valueFields = {
			category: { kind: "select", label: "Category" },
			tags: { kind: "multiSelect", label: "Tags" },
			rating: { kind: "number", label: "Rating" },
			publishOn: { kind: "datetime", label: "Publish on" },
			cover: { kind: "image", label: "Cover" },
			meta: { kind: "json", label: "Meta" },
			links: { kind: "repeater", label: "Links" },
		} satisfies Record<string, DiffFieldDescriptor>;
		const before = {
			category: "news",
			tags: ["a", "b"],
			rating: 4,
			publishOn: "2026-10-12T09:00:00.000Z",
			cover: { id: "media-1", alt: "Cover" },
			meta: { color: "red" },
			links: [{ _key: "l1", label: "Docs" }],
		};

		const same = diffRevisions(
			before,
			{
				...before,
				tags: ["b", "a"],
				rating: "4",
				publishOn: "2026-10-12T09:00:00Z",
				cover: { id: "media-1", alt: "Cover", width: 800, height: 600 },
				links: [{ _key: "l2", label: "Docs" }],
			},
			valueFields,
		);
		expect(kinds(same)).toEqual(["noChanges"]);

		const changed = diffRevisions(
			before,
			{
				category: "guides",
				tags: ["a"],
				rating: 5,
				publishOn: "2026-10-13T09:00:00.000Z",
				cover: { id: "media-2", alt: "Cover" },
				meta: { color: "blue" },
				links: [{ _key: "l1", label: "Guides" }],
			},
			valueFields,
		);
		expect(
			changed.changes.map((item) => (item.kind === "field" ? item.field.slug : item.kind)),
		).toEqual(["category", "tags", "rating", "publishOn", "cover", "meta", "links"]);
	});

	it("survives an invalid locale tag", () => {
		const key = freshKey();
		const before = [block("The quick brown fox", { key })];
		const after = [block("The quick red fox", { key })];
		const invalid = diffBody(before, after, { locale: "not a locale!!" });

		expect(marked(textChangeOf(rowsOf(invalid)[0]))).toBe("The quick [-brown-]{+red+} fox");
		expect(makeSnippet("Hello there", "not a locale!!")).toEqual({
			text: "Hello there",
			truncated: false,
		});
	});
});

describe("revision diff: restored versions", () => {
	const fields = {
		title: { kind: "string", label: "Title" },
		content: { kind: "portableText", label: "Content" },
	} satisfies Record<string, DiffFieldDescriptor>;
	const revision = (id: string, data: Record<string, unknown>): RevisionLike => ({ id, data });

	const a = revision("a", { title: "First", content: [block(STORY[0] ?? "")] });
	const b = revision("b", { title: "Second", content: [block(STORY[1] ?? "")] });

	it("finds the version a restore copied", () => {
		const c = revision("c", { ...a.data });
		expect(findRestoredSource(c, b, [a], fields)).toBe("a");

		const diff = diffVersion({
			revisions: [c, b, a],
			index: 0,
			total: 3,
			fields,
			titleField: "title",
		});
		expect(diff.changes).toMatchObject([
			{ kind: "restored", revisionId: "a" },
			{ kind: "title" },
			{ kind: "block", action: "edited" },
		]);
	});

	it("doesn't call a save without changes a restore", () => {
		const c = revision("c", { ...a.data });
		const d = revision("d", { ...c.data });
		expect(findRestoredSource(d, c, [b, a], fields)).toBeNull();
		expect(findRestoredSource(a, null, [], fields)).toBeNull();
	});

	it("names the original when a restore copies an earlier restore, ignoring regenerated keys", () => {
		const restoredCopy = revision("a2", { ...a.data });
		const c = revision("c", { title: "First", content: rekey(a.data.content) });
		expect(findRestoredSource(c, b, [restoredCopy, a], fields)).toBe("a");
	});

	it("treats a slug only one version records as a change when deciding whether a restore does anything", () => {
		const withSlug = { ...a.data, _slug: "first" };
		expect(restoresNothing(withSlug, { ...a.data }, fields)).toBe(false);
		expect(restoresNothing(withSlug, { ...withSlug }, fields)).toBe(true);
		expect(findRestoredSource(revision("c", withSlug), b, [a], fields)).toBe("a");
	});

	it("maps each restored copy in a list to the version it restored", () => {
		const restoredCopy = revision("a2", { ...a.data });
		const third = revision("c", { title: "Third", content: [block(STORY[2] ?? "")] });
		const again = revision("a3", { ...a.data });
		const sources = restoredSources([again, third, restoredCopy, b, a], fields);
		expect([...sources]).toEqual([
			["a3", "a"],
			["a2", "a"],
		]);
	});

	it("chooses created or earliest for the oldest loaded version", () => {
		expect(diffVersion({ revisions: [b, a], index: 1, total: 2, fields }).changes).toEqual([
			{ kind: "created" },
		]);
		expect(diffVersion({ revisions: [b, a], index: 1, total: 3, fields }).changes).toEqual([
			{ kind: "earliest" },
		]);
		const full = Array.from({ length: 50 }, (_, index) =>
			revision(`r${index}`, { title: `${index}` }),
		);
		expect(diffVersion({ revisions: full, index: 49, total: 50, fields }).changes).toEqual([
			{ kind: "earliest" },
		]);
		expect(diffVersion({ revisions: [b, a], index: 0, total: 2, fields }).hasPrevious).toBe(true);
	});
});

describe("revision diff: snippets", () => {
	it("trims snippets to a few words without doubled quotes or dangling punctuation", () => {
		expect(makeSnippet("Most teams plan posts in a spreadsheet and publish them.")).toEqual({
			text: "Most teams plan posts in",
			truncated: true,
		});
		expect(makeSnippet("“We stopped double-booking launch days in the first week.”")).toEqual({
			text: "We stopped double-booking launch",
			truncated: true,
		});
		expect(makeSnippet("Drag a post to another day, then let go.")).toEqual({
			text: "Drag a post to another",
			truncated: true,
		});
		expect(makeSnippet("“Short quote.”")).toEqual({ text: "Short quote.", truncated: false });
		expect(makeSnippet("私はカレンダーで投稿を計画します。毎週確認します。", "ja")).toEqual({
			text: "私はカレンダーで投稿を計画します",
			truncated: true,
		});
		expect(makeSnippet("Pneumonoultramicroscopicsilicovolcanoconiosisandmore is long")).toEqual({
			text: "Pneumonoultramicroscopicsilicovolcanoconiosisandmore",
			truncated: true,
		});
		expect(makeSnippet("  \n ")).toBeNull();
	});

	it("counts the words of a link like any spaced text", () => {
		expect(makeSnippet("https://example.com/plans/calendar")).toEqual({
			text: "https://example.com/plans/calendar",
			truncated: false,
		});
		expect(makeSnippet("https://example.com/plans is where we keep the calendar.")).toEqual({
			text: "https://example.com/plans is",
			truncated: true,
		});
	});
});

describe("revision diff: bounded work", () => {
	const paragraph = (index: number) =>
		`Paragraph ${index} explains one part of planning posts with a shared calendar and a few more words.`;

	it("finds a few edits in a long post", () => {
		const before = Array.from({ length: 300 }, (_, index) => block(paragraph(index)));
		const after = rekey(before);
		after[10] = block(paragraph(10).replace("shared", "team"));
		after.splice(150, 1);
		after.splice(200, 0, block("An inserted paragraph about reviews."));

		const diff = diffBody(before, after);

		expect(blockItems(diff).map((item) => item.action)).toEqual(["edited", "removed", "added"]);
	});

	it("keeps far-apart edits in a long paragraph inline", () => {
		const key = freshKey();
		const words = Array.from({ length: 300 }, (_, index) => `word${index}`);
		const before = [block(words.join(" "), { key })];
		const after = [block(words.with(10, "alpha").with(290, "omega").join(" "), { key })];

		const text = textChangeOf(rowsOf(diffBody(before, after))[0]);
		expect(text.mode).toBe("inline");
		expect(textsOf(text, "removed")).toEqual(["word10", "word290"]);
		expect(textsOf(text, "added")).toEqual(["alpha", "omega"]);
		const hunks = text.segments.map((segment) => segment.hunk).filter((hunk) => hunk !== null);
		expect(new Set(hunks).size).toBe(2);
	});

	it("marks the remaining blocks as a whole once the total budget is spent", () => {
		const keys = [freshKey(), freshKey()];
		const budget = diffBody(
			[block("one two three", { key: keys[0] }), block("four five six", { key: keys[1] })],
			[block("seven eight nine", { key: keys[0] }), block("ten eleven twelve", { key: keys[1] })],
			{ limits: { maxTokenCellsTotal: 30 } },
		);
		expect(
			rowsOf(budget).map((row) =>
				row.status === "changed" && row.change.kind === "text" ? row.change.text.mode : null,
			),
		).toEqual(["inline", "whole"]);
	});

	it("reads a long run of edited paragraphs as edits", () => {
		const texts = Array.from(
			{ length: 60 },
			(_, index) => `Section ${index} covers week ${index}.`,
		);
		const diff = diffBody(
			texts.map((text) => block(text, { key: null })),
			texts.map((text) => block(`${text} Updated.`)),
		);

		expect(statuses(diff)).toEqual(texts.map(() => "changed"));
	});

	it("still pairs equal blocks in order when a gap is too large to compare every pair", () => {
		const [a, b] = [STORY[1] ?? "", STORY[2] ?? ""];
		const diff = diffBody(
			[
				block("Old opening line here", { key: null }),
				block(a),
				block(b),
				block("Old closing line"),
			],
			[block("New opening line here"), block(a), block(b), block("New closing line")],
			{ limits: { maxBlockLcsCells: 1, maxSimilarityCells: 1 } },
		);

		expect(statuses(diff)).toEqual(["changed", "unchanged", "unchanged", "changed"]);
	});
});
