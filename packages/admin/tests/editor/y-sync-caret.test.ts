import { Editor, Extension } from "@tiptap/core";
import { prosemirrorToYXmlFragment, ySyncPlugin } from "@tiptap/y-tiptap";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { PORTABLE_TEXT_KEY_ATTR } from "../../src/components/editor/portableTextIdentity.js";
import { portableTextExtensions, portableTextSchema } from "../../src/internal/portable-text.js";
import { PortableTextYSync } from "../../src/portable-text/y-sync.js";

const REMOTE = Symbol("remote");
const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors.splice(0)) {
		editor.options.element?.remove();
		editor.destroy();
	}
});

function client(doc: Y.Doc): Editor {
	const fragment = doc.getXmlFragment("default");
	const element = document.createElement("div");
	document.body.append(element);
	const editor = new Editor({
		element,
		extensions: [
			...portableTextExtensions(),
			PortableTextYSync,
			Extension.create({
				name: "testSync",
				priority: 1000,
				addProseMirrorPlugins: () => [ySyncPlugin(fragment)],
			}),
		],
		injectCSS: false,
	});
	editors.push(editor);
	return editor;
}

/** Two editors on one keyed paragraph, as every block is, their documents exchanging every update. */
function pair(text: string) {
	const schema = portableTextSchema();
	const mine = new Y.Doc();
	prosemirrorToYXmlFragment(
		schema.node("doc", null, [
			schema.node("paragraph", { [PORTABLE_TEXT_KEY_ATTR]: "k-a" }, [schema.text(text)]),
		]),
		mine.getXmlFragment("default"),
	);
	const theirs = new Y.Doc();
	Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine), REMOTE);
	for (const [from, to] of [
		[mine, theirs],
		[theirs, mine],
	] as const) {
		from.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) Y.applyUpdate(to, update, REMOTE);
		});
	}
	return { mine: client(mine), theirs: client(theirs) };
}

const beforeCaret = (editor: Editor) =>
	editor.state.doc.textBetween(1, editor.state.selection.head);

describe("the caret during another client's edit in its paragraph", () => {
	it("stays after its text when they type before it", () => {
		const { mine, theirs } = pair("Alpha beta gamma");
		mine.commands.setTextSelection(9);
		expect(beforeCaret(mine)).toBe("Alpha be");

		theirs.commands.insertContentAt(3, "x");

		expect(mine.state.doc.textContent).toBe("Alxpha beta gamma");
		expect(beforeCaret(mine)).toBe("Alxpha be");
	});

	it("stays after its text when they delete before it", () => {
		const { mine, theirs } = pair("Alpha beta gamma");
		mine.commands.setTextSelection(9);

		theirs.commands.deleteRange({ from: 2, to: 4 });

		expect(mine.state.doc.textContent).toBe("Aha beta gamma");
		expect(beforeCaret(mine)).toBe("Aha be");
	});
});
