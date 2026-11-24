/**
 * Three editors with the shipped schema and `ySyncPlugin`, each on its own Y
 * document, make random edits from a fixed seed and exchange updates in order
 * per link, with clients going offline and reconnecting. Every character and
 * atom any replica deletes is classified by cause, so a deletion y-tiptap
 * makes for a schema reason can't hide among the edits.
 */

import { Editor, Extension } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { prosemirrorToYXmlFragment, ySyncPlugin, ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { portableTextExtensions, portableTextSchema } from "../../src/internal/portable-text.js";
import { PortableTextFilledDefaults } from "../../src/portable-text/schema.js";
import { PortableTextYSync } from "../../src/portable-text/y-sync.js";

const REMOTE = Symbol("remote");
const CLIENTS = 3;
/** Larger documents mean a normalizer is adding table cells on every client. */
const MAX_DOC = 6000;
const SETTLE_ROUNDS = 30;
/** More `appendTransaction` calls than this in one dispatch mean normalizers answer each other forever. */
const MAX_APPENDS = 2000;
const MINIMIZE_RUNS = 400;

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(items: readonly T[], r: number): T =>
	items[Math.min(items.length - 1, Math.floor(r * items.length))]!;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stackOf = (error: unknown) =>
	String(error instanceof Error ? error.stack : error)
		.split("\n")
		.slice(0, 14)
		.map((line) => line.trim())
		.join(" | ");

type Json = Record<string, unknown>;
const t = (text: string, marks?: Json[]): Json =>
	marks ? { type: "text", text, marks } : { type: "text", text };
const p = (...content: Array<string | Json>): Json => ({
	type: "paragraph",
	content: content.map((x) => (typeof x === "string" ? t(x) : x)),
});
const li = (...content: Json[]): Json => ({ type: "listItem", content });
const cell = (type: string, text: string): Json => ({ type, content: [p(text)] });

const INITIAL: Json = {
	type: "doc",
	content: [
		p("Alpha bravo charlie"),
		{ type: "heading", attrs: { level: 2 }, content: [t("Heading one")] },
		p("Delta echo ", t("foxtrot", [{ type: "bold" }]), " golf"),
		{
			type: "bulletList",
			content: [
				li(p("one")),
				li(p("two"), p("two b")),
				li(p("three"), { type: "bulletList", content: [li(p("three a")), li(p("three b"))] }),
			],
		},
		{
			type: "orderedList",
			attrs: { start: 1 },
			content: [li(p("first")), li(p("second")), li(p("third"))],
		},
		{ type: "blockquote", content: [p("Quote line one"), p("Quote line two")] },
		{
			type: "table",
			content: [
				{
					type: "tableRow",
					content: [
						cell("tableHeader", "H1"),
						cell("tableHeader", "H2"),
						cell("tableHeader", "H3"),
					],
				},
				{
					type: "tableRow",
					content: [cell("tableCell", "a1"), cell("tableCell", "a2"), cell("tableCell", "a3")],
				},
				{
					type: "tableRow",
					content: [cell("tableCell", "b1"), cell("tableCell", "b2"), cell("tableCell", "b3")],
				},
			],
		},
		{ type: "image", attrs: { src: "https://example.com/a.png", alt: "A" } },
		p(
			"Hotel india ",
			t("juliet", [{ type: "link", attrs: { href: "https://example.com" } }]),
			" kilo",
		),
		{ type: "codeBlock", content: [t("const x = 1")] },
		p("Lima mike"),
	],
};

let shared: { schema: Schema; atoms: Set<string>; initialUpdate: Uint8Array } | null = null;

function sharedState() {
	if (shared) return shared;
	const schema = portableTextSchema();
	const atoms = new Set(
		Object.values(schema.nodes)
			.filter((type) => type.isAtom && !type.isText)
			.map((type) => type.name),
	);
	const doc = new Y.Doc();
	doc.clientID = 1000;
	prosemirrorToYXmlFragment(schema.nodeFromJSON(INITIAL), doc.getXmlFragment("default"));
	shared = { schema, atoms, initialUpdate: Y.encodeStateAsUpdate(doc) };
	doc.destroy();
	return shared;
}

const MARK_KEY = /(.*)(--[a-zA-Z0-9+/=]{8})$/;
const markName = (key: string) => MARK_KEY.exec(key)?.[1] ?? key;

interface TextDelta {
	insert: unknown;
	attributes?: Record<string, Record<string, unknown>>;
}

function yTextNodes(schema: Schema, text: Y.XmlText): ProseMirrorNode[] {
	const deltas = text.toDelta() as TextDelta[];
	return deltas.flatMap((delta) =>
		typeof delta.insert === "string" && delta.insert.length > 0
			? [
					schema.text(
						delta.insert,
						Object.entries(delta.attributes ?? {}).map(([key, attrs]) =>
							schema.mark(markName(key), attrs),
						),
					),
				]
			: [],
	);
}

function yToPM(schema: Schema, type: Y.XmlFragment | Y.XmlElement): ProseMirrorNode {
	const children: ProseMirrorNode[] = [];
	for (const child of type.toArray()) {
		if (child instanceof Y.XmlText) children.push(...yTextNodes(schema, child));
		else if (child instanceof Y.XmlElement) children.push(yToPM(schema, child));
	}
	if (type instanceof Y.XmlElement) {
		return schema.nodeType(type.nodeName).create(type.getAttributes(), Fragment.from(children));
	}
	return schema.topNodeType.create(null, Fragment.from(children));
}

function whyInvalid(schema: Schema, type: Y.XmlElement | Y.XmlText): string {
	try {
		if (type instanceof Y.XmlText) {
			yTextNodes(schema, type);
			return "text: unknown";
		}
		const node = yToPM(schema, type);
		node.type.createChecked(node.attrs, node.content);
		return "valid?";
	} catch (error) {
		return errorMessage(error).slice(0, 160);
	}
}

type DeletionClass = "local" | "schema" | "remote" | "other";
type ItemKind = "text" | "atom" | "el";

interface Captured {
	id: string;
	node: string;
	parent: string;
	grandparent: string | null;
	xml: string | null;
	reason: string | null;
}

export interface SchemaDeletion extends Partial<Captured> {
	client: number;
	event: number;
	trigger: string | null;
	items: number;
	text: string;
	atoms: string[];
	nonEmpty: boolean;
}

interface Indirect {
	keys: string[];
	kind: ItemKind;
	ancestors: string[];
	cls: DeletionClass;
	client: number;
}

interface ExplodedAt {
	event: number;
	size: number;
	cells: number;
}

interface AppendLoop {
	event: number;
	op: string | null;
	appended: string[];
	doc: string;
}

interface RunContext {
	queues: Uint8Array[][][];
	schemaOf: Map<Y.Doc, Schema>;
	deletions: SchemaDeletion[];
	errors: string[];
	errorStacks: Record<string, string>;
	local: boolean;
	flush: boolean;
	unexpected: number;
	unexpectedStack: string | null;
	eventIndex: number;
	trigger: string | null;
	opName: string | null;
	editLog: Array<{ event: number; client: number; op: string }>;
	editsApplied: number;
	del: Record<DeletionClass, Set<string>>;
	indirect: Indirect[];
	kindOf: Map<string, ItemKind>;
	applies: number;
	staleAfterApply: number;
	staleClient: boolean[];
	staleWrites: number;
	maxDoc: number;
	maxCells: number;
	remoteAppend: Record<string, number>;
	captureResets: number;
	exploded: ExplodedAt | null;
	appendLoop: AppendLoop | null;
	appends: number;
	appended: string[];
}

function createContext(): RunContext {
	return {
		queues: Array.from({ length: CLIENTS }, () => Array.from({ length: CLIENTS }, () => [])),
		schemaOf: new Map(),
		deletions: [],
		errors: [],
		errorStacks: {},
		local: false,
		flush: false,
		unexpected: 0,
		unexpectedStack: null,
		eventIndex: -1,
		trigger: null,
		opName: null,
		editLog: [],
		editsApplied: 0,
		del: { local: new Set(), schema: new Set(), remote: new Set(), other: new Set() },
		indirect: [],
		kindOf: new Map(),
		applies: 0,
		staleAfterApply: 0,
		staleClient: Array.from<boolean>({ length: CLIENTS }).fill(false),
		staleWrites: 0,
		maxDoc: 0,
		maxCells: 0,
		remoteAppend: {},
		captureResets: 0,
		exploded: null,
		appendLoop: null,
		appends: 0,
		appended: [],
	};
}

let current: RunContext | null = null;

/** Ends a run whose document outgrew the cap or whose normalizers never settle. */
class Aborted extends Error {}

const aborted = (ctx: RunContext, error: unknown) =>
	error instanceof Aborted || ctx.exploded !== null || ctx.appendLoop !== null;

const SCHEMA_DELETE = "schemaSafetySchemaDelete";
const CAPTURED = "schemaSafetyCaptured";
const SCHEMA_DELETE_FRAMES = /\bdeleteYType\b/;

/**
 * y-tiptap deletes a node the schema rejects in `deleteYType`, called from
 * `createNodeFromYElement` or `createTextNodesFromYText`, in a transaction
 * whose origin is `ySyncPluginKey`. Its own writes share that origin, so the
 * detectors tell them apart by the call stack.
 */
export function installDetectors(): () => void {
	const itemDelete = Y.Item.prototype.delete;
	Y.Item.prototype.delete = function (this: Y.Item, transaction: Y.Transaction) {
		const meta = transaction.meta;
		if (meta.get(SCHEMA_DELETE) && !meta.get(CAPTURED) && !this.deleted) {
			const content = this.content;
			const contentType = content instanceof Y.ContentType ? content.type : null;
			const type =
				contentType instanceof Y.XmlElement || contentType instanceof Y.XmlText
					? contentType
					: null;
			const schema = current?.schemaOf.get(transaction.doc);
			const parent = this.parent;
			const parentItem = parent instanceof Y.AbstractType ? parent._item : null;
			const captured: Captured = {
				id: `${this.id.client}:${this.id.clock}`,
				node:
					type instanceof Y.XmlElement
						? type.nodeName
						: type instanceof Y.XmlText
							? "#text"
							: content.constructor.name,
				parent: parent instanceof Y.XmlElement ? parent.nodeName : "doc",
				grandparent: parentItem
					? parentItem.parent instanceof Y.XmlElement
						? parentItem.parent.nodeName
						: "doc"
					: null,
				xml: type ? type.toJSON().slice(0, 400) : null,
				reason: schema && type ? whyInvalid(schema, type) : null,
			};
			meta.set(CAPTURED, captured);
		}
		itemDelete.call(this, transaction);
	};

	const applyTransaction = EditorState.prototype.applyTransaction;
	// Normalizer cascades can grow a document a hundredfold in one remote render.
	EditorState.prototype.applyTransaction = function (this: EditorState, tr: Transaction) {
		if (current) {
			current.appends = 0;
			current.appended = [];
		}
		const result = applyTransaction.call(this, tr);
		const size = result.state.doc.content.size;
		if (current && !current.exploded && size > MAX_DOC * 4) {
			current.exploded = {
				event: current.eventIndex,
				size,
				cells: countCells(result.state.doc),
			};
			throw new Aborted();
		}
		return result;
	};

	return () => {
		Y.Item.prototype.delete = itemDelete;
		EditorState.prototype.applyTransaction = applyTransaction;
	};
}

const idKey = (id: Y.ID) => `${id.client}:${id.clock}`;

function recordDeletions(ctx: RunContext, tr: Y.Transaction, client: number) {
	const cls: DeletionClass =
		tr.origin === REMOTE
			? "remote"
			: tr.meta.get(SCHEMA_DELETE)
				? "schema"
				: tr.origin === ySyncPluginKey
					? "local"
					: "other";
	const stale = cls === "local" && ctx.staleClient[client];
	const { atoms } = sharedState();
	Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
		if (!(struct instanceof Y.Item)) return;
		const content = struct.content;
		let keys: string[];
		let kind: ItemKind;
		if (content instanceof Y.ContentString) {
			kind = "text";
			keys = Array.from(
				{ length: content.str.length },
				(_, i) => `${struct.id.client}:${struct.id.clock + i}`,
			);
		} else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
			kind = atoms.has(content.type.nodeName) ? "atom" : "el";
			keys = [idKey(struct.id)];
		} else if (content instanceof Y.ContentType && content.type instanceof Y.XmlText) {
			kind = "el";
			keys = [idKey(struct.id)];
		} else {
			return;
		}
		const set = ctx.del[cls];
		for (const key of keys) {
			set.add(key);
			if (kind !== "el") ctx.kindOf.set(key, kind);
		}
		if (cls === "remote" || cls === "other") {
			const ancestors: string[] = [];
			for (
				let parent = struct.parent;
				parent instanceof Y.AbstractType && parent._item;
				parent = parent._item.parent
			) {
				ancestors.push(idKey(parent._item.id));
			}
			ctx.indirect.push({ keys, kind, ancestors, cls, client });
		}
	});
	if (stale) ctx.staleWrites++;
}

