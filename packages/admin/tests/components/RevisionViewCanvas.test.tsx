import { Checkbox, Input, InputArea, Label, Select, Switch } from "@cloudflare/kumo";
import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import type { FieldDescriptor } from "../../src/components/ContentEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { RevisionViewCanvas } from "../../src/components/revisions/RevisionViewCanvas";
import type {
	BlockRow,
	DiffSegment,
	FieldDiff,
	MarkAnnotation,
	NormalizedBlock,
	RevisionDiff,
	SegmentMarks,
	TextBlock,
	TextDiff,
} from "../../src/lib/revision-diff/types.js";
import { render } from "../utils/render.js";

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

const PLAIN: SegmentMarks = { decorators: [], annotations: [] };

function segment(
	text: string,
	change: DiffSegment["change"] = "same",
	options: Partial<Omit<DiffSegment, "text" | "change">> = {},
): DiffSegment {
	return { text, change, marks: PLAIN, hunk: null, formatChanged: false, ...options };
}

function textDiff(segments: DiffSegment[], mode: TextDiff["mode"] = "inline"): TextDiff {
	return {
		mode,
		textChanged: segments.some((part) => part.change !== "same") || mode === "whole",
		marksChanged: segments.some((part) => part.formatChanged),
		segments,
	};
}

function textBlock(text: string, options: Partial<TextBlock> = {}): TextBlock {
	return {
		kind: "text",
		key: null,
		type: "block",
		raw: null,
		style: "normal",
		listItem: null,
		level: null,
		listStart: null,
		textAlign: null,
		runs: [{ text, marks: PLAIN }],
		text,
		...options,
	};
}

function unchangedRow(index: number, block: NormalizedBlock): BlockRow {
	return { status: "unchanged", targetId: `b-content-${index}`, block, moved: false, text: null };
}

function bodyField(rows: BlockRow[]): FieldDiff {
	const changed = rows.some((row) => row.status !== "unchanged");
	return {
		type: "portableText",
		slug: "content",
		label: "Content",
		kind: "portableText",
		status: changed ? "changed" : "unchanged",
		targetId: "f-content",
		rows,
	};
}

function stringField(slug: string, segments: DiffSegment[], kind = "string"): FieldDiff {
	const changed = segments.some((part) => part.change !== "same");
	return {
		type: "text",
		slug,
		label: slug,
		kind,
		status: changed ? "changed" : "unchanged",
		targetId: `f-${slug}`,
		text: textDiff(segments),
	};
}

function valueField(slug: string, kind: string, before: unknown, after: unknown): FieldDiff {
	return {
		type: "value",
		slug,
		label: slug,
		kind,
		status: before === after ? "unchanged" : "changed",
		targetId: `f-${slug}`,
		before,
		after,
	};
}

function revisionDiff(fields: FieldDiff[], hasPrevious = true): RevisionDiff {
	return { hasPrevious, fields, slug: null, changes: [] };
}

const FIELDS: Record<string, FieldDescriptor> = {
	title: { kind: "string", label: "Title", required: true },
	excerpt: { kind: "string", label: "Excerpt", required: false },
	notes: { kind: "richText", label: "Notes" },
	stage: {
		kind: "select",
		label: "Stage",
		options: [
			{ value: "draft", label: "Drafting" },
			{ value: "review", label: "In review" },
		],
	},
	featured: { kind: "boolean", label: "Featured post" },
	settings: { kind: "json", label: "Settings" },
	tags: {
		kind: "multiSelect",
		label: "Tags",
		options: [
			{ value: "news", label: "News" },
			{ value: "guides", label: "Guides" },
		],
	},
	content: { kind: "portableText", label: "Content" },
};

function renderCanvas(diff: RevisionDiff, showChanges = true) {
	return render(
		<RevisionViewCanvas
			diff={diff}
			fields={FIELDS}
			titleField="title"
			showChanges={showChanges}
			authorColor="teal"
			label="Version from Today, 9:12 AM"
			timezone="UTC"
		/>,
	);
}

