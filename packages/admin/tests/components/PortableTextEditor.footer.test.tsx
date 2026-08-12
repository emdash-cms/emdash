import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { screen } from "@testing-library/react";
import CharacterCount from "@tiptap/extension-character-count";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { _EditorFooter, countWords } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render.tsx";

// The msg macro hashes to the same message id as the corresponding macro call
// in EditorFooter, so this catalog binds translations for exactly the messages
// the footer renders.
const deMessages = {
	[msg`{words, plural, one {# word} other {# words}}`.id!]:
		"{words, plural, one {# Wort} other {# Wörter}}",
	[msg`{characters, plural, one {# character} other {# characters}}`.id!]:
		"{characters, plural, one {# Zeichen} other {# Zeichen}}",
	[msg`{readingTime, plural, one {# min read} other {# min read}}`.id!]:
		"{readingTime, plural, one {# Minute Lesezeit} other {# Min. Lesezeit}}",
};

beforeAll(() => {
	i18n.loadAndActivate({ locale: "de", messages: deMessages });
});

afterAll(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

function FooterHarness({ content }: { content: string }) {
	const editor = useEditor({
		extensions: [StarterKit, CharacterCount.configure({ wordCounter: countWords })],
		content,
		immediatelyRender: true,
	});

	if (!editor) return null;
	return <_EditorFooter editor={editor} />;
}

describe("EditorFooter localization", () => {
	it("renders the metrics translated when the active catalog provides them", async () => {
		void render(<FooterHarness content="<p>Hallo schöne Welt</p>" />);

		await vi.waitFor(() => {
			expect(screen.getByText("3 Wörter")).toBeTruthy();
		});
		expect(screen.getByText("17 Zeichen")).toBeTruthy();
		expect(screen.getByText("1 Minute Lesezeit")).toBeTruthy();
	});

	it("uses the catalog's plural rules for the singular branch", async () => {
		void render(<FooterHarness content="<p>Hallo</p>" />);

		await vi.waitFor(() => {
			expect(screen.getByText("1 Wort")).toBeTruthy();
		});
		expect(screen.getByText("5 Zeichen")).toBeTruthy();
	});
});