function attachDetectors(ctx: RunContext, doc: Y.Doc, client: number) {
	doc.on("afterTransaction", (tr) => recordDeletions(ctx, tr, client));
	doc.on("beforeTransaction", (tr) => {
		if (tr.origin !== ySyncPluginKey) return;
		const frames = (new Error().stack ?? "").split("\n").slice(1);
		const stack = frames.slice(0, 7).join("\n");
		if (SCHEMA_DELETE_FRAMES.test(frames.join("\n"))) tr.meta.set(SCHEMA_DELETE, true);
		else if (!ctx.local && !ctx.flush) {
			ctx.unexpected++;
			ctx.unexpectedStack ??= stack;
		}
	});
	doc.on("afterTransaction", (tr) => {
		if (!tr.meta.get(SCHEMA_DELETE)) return;
		const { atoms } = sharedState();
		let text = "";
		const deletedAtoms: string[] = [];
		let items = 0;
		Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
			if (!(struct instanceof Y.Item)) return;
			items++;
			const content = struct.content;
			if (content instanceof Y.ContentString) text += content.str;
			else if (
				content instanceof Y.ContentType &&
				content.type instanceof Y.XmlElement &&
				atoms.has(content.type.nodeName)
			) {
				deletedAtoms.push(content.type.nodeName);
			}
		});
		ctx.deletions.push({
			client,
			event: ctx.eventIndex,
			trigger: ctx.trigger,
			items,
			text,
			atoms: deletedAtoms,
			nonEmpty: text.length > 0 || deletedAtoms.length > 0,
			...(tr.meta.get(CAPTURED) as Captured | undefined),
		});
	});
}