/** "Most teams plan [-content-]{+posts+} in a spreadsheet." as an edited paragraph. */
const editedParagraph: BlockRow = {
	status: "changed",
	targetId: "b-content-1",
	block: textBlock("Most teams plan posts in a spreadsheet."),
	previous: textBlock("Most teams plan content in a spreadsheet."),
	moved: false,
	change: {
		kind: "text",
		styleChanged: false,
		text: textDiff([
			segment("Most teams plan "),
			segment("content", "removed", { hunk: 0 }),
			segment("posts", "added", { hunk: 0 }),
			segment(" in a spreadsheet."),
		]),
	},
};

const removedParagraph: BlockRow = {
	status: "removed",
	targetId: "b-content-2",
	block: textBlock("Nobody notices until a slot goes empty."),
	text: null,
};

const addedParagraph: BlockRow = {
	status: "added",
	targetId: "b-content-3",
	block: textBlock("Drag a post to another day."),
	text: null,
};

const editDiff = revisionDiff([
	bodyField([
		unchangedRow(0, textBlock("Planning")),
		editedParagraph,
		removedParagraph,
		addedParagraph,
	]),
]);

function documentRoot(container: HTMLElement): HTMLElement {
	const root = container.querySelector<HTMLElement>("[data-emdash-static-document]");
	if (!root) throw new Error("No document root");
	return root;
}

function tagNames(element: Element): string[] {
	return Array.from(element.children, (child) => child.tagName);
}