interface Client {
	id: number;
	doc: Y.Doc;
	fragment: Y.XmlFragment;
	editor: Editor;
	element: HTMLElement;
}

const isRemoteRender = (transactions: readonly Transaction[]) =>
	transactions.some(
		(tr) =>
			(tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin,
	);

const observed = new WeakSet<object>();

function makeClient(ctx: RunContext, id: number, initialUpdate: Uint8Array): Client {
	const doc = new Y.Doc();
	doc.clientID = id + 1;
	Y.applyUpdate(doc, initialUpdate, REMOTE);
	const fragment = doc.getXmlFragment("default");
	const element = document.createElement("div");
	document.body.append(element);
	const sync = Extension.create({
		name: "schemaSafetySync",
		priority: 1000,
		addProseMirrorPlugins: () => [ySyncPlugin(fragment)],
	});
	attachDetectors(ctx, doc, id);
	ctx.local = true;
	const editor = new Editor({
		element,
		extensions: [...portableTextExtensions(), PortableTextFilledDefaults, PortableTextYSync, sync],
		injectCSS: false,
		content: "",
	});
	ctx.local = false;
	ctx.schemaOf.set(doc, editor.schema);
	// Counts what normalizers append, to stop ones that answer each other forever
	// and to see which write while rendering a remote change.
	editor.state.plugins.forEach((plugin, index) => {
		const append = plugin.spec.appendTransaction;
		if (!append || observed.has(append)) return;
		const name = (plugin as unknown as { key: string }).key.replace(/\$\d*$/, "") || "plugin";
		const wrapped: typeof append = function (transactions, oldState, newState) {
			const active = current;
			if (active && ++active.appends > MAX_APPENDS) {
				active.appendLoop = {
					event: active.eventIndex,
					op: active.local ? active.opName : null,
					appended: active.appended.slice(-6),
					doc: newState.doc.toString().slice(0, 400),
				};
				throw new Aborted();
			}
			const out = append.call(this, transactions, oldState, newState);
			if (active && out?.docChanged) {
				active.appended.push(`${name}#${index}`);
				if (isRemoteRender(transactions)) {
					const key = `${name}#${index}`;
					active.remoteAppend[key] = (active.remoteAppend[key] ?? 0) + 1;
				}
			}
			return out;
		};
		observed.add(wrapped);
		plugin.spec.appendTransaction = wrapped;
	});
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE) return;
		for (let to = 0; to < CLIENTS; to++) if (to !== id) ctx.queues[id]![to]!.push(update);
	});
	return { id, doc, fragment, editor, element };
}

function destroyClient(client: Client) {
	try {
		client.editor.destroy();
	} catch {
		// An aborted run can leave an editor mid-dispatch.
	}
	client.element.remove();
	client.doc.destroy();
}

type Op = [name: string, weight: number, run: (editor: Editor, r: number[]) => string | null];

function textPositions(doc: ProseMirrorNode): number[] {
	const out: number[] = [];
	doc.descendants((node, pos) => {
		if (node.isTextblock) {
			for (let i = 0; i <= node.content.size; i++) out.push(pos + 1 + i);
			return false;
		}
		return true;
	});
	return out;
}

function textblocks(doc: ProseMirrorNode): Array<{ node: ProseMirrorNode; pos: number }> {
	const out: Array<{ node: ProseMirrorNode; pos: number }> = [];
	doc.descendants((node, pos) => {
		if (node.isTextblock) {
			out.push({ node, pos });
			return false;
		}
		return true;
	});
	return out;
}

function within(doc: ProseMirrorNode, pos: number, names: readonly string[]): boolean {
	const $pos = doc.resolve(pos);
	for (let depth = $pos.depth; depth > 0; depth--) {
		if (names.includes($pos.node(depth).type.name)) return true;
	}
	return false;
}

const setSel = (editor: Editor, anchor: number, head = anchor) =>
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)),
	);

/**
 * TipTap's `keyboardShortcut` captures transactions without `try`/`finally`:
 * when a keydown handler throws, the editor keeps capturing and swallows every
 * later dispatch, remote renders included. A browser keydown never goes
 * through that command.
 */
function press(editor: Editor, name: string) {
	try {
		return editor.commands.keyboardShortcut(name);
	} finally {
		if (editor.isCapturingTransaction) {
			editor.isCapturingTransaction = false;
			editor.capturedTransaction = null;
			if (current) current.captureResets++;
		}
	}
}

function command(editor: Editor, name: string, ...args: unknown[]): boolean {
	const commands = editor.commands as unknown as Record<
		string,
		((...a: unknown[]) => boolean) | undefined
	>;
	const run = commands[name];
	if (!run) throw new Error(`The editor has no ${name} command`);
	return run(...args);
}

function rangeSel(editor: Editor, r: number[]) {
	const positions = textPositions(editor.state.doc);
	const i = Math.floor(r[0]! * positions.length);
	const span = r[1]! < 0.6 ? 1 + Math.floor(r[2]! * 8) : Math.floor(r[2]! * 60);
	const j = Math.min(positions.length - 1, i + span);
	setSel(editor, positions[Math.min(i, positions.length - 1)]!, positions[j]!);
}

const WORDS = ["x", "ab", "cde", "fghi", "jk lm", "nopqr"];
const MARKS = [
	"toggleBold",
	"toggleItalic",
	"toggleCode",
	"toggleStrike",
	"toggleUnderline",
	"setLink",
	"unsetLink",
	"toggleSubscript",
	"toggleSuperscript",
];
const TABLE = [
	"addRowBefore",
	"addRowAfter",
	"deleteRow",
	"addColumnBefore",
	"addColumnAfter",
	"deleteColumn",
	"deleteTable",
	"toggleHeaderRow",
	"toggleHeaderColumn",
];

/** Every editor command the edits call. */
export const COMMANDS = [
	...MARKS,
	...TABLE,
	"keyboardShortcut",
	"toggleBulletList",
	"toggleOrderedList",
	"toggleBlockquote",
	"lift",
	"liftListItem",
	"setHeading",
	"setParagraph",
	"toggleCodeBlock",
	"insertTable",
	"insertContent",
	"setHorizontalRule",
	"setHardBreak",
	"selectAll",
];

const OPS: Op[] = [
	[
		"type",
		18,
		(e, r) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			e.view.dispatch(e.state.tr.insertText(pick(WORDS, r[3]!)));
			return "type";
		},
	],
	[
		"deleteRange",
		12,
		(e, r) => {
			rangeSel(e, r);
			press(e, "Backspace");
			return r[1]! < 0.6 ? "delete:short" : "delete:long";
		},
	],
	[
		"backspaceAtStart",
		8,
		(e, r) => {
			const block = pick(textblocks(e.state.doc), r[0]!);
			setSel(e, block.pos + 1);
			press(e, "Backspace");
			return `backspaceAtStart(${block.node.type.name})`;
		},
	],
	[
		"deleteAtEnd",
		5,
		(e, r) => {
			const block = pick(textblocks(e.state.doc), r[0]!);
			setSel(e, block.pos + 1 + block.node.content.size);
			press(e, "Delete");
			return `deleteAtEnd(${block.node.type.name})`;
		},
	],
	[
		"enter",
		9,
		(e, r) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			press(e, "Enter");
			return "enter";
		},
	],
	[
		"tab",
		6,
		(e, r) => {
			const positions = textPositions(e.state.doc).filter((q) =>
				within(e.state.doc, q, ["listItem"]),
			);
			if (!positions.length) return null;
			setSel(e, pick(positions, r[0]!));
			const name = r[1]! < 0.5 ? "Tab" : "Shift-Tab";
			press(e, name);
			return name;
		},
	],
	[
		"toggleList",
		5,
		(e, r) => {
			rangeSel(e, r);
			const name = r[3]! < 0.5 ? "toggleBulletList" : "toggleOrderedList";
			command(e, name);
			return name;
		},
	],
	[
		"blockquote",
		4,
		(e, r) => {
			rangeSel(e, r);
			command(e, "toggleBlockquote");
			return "toggleBlockquote";
		},
	],
	[
		"lift",
		3,
		(e, r) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			const name = r[1]! < 0.5 ? "lift" : "liftListItem";
			command(e, name, name === "lift" ? undefined : "listItem");
			return name;
		},
	],
	[
		"mark",
		10,
		(e, r) => {
			rangeSel(e, r);
			const name = pick(MARKS, r[3]!);
			if (name === "setLink") command(e, name, { href: `https://e.com/${Math.floor(r[4]! * 9)}` });
			else command(e, name);
			return name;
		},
	],
	[
		"blockType",
		6,
		(e, r) => {
			rangeSel(e, r);
			const v = Math.floor(r[3]! * 8);
			if (v < 5) {
				command(e, "setHeading", { level: 1 + v });
				return "setHeading";
			}
			if (v < 7) {
				command(e, "setParagraph");
				return "setParagraph";
			}
			command(e, "toggleCodeBlock");
			return "toggleCodeBlock";
		},
	],
	[
		"table",
		10,
		(e, r) => {
			const positions = textPositions(e.state.doc).filter((q) =>
				within(e.state.doc, q, ["tableCell", "tableHeader"]),
			);
			if (!positions.length) return null;
			setSel(e, pick(positions, r[0]!));
			const name = pick(TABLE, r[3]!);
			command(e, name);
			return `table:${name}`;
		},
	],
	[
		"insertTable",
		2,
		(e, r) => {
			const positions = textPositions(e.state.doc).filter(
				(q) => e.state.doc.resolve(q).depth === 1,
			);
			if (!positions.length) return null;
			setSel(e, pick(positions, r[0]!));
			command(e, "insertTable", { rows: 2, cols: 2, withHeaderRow: r[3]! < 0.5 });
			return "insertTable";
		},
	],
	[
		"image",
		4,
		(e, r) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			command(e, "insertContent", {
				type: "image",
				attrs: { src: `https://e.com/${Math.floor(r[3]! * 99)}.png` },
			});
			return "insertImage";
		},
	],
	[
		"hr",
		2,
		(e, r) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			command(e, "setHorizontalRule");
			return "insertHR";
		},
	],
	[
		"hardBreak",
		2,
		(e, r) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			command(e, "setHardBreak");
			return "hardBreak";
		},
	],
	[
		"deleteAtom",
		3,
		(e, r) => {
			const atoms: number[] = [];
			e.state.doc.descendants((node, pos) => {
				if (node.isAtom && node.isBlock) atoms.push(pos);
			});
			if (!atoms.length) return null;
			e.view.dispatch(
				e.state.tr.setSelection(NodeSelection.create(e.state.doc, pick(atoms, r[0]!))),
			);
			press(e, "Backspace");
			return "deleteAtom";
		},
	],
	[
		"pasteBlocks",
		2,
		(e, r) => {
			rangeSel(e, r);
			command(e, "insertContent", [
				p("pasted"),
				{ type: "bulletList", content: [li(p("pl"))] },
				p("tail"),
			]);
			return "pasteBlocks";
		},
	],
	[
		"selectAllDelete",
		0.3,
		(e) => {
			command(e, "selectAll");
			press(e, "Backspace");
			return "selectAllDelete";
		},
	],
];
const OP_TOTAL = OPS.reduce((sum, op) => sum + op[1], 0);