describe("RevisionViewCanvas", () => {
	it("strikes removed words and highlights added ones as a spaced pair, with spoken prefixes", async () => {
		const screen = await renderCanvas(editDiff);
		const pair = screen.container.querySelector("#revision-b-content-1 [data-revision-pair]")!;
		const del = pair.querySelector("del")!;
		const ins = pair.querySelector("ins")!;

		expect(tagNames(pair)).toEqual(["DEL", "INS"]);
		expect(del.textContent).toBe("Removed: content");
		expect(ins.textContent).toBe("Added: posts");
		expect(del.querySelector(".sr-only")?.textContent).toBe("Removed: ");
		expect(ins.querySelector(".sr-only")?.textContent).toBe("Added: ");
		expect(ins.getBoundingClientRect().left).toBeGreaterThan(del.getBoundingClientRect().right);
	});

	it("starts each wrapped line of a replacement's new text at the line's edge", async () => {
		const screen = await renderCanvas(
			revisionDiff([
				bodyField([
					{
						...editedParagraph,
						block: textBlock("Drag to reschedule"),
						previous: textBlock("Rescheduling"),
						change: {
							kind: "text",
							styleChanged: false,
							text: textDiff([
								segment("Rescheduling", "removed", { hunk: 0 }),
								segment("Drag to reschedule", "added", { hunk: 0 }),
							]),
						},
					},
				]),
			]),
		);
		const block = screen.container.querySelector<HTMLElement>("#revision-b-content-1")!;
		block.style.width = "min-content";
		const lineStart = block.querySelector("del")!.getBoundingClientRect().left;
		const wrapped = [...block.querySelector("ins")!.getClientRects()].slice(1);

		expect(wrapped.length).toBeGreaterThan(0);
		for (const line of wrapped) expect(line.left).toBeCloseTo(lineStart, 0);
	});

	it("marks whole removed and added blocks", async () => {
		const screen = await renderCanvas(editDiff);
		const removed = screen.container.querySelector("#revision-b-content-2")!;
		const added = screen.container.querySelector("#revision-b-content-3")!;

		expect(removed.querySelector("del")?.textContent).toBe(
			"Removed: Nobody notices until a slot goes empty.",
		);
		expect(added.hasAttribute("data-revision-tint")).toBe(true);
		expect(added.querySelector(".sr-only")?.textContent).toBe("Added: ");
		expect(added.querySelector("ins")).toBeNull();
	});

	it("marks a rewritten block as changed without its old text, and a restyled one as restyled", async () => {
		const screen = await renderCanvas(
			revisionDiff([
				bodyField([
					{
						status: "changed",
						targetId: "b-content-0",
						block: textBlock("An entirely new paragraph."),
						previous: textBlock("The old paragraph."),
						moved: false,
						change: {
							kind: "text",
							styleChanged: false,
							text: textDiff([segment("An entirely new paragraph.")], "whole"),
						},
					},
					{
						status: "changed",
						targetId: "b-content-1",
						block: textBlock("Details", { style: "h2" }),
						previous: textBlock("Details", { style: "h3" }),
						moved: false,
						change: { kind: "text", styleChanged: true, text: textDiff([segment("Details")]) },
					},
				]),
			]),
		);
		const rewritten = screen.container.querySelector("#revision-b-content-0")!;
		const restyled = screen.container.querySelector("#revision-b-content-1")!;

		expect(rewritten.hasAttribute("data-revision-tint")).toBe(true);
		expect(rewritten.textContent).toBe("Changed: An entirely new paragraph.");
		expect(rewritten.querySelector("del")).toBeNull();
		expect(restyled.tagName).toBe("H2");
		expect(restyled.querySelector("[data-revision-restyled]")?.textContent).toBe(
			"Style changed: Details",
		);
	});

	it("shows the clean version when changes are hidden", async () => {
		const screen = await renderCanvas(editDiff, false);
		const root = documentRoot(screen.container);

		expect(root.querySelectorAll("ins, del, [data-revision-tint], .sr-only")).toHaveLength(0);
		expect(Array.from(root.children, (child) => child.textContent)).toEqual([
			"Planning",
			"Most teams plan posts in a spreadsheet.",
			"Drag a post to another day.",
		]);
	});

	it("marks nothing in a first version", async () => {
		const screen = await renderCanvas(
			revisionDiff(
				[
					{ ...stringField("title", [segment("A calmer calendar", "added")]), status: "added" },
					bodyField([addedParagraph]),
				],
				false,
			),
		);

		expect(
			screen.container.querySelectorAll("ins, del, [data-revision-tint], [data-revision-ring]"),
		).toHaveLength(0);
		expect(screen.container.textContent).toContain("A calmer calendar");
	});

	it("makes changed blocks and fields focusable jump targets, and nothing else", async () => {
		const screen = await renderCanvas(
			revisionDiff([
				stringField("title", [
					segment("Plan "),
					segment("posts", "removed", { hunk: 0 }),
					segment("content", "added", { hunk: 0 }),
				]),
				stringField("excerpt", [segment("Unchanged")]),
				...editDiff.fields,
			]),
		);
		const { container } = screen;

		const targets = ["f-title", "f-content", "b-content-1", "b-content-2", "b-content-3"];
		for (const id of targets) {
			expect(container.querySelector(`#revision-${id}`)?.getAttribute("tabindex")).toBe("-1");
		}
		expect(container.querySelectorAll("[tabindex]")).toHaveLength(targets.length);
		const unchanged = documentRoot(container).firstElementChild!;
		expect(unchanged.textContent).toBe("Planning");
		expect(unchanged.id).toBe("");
	});

	it("nests and numbers list items the way the editor does", async () => {
		const bullet = (text: string, level = 1) => textBlock(text, { listItem: "bullet", level });
		const numbered = (text: string, listId: string, listStart = 1) =>
			textBlock(text, { listItem: "number", level: 1, listStart, raw: { listId } });
		const screen = await renderCanvas(
			revisionDiff([
				bodyField([
					unchangedRow(0, bullet("Plan")),
					unchangedRow(1, bullet("Draft", 2)),
					unchangedRow(2, bullet("Publish")),
					unchangedRow(3, numbered("Third", "steps", 3)),
					unchangedRow(4, numbered("Fourth", "steps", 3)),
					unchangedRow(5, textBlock("A note between the steps.")),
					unchangedRow(6, numbered("Fifth", "steps", 3)),
					unchangedRow(7, numbered("One", "other")),
				]),
			]),
		);
		const root = documentRoot(screen.container);

		expect(tagNames(root)).toEqual(["UL", "OL", "P", "OL", "OL"]);
		const [bullets, steps, , continued, other] = [...root.children];
		expect(bullets!.querySelectorAll(":scope > li")).toHaveLength(2);
		expect(bullets!.querySelector(":scope > li > ul > li")?.textContent).toBe("Draft");
		expect(steps!.getAttribute("start")).toBe("3");
		expect(steps!.querySelectorAll(":scope > li")).toHaveLength(2);
		expect(continued!.getAttribute("start")).toBe("5");
		expect(other!.hasAttribute("start")).toBe(false);
	});

	it("only links to safe URLs", async () => {
		const link = (href: string): SegmentMarks => ({
			decorators: [],
			annotations: [{ _type: "link", href } satisfies MarkAnnotation],
		});
		const screen = await renderCanvas(
			revisionDiff([
				bodyField([
					unchangedRow(0, {
						...textBlock("Safe and unsafe"),
						runs: [
							{ text: "Safe", marks: link("https://example.com/plan") },
							{ text: " and ", marks: PLAIN },
							{ text: "unsafe", marks: link("javascript:alert(1)") },
						],
					}),
				]),
			]),
		);

		const safe = screen.getByText("Safe", { exact: true }).element();
		const unsafe = screen.getByText("unsafe", { exact: true }).element();
		expect(safe.getAttribute("href")).toBe("https://example.com/plan");
		expect(safe.getAttribute("target")).toBe("_blank");
		expect(safe.getAttribute("rel")).toBe("noopener noreferrer");
		expect(unsafe.tagName).toBe("A");
		expect(unsafe.hasAttribute("href")).toBe(false);
	});

	it("shows a select's option labels and a switch's state", async () => {
		const screen = await renderCanvas(
			revisionDiff([
				valueField("stage", "select", "draft", "review"),
				{
					type: "boolean",
					slug: "featured",
					label: "featured",
					kind: "boolean",
					status: "changed",
					targetId: "f-featured",
					before: false,
					after: true,
				},
			]),
		);

		const stage = screen.container.querySelector("#revision-f-stage")!;
		expect(stage.querySelector("del")?.textContent).toBe("Removed: Drafting");
		expect(stage.querySelector("ins")?.textContent).toBe("Added: In review");
		const featured = screen.getByRole("switch", { name: "Featured post" });
		await expect.element(featured).toBeChecked();
		await expect.element(featured).toBeDisabled();
	});

	it("shows stored times in the site's time zone, not the browser's", async () => {
		const screen = await renderCanvas(
			revisionDiff([
				valueField("publishOn", "datetime", "2026-03-08T02:30:00.000Z", "2026-10-01T14:00:00.000Z"),
			]),
		);

		const publishOn = screen.container.querySelector("#revision-f-publishOn")!;
		expect(publishOn.querySelector("del")?.textContent).toMatch(/^Removed: Mar 8, 2026, 2:30\sAM$/);
		expect(publishOn.querySelector("ins")?.textContent).toMatch(/^Added: Oct 1, 2026, 2:00\sPM$/);
	});

	it("gives each field the footprint of the editor's control", async () => {
		const screen = await render(
			<div className="flex gap-6">
				<div
					data-testid="editor"
					className="space-y-6 [&_input]:text-base [&_input]:font-normal [&_textarea]:text-base [&_textarea]:font-normal [&_[role=combobox]]:text-base"
					style={{ width: 384 }}
				>
					<Input size="lg" label="Title" defaultValue="Plan" className="text-lg!" />
					<Input label="Excerpt" required={false} defaultValue="Short" />
					<InputArea label="Notes" rows={10} defaultValue="Line" />
					<Select label="Stage" value="draft" items={{ draft: "Drafting" }}>
						<Select.Option value="draft">Drafting</Select.Option>
					</Select>
					<Switch label="Featured post" checked />
					<div>
						<InputArea
							label="Settings"
							rows={8}
							className="font-mono text-base"
							defaultValue="{}"
						/>
					</div>
					<fieldset>
						<Label>Tags</Label>
						<div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
							<Checkbox label="News" checked />
							<Checkbox label="Guides" />
						</div>
					</fieldset>
				</div>
				<div data-testid="view" style={{ width: 384 }}>
					<RevisionViewCanvas
						diff={revisionDiff([
							stringField("title", [segment("Plan")]),
							stringField("excerpt", [segment("Short")]),
							stringField("notes", [segment("Line")], "richText"),
							valueField("stage", "select", "draft", "draft"),
							{
								type: "boolean",
								slug: "featured",
								label: "featured",
								kind: "boolean",
								status: "unchanged",
								targetId: "f-featured",
								before: true,
								after: true,
							},
							valueField("settings", "json", "{}", "{}"),
							valueField("tags", "multiSelect", ["news"], ["news"]),
						])}
						fields={FIELDS}
						titleField="title"
						showChanges
						authorColor="blue"
						label="Version from Today, 9:12 AM"
						timezone="UTC"
					/>
				</div>
			</div>,
		);
		const heights = (element: Element) =>
			Array.from(element.children, (child) => child.getBoundingClientRect().height);

		const view = screen.getByTestId("view").element().querySelector("article")!;
		expect(heights(view)).toEqual(heights(screen.getByTestId("editor").element()));
	});

	it("lays the document out where the editor does", async () => {
		const span = (text: string) => ({ _type: "span", _key: text, text, marks: [] });
		const block = (key: string, text: string, extra: Record<string, unknown> = {}) => ({
			_type: "block",
			_key: key,
			style: "normal",
			markDefs: [],
			children: [span(text)],
			...extra,
		});
		const image = {
			_type: "image",
			_key: "img",
			asset: {
				_ref: "media",
				url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='200'/%3E",
				provider: "external",
			},
			width: 400,
			height: 200,
		};
		const table = {
			_type: "table",
			_key: "table",
			rows: [
				{
					_type: "tableRow",
					_key: "r1",
					cells: [
						{ _type: "tableCell", _key: "c1", content: [span("Day")], isHeader: true },
						{ _type: "tableCell", _key: "c2", content: [span("Post")], isHeader: true },
					],
				},
			],
		};
		const code = "const plan = await calendar.next();\nplan.publish();";
		const stored: Array<[Record<string, unknown>, NormalizedBlock]> = [
			[
				block("h", "Why calendars help", { style: "h2" }),
				textBlock("Why calendars help", { style: "h2" }),
			],
			[
				block("p", "Most teams plan posts in a spreadsheet."),
				textBlock("Most teams plan posts in a spreadsheet."),
			],
			[
				block("b1", "Plan", { listItem: "bullet", level: 1 }),
				textBlock("Plan", { listItem: "bullet", level: 1 }),
			],
			[
				block("b2", "Draft", { listItem: "bullet", level: 2 }),
				textBlock("Draft", { listItem: "bullet", level: 2 }),
			],
			[
				block("q", "Ship small.", { style: "blockquote" }),
				textBlock("Ship small.", { style: "blockquote" }),
			],
			[
				{ _type: "code", _key: "code", code, language: "js" },
				{ kind: "code", key: null, type: "code", raw: null, language: "js", code },
			],
			[
				{ _type: "break", _key: "hr", style: "lineBreak" },
				{ kind: "opaque", key: null, type: "break", raw: null },
			],
			[
				image,
				{
					kind: "image",
					key: null,
					type: "image",
					raw: image,
					asset: "external:media",
					alt: "",
					caption: "",
				},
			],
			[
				block("h3", "What goes on it", { style: "h3" }),
				textBlock("What goes on it", { style: "h3" }),
			],
			[table, { kind: "opaque", key: null, type: "table", raw: table }],
			[block("e", ""), textBlock("")],
			[block("end", "The end."), textBlock("The end.")],
		];
		const page = { className: "emdash-editor-page space-y-6", style: { width: 640 } };
		const screen = await render(
			<div className="flex">
				<div {...page}>
					<PortableTextEditor value={stored.map(([raw]) => raw) as never} variant="document" />
				</div>
				<div {...page}>
					<RevisionViewCanvas
						diff={revisionDiff([
							bodyField(stored.map(([, normalized], index) => unchangedRow(index, normalized))),
						])}
						fields={FIELDS}
						showChanges
						authorColor="blue"
						label="Version from Today, 9:12 AM"
						timezone="UTC"
					/>
				</div>
			</div>,
		);
		const layout = (root: Element) => {
			const top = root.getBoundingClientRect().top;
			return Array.from(root.children, (child) => {
				const box = child.getBoundingClientRect();
				return `${child.tagName} ${Math.round(box.top - top)} ${Math.round(box.height)}`;
			});
		};

		await expect
			.poll(() => screen.container.querySelector(".ProseMirror img")?.complete)
			.toBe(true);
		expect(layout(documentRoot(screen.container))).toEqual(
			layout(screen.container.querySelector(".ProseMirror")!),
		);
	});
});