function drawOp(rng: () => number): Op {
	let x = rng() * OP_TOTAL;
	for (const op of OPS) {
		x -= op[1];
		if (x <= 0) return op;
	}
	return OPS[0]!;
}

export type ScriptEvent =
	| { t: "edit"; c: number; seed: number }
	| { t: "deliver"; from: number; to: number; k: number }
	| { t: "toggle"; c: number };

/** Edits, in-order deliveries of part of one link's queue, and clients going offline or back. */
export function generateScript(seed: number, edits: number): ScriptEvent[] {
	const rng = mulberry32(seed);
	const events: ScriptEvent[] = [];
	let n = 0;
	while (n < edits) {
		const roll = rng();
		if (roll < 0.5) {
			events.push({ t: "edit", c: Math.floor(rng() * CLIENTS), seed: Math.floor(rng() * 2 ** 32) });
			n++;
		} else if (roll < 0.95) {
			const from = Math.floor(rng() * CLIENTS);
			const to = (from + 1 + Math.floor(rng() * (CLIENTS - 1))) % CLIENTS;
			events.push({ t: "deliver", from, to, k: rng() });
		} else {
			events.push({ t: "toggle", c: Math.floor(rng() * CLIENTS) });
		}
	}
	return events;
}

function countCells(doc: ProseMirrorNode): number {
	let n = 0;
	doc.descendants((node) => {
		const role: unknown = node.type.spec.tableRole;
		if (role === "cell" || role === "header_cell") n++;
	});
	return n;
}

function checkSize(ctx: RunContext, client: Client) {
	const size = client.editor.state.doc.content.size;
	if (size > MAX_DOC) {
		ctx.exploded = { event: ctx.eventIndex, size, cells: countCells(client.editor.state.doc) };
		throw new Aborted();
	}
}

function trackSize(ctx: RunContext, client: Client) {
	const doc = client.editor.state.doc;
	if (doc.content.size > ctx.maxDoc) ctx.maxDoc = doc.content.size;
	doc.forEach((node) => {
		if (node.type.name !== "table") return;
		const cells = countCells(node);
		if (cells > ctx.maxCells) ctx.maxCells = cells;
	});
}

function deliver(ctx: RunContext, clients: Client[], from: number, to: number, count: number) {
	const queue = ctx.queues[from]![to]!;
	if (!queue.length) return;
	const batch = queue.splice(0, Math.max(1, Math.min(queue.length, count)));
	const client = clients[to]!;
	ctx.trigger = `${from}->${to}`;
	for (const update of batch) {
		try {
			Y.applyUpdate(client.doc, update, REMOTE);
		} catch (error) {
			if (aborted(ctx, error)) throw new Aborted();
			const message = `apply ${from}->${to}: ${errorMessage(error)}`.slice(0, 200);
			ctx.errors.push(message);
			const kind = message.replace(/\d+/g, "N");
			ctx.errorStacks[kind] ??= stackOf(error);
		}
		checkSize(ctx, client);
		const fresh = client.editor.state.doc.eq(yToPM(client.editor.schema, client.fragment));
		ctx.applies++;
		if (!fresh) ctx.staleAfterApply++;
		ctx.staleClient[to] = !fresh;
		trackSize(ctx, client);
	}
	ctx.trigger = null;
}

/** Delivers everything and lets each editor write what Yjs doesn't have yet, until nothing is left. */
function settle(ctx: RunContext, clients: Client[]): boolean {
	for (let round = 0; round < SETTLE_ROUNDS; round++) {
		let delivered = 0;
		for (let a = 0; a < CLIENTS; a++) {
			for (let b = 0; b < CLIENTS; b++) {
				const queued = ctx.queues[a]![b]!.length;
				if (a !== b && queued) {
					delivered += queued;
					deliver(ctx, clients, a, b, Infinity);
				}
			}
		}
		ctx.flush = true;
		for (const client of clients) {
			try {
				client.editor.view.dispatch(client.editor.state.tr);
			} catch (error) {
				if (aborted(ctx, error)) throw new Aborted();
				ctx.errors.push(`flush: ${errorMessage(error)}`);
			}
			checkSize(ctx, client);
		}
		ctx.flush = false;
		const pending = ctx.queues.flat().some((queue) => queue.length > 0);
		if (!delivered && !pending) return true;
	}
	return false;
}

interface Comparison {
	pmEqual: boolean;
	yEqual: boolean;
	pmMatchesY: boolean;
	yValid: boolean;
	yInvalidReason: string | null;
	subSup: number;
	diff?: { client: number; at: number | null; pm: string; y: string };
}

function compare(clients: Client[]): Comparison {
	const pm = clients.map((client) => JSON.stringify(client.editor.state.doc.toJSON()));
	const yJson = clients.map((client) => JSON.stringify(client.fragment.toJSON()));
	const result: Comparison = {
		pmEqual: pm.every((json) => json === pm[0]),
		yEqual: yJson.every((json) => json === yJson[0]),
		pmMatchesY: true,
		yValid: true,
		yInvalidReason: null,
		subSup: 0,
	};
	clients.forEach((client, index) => {
		const fromY = yToPM(client.editor.schema, client.fragment);
		if (JSON.stringify(fromY.toJSON()) !== pm[index]) {
			result.pmMatchesY = false;
			const doc = client.editor.state.doc;
			result.diff ??= {
				client: index,
				at: doc.content.findDiffStart(fromY.content),
				pm: doc.toString().slice(0, 2000),
				y: fromY.toString().slice(0, 2000),
			};
		}
		try {
			fromY.check();
		} catch (error) {
			result.yValid = false;
			result.yInvalidReason ??= errorMessage(error).slice(0, 160);
		}
	});
	yToPM(clients[0]!.editor.schema, clients[0]!.fragment).descendants((node) => {
		const names = new Set(node.marks.map((mark) => mark.type.name));
		if (node.isText && names.has("subscript") && names.has("superscript")) result.subSup++;
	});
	return result;
}

interface RunResult {
	ctx: RunContext;
	setupDeletions: SchemaDeletion[];
	converged: boolean | null;
	check: Comparison | null;
}

/** A write to the shared document from outside the editors, such as a server's. */
export type OutsideWrite = (fragment: Y.XmlFragment) => void;

function writeFromOutside(clients: Client[], initialUpdate: Uint8Array, write: OutsideWrite) {
	const outside = new Y.Doc();
	outside.clientID = 999;
	Y.applyUpdate(outside, initialUpdate);
	const before = Y.encodeStateVector(outside);
	write(outside.getXmlFragment("default"));
	const update = Y.encodeStateAsUpdate(outside, before);
	outside.destroy();
	for (const client of clients) Y.applyUpdate(client.doc, update, REMOTE);
}

function runScript(script: readonly ScriptEvent[], outsideWrite?: OutsideWrite): RunResult {
	const { initialUpdate } = sharedState();
	const ctx = createContext();
	current = ctx;
	const clients: Client[] = [];
	let converged: boolean | null = null;
	let check: Comparison | null = null;
	let setupDeletions: SchemaDeletion[] = [];
	try {
		for (let id = 0; id < CLIENTS; id++) clients.push(makeClient(ctx, id, initialUpdate));
		settle(ctx, clients);
		setupDeletions = ctx.deletions.splice(0);
		if (outsideWrite) writeFromOutside(clients, initialUpdate, outsideWrite);
		const online = Array.from<boolean>({ length: CLIENTS }).fill(true);
		for (const [i, event] of script.entries()) {
			ctx.eventIndex = i;
			if (event.t === "edit") {
				const editor = clients[event.c]!.editor;
				const rng = mulberry32(event.seed);
				let label: string | null = null;
				for (let attempt = 0; attempt < 12 && !label; attempt++) {
					const [opName, , run] = drawOp(rng);
					ctx.opName = opName;
					const r = [rng(), rng(), rng(), rng(), rng(), rng()];
					const before = editor.state.doc;
					ctx.local = true;
					try {
						const result = run(editor, r);
						if (result && editor.state.doc !== before) label = result;
					} catch (error) {
						if (aborted(ctx, error)) throw new Aborted();
						ctx.errors.push(`op ${opName}: ${errorMessage(error)}`.slice(0, 200));
					} finally {
						ctx.local = false;
					}
				}
				if (label) {
					ctx.editsApplied++;
					ctx.editLog.push({ event: i, client: event.c, op: label });
				}
			} else if (event.t === "deliver") {
				if (!online[event.from] || !online[event.to]) continue;
				const queued = ctx.queues[event.from]![event.to]!.length;
				deliver(ctx, clients, event.from, event.to, 1 + Math.floor(event.k * queued));
			} else {
				online[event.c] = !online[event.c];
			}
			for (const client of clients) checkSize(ctx, client);
		}
		ctx.eventIndex = script.length;
		converged = settle(ctx, clients);
		check = compare(clients);
	} catch (error) {
		if (!aborted(ctx, error)) throw error;
	} finally {
		current = null;
		for (const client of clients) destroyClient(client);
	}
	return { ctx, setupDeletions, converged, check };
}

export interface Losses {
	schemaDirectChars: number;
	schemaDirectAtoms: number;
	schemaLateChars: number;
	schemaLateAtoms: number;
	mergeLateChars: number;
	mergeLateAtoms: number;
	ancestorReplacedChars: number;
	ancestorReplacedAtoms: number;
	unexplainedChars: number;
	unexplainedAtoms: number;
}

const noLosses = (): Losses => ({
	schemaDirectChars: 0,
	schemaDirectAtoms: 0,
	schemaLateChars: 0,
	schemaLateAtoms: 0,
	mergeLateChars: 0,
	mergeLateAtoms: 0,
	ancestorReplacedChars: 0,
	ancestorReplacedAtoms: 0,
	unexplainedChars: 0,
	unexplainedAtoms: 0,
});

/** Characters and atoms lost to anything but a concurrent edit replacing an ancestor. */
const lostItems = (losses: Losses) =>
	losses.schemaDirectChars +
	losses.schemaDirectAtoms +
	losses.schemaLateChars +
	losses.schemaLateAtoms +
	losses.mergeLateChars +
	losses.mergeLateAtoms +
	losses.unexplainedChars +
	losses.unexplainedAtoms;

/**
 * Classifies every character and atom any replica deleted. Deleted directly
 * by y-tiptap for a schema reason, deleted with an element y-tiptap deleted
 * for one (including content another client added to it later), deleted with
 * a text node y-tiptap merged into its neighbor, deleted because a concurrent
 * edit replaced an ancestor (standard Yjs semantics), or unexplained.
 */
function classify(ctx: RunContext): Losses {
	const { local, schema, other } = ctx.del;
	const out = noLosses();
	const seen = new Set<string>();
	for (const key of schema) {
		const kind = ctx.kindOf.get(key);
		if (!kind || local.has(key)) continue;
		seen.add(key);
		if (kind === "text") out.schemaDirectChars++;
		else out.schemaDirectAtoms++;
	}
	for (const record of ctx.indirect) {
		if (record.kind === "el") continue;
		const text = record.kind === "text";
		for (const key of record.keys) {
			// y-tiptap copies a text node into its left neighbor before it deletes it.
			if (local.has(key) || schema.has(key) || seen.has(key) || other.has(key)) continue;
			seen.add(key);
			if (record.ancestors.some((ancestor) => local.has(ancestor))) {
				if (text) out.ancestorReplacedChars++;
				else out.ancestorReplacedAtoms++;
			} else if (record.ancestors.some((ancestor) => schema.has(ancestor))) {
				if (text) out.schemaLateChars++;
				else out.schemaLateAtoms++;
			} else if (record.ancestors.some((ancestor) => other.has(ancestor))) {
				if (text) out.mergeLateChars++;
				else out.mergeLateAtoms++;
			} else if (record.cls !== "other") {
				if (text) out.unexplainedChars++;
				else out.unexplainedAtoms++;
			}
		}
	}
	return out;
}

export interface Failure {
	kind: string;
	message: string;
}

export interface RunReport {
	editsApplied: number;
	schemaDeletions: SchemaDeletion[];
	nonEmptyDeletions: SchemaDeletion[];
	setupDeletions: number;
	losses: Losses;
	exploded: ExplodedAt | null;
	appendLoop: AppendLoop | null;
	converged: boolean | null;
	check: Comparison | null;
	errors: string[];
	errorStacks: Record<string, string>;
	unexpected: number;
	unexpectedStack: string | null;
	applies: number;
	staleAfterApply: number;
	staleWrites: number;
	remoteAppend: Record<string, number>;
	captureResets: number;
	maxDoc: number;
	maxCells: number;
	editLog: RunContext["editLog"];
	failures: Failure[];
}

function failuresOf(run: Omit<RunReport, "failures">): Failure[] {
	const failures: Failure[] = [];
	for (const deletion of run.nonEmptyDeletions) {
		failures.push({
			kind: `schema delete: ${deletion.node} in ${deletion.parent}`,
			message:
				`client ${deletion.client} at event ${deletion.event} deleted ${deletion.node} in ${deletion.parent} (${deletion.reason}): ${JSON.stringify(deletion.text)} ${deletion.atoms.join(" ")}`.trim(),
		});
	}
	const { losses } = run;
	const schemaLost =
		losses.schemaDirectChars +
		losses.schemaDirectAtoms +
		losses.schemaLateChars +
		losses.schemaLateAtoms;
	if (schemaLost > 0) {
		failures.push({
			kind: "schema loss",
			message: `schema deletions lost ${losses.schemaDirectChars + losses.schemaLateChars} characters and ${losses.schemaDirectAtoms + losses.schemaLateAtoms} atoms`,
		});
	}
	if (losses.mergeLateChars + losses.mergeLateAtoms > 0) {
		failures.push({
			kind: "text merge loss",
			message: `text y-tiptap merged away lost ${losses.mergeLateChars} characters and ${losses.mergeLateAtoms} atoms`,
		});
	}
	if (losses.unexplainedChars + losses.unexplainedAtoms > 0) {
		failures.push({
			kind: "unexplained loss",
			message: `${losses.unexplainedChars} characters and ${losses.unexplainedAtoms} atoms were deleted with no known cause`,
		});
	}
	if (run.exploded) {
		failures.push({
			kind: "size cap",
			message: `a document grew to ${run.exploded.size} with ${run.exploded.cells} table cells at event ${run.exploded.event}`,
		});
	}
	if (run.appendLoop) {
		const loop = run.appendLoop;
		failures.push({
			kind: "normalizer loop",
			message: `at event ${loop.event}${loop.op ? ` (${loop.op})` : ""} normalizers kept answering each other (${loop.appended.join(", ")}) in ${loop.doc}`,
		});
	}
	if (run.converged === false) {
		failures.push({
			kind: "not converged",
			message: `updates were still queued after ${SETTLE_ROUNDS} rounds`,
		});
	}
	if (run.check && (!run.check.pmEqual || !run.check.yEqual)) {
		failures.push({ kind: "diverged", message: "the replicas hold different documents" });
	}
	if (run.check && !run.check.pmMatchesY) {
		const diff = run.check.diff;
		failures.push({
			kind: "ProseMirror differs from Y",
			message: `client ${diff?.client} differs from its Y document at ${diff?.at}\npm: ${diff?.pm}\ny:  ${diff?.y}`,
		});
	}
	const renderErrors = run.errors.filter((error) => !error.startsWith("op "));
	if (renderErrors.length > 0) {
		failures.push({ kind: "render error", message: renderErrors.slice(0, 3).join("\n") });
	}
	const remoteWrites = Object.entries(run.remoteAppend);
	if (remoteWrites.length > 0) {
		failures.push({
			kind: "write while rendering a remote change",
			message: `normalizers wrote while rendering another client's change: ${remoteWrites.map(([name, count]) => `${name} ${count}x`).join(", ")}`,
		});
	}
	if (run.unexpected > 0) {
		failures.push({
			kind: "unattributed y-sync write",
			message: `${run.unexpected} y-sync transactions the detectors could not attribute:\n${run.unexpectedStack}`,
		});
	}
	return failures;
}

function report(result: RunResult): RunReport {
	const { ctx } = result;
	const unique = new Map<string | undefined, SchemaDeletion>();
	for (const deletion of ctx.deletions)
		if (!unique.has(deletion.id)) unique.set(deletion.id, deletion);
	const schemaDeletions = [...unique.values()];
	const base = {
		editsApplied: ctx.editsApplied,
		schemaDeletions,
		nonEmptyDeletions: schemaDeletions.filter((deletion) => deletion.nonEmpty),
		setupDeletions: result.setupDeletions.length,
		losses: classify(ctx),
		exploded: ctx.exploded,
		appendLoop: ctx.appendLoop,
		converged: ctx.exploded || ctx.appendLoop ? null : result.converged,
		check: ctx.exploded || ctx.appendLoop ? null : result.check,
		errors: ctx.errors,
		errorStacks: ctx.errorStacks,
		unexpected: ctx.unexpected,
		unexpectedStack: ctx.unexpectedStack,
		applies: ctx.applies,
		staleAfterApply: ctx.staleAfterApply,
		staleWrites: ctx.staleWrites,
		remoteAppend: ctx.remoteAppend,
		captureResets: ctx.captureResets,
		maxDoc: ctx.maxDoc,
		maxCells: ctx.maxCells,
		editLog: ctx.editLog,
	};
	return { ...base, failures: failuresOf(base) };
}

export const runSeed = (seed: number, edits: number, outsideWrite?: OutsideWrite) =>
	report(runScript(generateScript(seed, edits), outsideWrite));

/**
 * Drops edits, then deliveries and reconnects, while the run still fails the
 * same way. Ddmin over the edits, then one event at a time.
 */
export function minimize(
	script: readonly ScriptEvent[],
	fails: (run: RunReport) => boolean,
): { events: ScriptEvent[]; edits: RunReport["editLog"] } {
	let cur = [...script];
	let budget = MINIMIZE_RUNS;
	const stillFails = (candidate: ScriptEvent[]) => {
		if (budget <= 0) return false;
		budget--;
		return fails(report(runScript(candidate)));
	};
	const editIndexes = () => cur.flatMap((event, index) => (event.t === "edit" ? [index] : []));
	let n = 2;
	for (;;) {
		const indexes = editIndexes();
		if (indexes.length < 2 || budget <= 0) break;
		const chunk = Math.ceil(indexes.length / n);
		let reduced = false;
		for (let start = 0; start < indexes.length; start += chunk) {
			const drop = new Set(indexes.slice(start, start + chunk));
			const candidate = cur.filter((_, index) => !drop.has(index));
			if (stillFails(candidate)) {
				cur = candidate;
				n = Math.max(n - 1, 2);
				reduced = true;
				break;
			}
		}
		if (!reduced) {
			if (chunk === 1) break;
			n = Math.min(indexes.length, n * 2);
		}
	}
	for (let i = cur.length - 1; i >= 0; i--) {
		if (cur[i]!.t === "edit") continue;
		const candidate = cur.filter((_, index) => index !== i);
		if (stillFails(candidate)) cur = candidate;
	}
	return { events: cur, edits: report(runScript(cur)).editLog };
}

export interface Summary {
	runs: number;
	editsAttempted: number;
	editsApplied: number;
	runsFailed: number;
	failedSeeds: number[];
	schemaDeletions: number;
	nonEmptySchemaDeletions: number;
	runsWithNonEmpty: number;
	lostChars: number;
	lostAtoms: number;
	setupDeletions: number;
	losses: Losses;
	runsWithAnyLoss: number;
	sizeCapExceeded: number;
	normalizerLoops: number;
	notConverged: number;
	diverged: number;
	pmVsY: number;
	yInvalid: number;
	subSupRuns: number;
	renderErrors: number;
	opErrors: number;
	errors: Record<string, number>;
	errorStacks: Record<string, string>;
	unexpectedSyncTx: number;
	applies: number;
	staleAfterApply: number;
	staleWrites: number;
	remoteAppend: Record<string, number>;
	captureResets: number;
	maxDoc: number;
	maxCells: number;
	byReason: Record<string, number>;
	opCounts: Record<string, number>;
}

export function emptySummary(): Summary {
	return {
		runs: 0,
		editsAttempted: 0,
		editsApplied: 0,
		runsFailed: 0,
		failedSeeds: [],
		schemaDeletions: 0,
		nonEmptySchemaDeletions: 0,
		runsWithNonEmpty: 0,
		lostChars: 0,
		lostAtoms: 0,
		setupDeletions: 0,
		losses: noLosses(),
		runsWithAnyLoss: 0,
		sizeCapExceeded: 0,
		normalizerLoops: 0,
		notConverged: 0,
		diverged: 0,
		pmVsY: 0,
		yInvalid: 0,
		subSupRuns: 0,
		renderErrors: 0,
		opErrors: 0,
		errors: {},
		errorStacks: {},
		unexpectedSyncTx: 0,
		applies: 0,
		staleAfterApply: 0,
		staleWrites: 0,
		remoteAppend: {},
		captureResets: 0,
		maxDoc: 0,
		maxCells: 0,
		byReason: {},
		opCounts: {},
	};
}

const bump = (map: Record<string, number>, key: string, n = 1) => {
	map[key] = (map[key] ?? 0) + n;
};

export function addToSummary(summary: Summary, seed: number, edits: number, run: RunReport) {
	summary.runs++;
	summary.editsAttempted += edits;
	summary.editsApplied += run.editsApplied;
	if (run.failures.length > 0) {
		summary.runsFailed++;
		if (summary.failedSeeds.length < 100) summary.failedSeeds.push(seed);
	}
	summary.schemaDeletions += run.schemaDeletions.length;
	summary.nonEmptySchemaDeletions += run.nonEmptyDeletions.length;
	if (run.nonEmptyDeletions.length > 0) summary.runsWithNonEmpty++;
	for (const deletion of run.nonEmptyDeletions) {
		summary.lostChars += deletion.text.length;
		summary.lostAtoms += deletion.atoms.length;
	}
	for (const deletion of run.schemaDeletions) {
		bump(
			summary.byReason,
			`${deletion.node} in ${deletion.parent}: ${String(deletion.reason).replace(/: .*/, "")}${deletion.nonEmpty ? " (non-empty)" : ""}`,
		);
	}
	summary.setupDeletions += run.setupDeletions;
	for (const name of Object.keys(run.losses) as Array<keyof Losses>) {
		summary.losses[name] += run.losses[name];
	}
	if (run.nonEmptyDeletions.length > 0 || lostItems(run.losses) > 0) summary.runsWithAnyLoss++;
	if (run.exploded) summary.sizeCapExceeded++;
	if (run.appendLoop) summary.normalizerLoops++;
	if (run.converged === false) summary.notConverged++;
	if (run.check) {
		if (!run.check.pmEqual || !run.check.yEqual) summary.diverged++;
		if (!run.check.pmMatchesY) summary.pmVsY++;
		if (!run.check.yValid) summary.yInvalid++;
		if (run.check.subSup > 0) summary.subSupRuns++;
	}
	for (const error of run.errors) {
		if (error.startsWith("op ")) summary.opErrors++;
		else summary.renderErrors++;
		bump(summary.errors, error.replace(/\d+/g, "N"));
	}
	for (const [key, stack] of Object.entries(run.errorStacks)) summary.errorStacks[key] ??= stack;
	summary.unexpectedSyncTx += run.unexpected;
	summary.applies += run.applies;
	summary.staleAfterApply += run.staleAfterApply;
	summary.staleWrites += run.staleWrites;
	for (const [key, value] of Object.entries(run.remoteAppend))
		bump(summary.remoteAppend, key, value);
	summary.captureResets += run.captureResets;
	summary.maxDoc = Math.max(summary.maxDoc, run.maxDoc);
	summary.maxCells = Math.max(summary.maxCells, run.maxCells);
	for (const edit of run.editLog) bump(summary.opCounts, edit.op);
}
