/**
 * CodeMirror editor for the HTML block's code tabs. Loaded lazily, so
 * CodeMirror stays out of the admin's main bundle.
 */

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import {
	HighlightStyle,
	bracketMatching,
	indentOnInput,
	syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

export type CodeEditorLanguage = "html" | "css" | "javascript";

export interface CodeEditorProps {
	language: CodeEditorLanguage;
	/** Initial content. Remount the editor to replace it. */
	value: string;
	onChange: (value: string) => void;
	onFocusChange: (focused: boolean) => void;
	onEscape: () => void;
	editable: boolean;
	autoFocus: boolean;
	ariaLabel: string;
	placeholder: string;
}

const LANGUAGES: Record<CodeEditorLanguage, () => Extension> = { html, css, javascript };

const highlightStyle = HighlightStyle.define([
	{ tag: [tags.comment, tags.angleBracket], color: "var(--emdash-code-muted)" },
	{
		tag: [tags.keyword, tags.modifier, tags.bool, tags.null, tags.atom],
		color: "var(--emdash-code-keyword)",
	},
	{
		tag: [tags.string, tags.special(tags.string), tags.regexp, tags.attributeValue],
		color: "var(--emdash-code-string)",
	},
	{ tag: [tags.attributeName, tags.propertyName], color: "var(--emdash-code-string)" },
	{ tag: [tags.number, tags.unit, tags.meta], color: "var(--emdash-code-number)" },
	{
		tag: [tags.tagName, tags.typeName, tags.className, tags.function(tags.variableName)],
		color: "var(--emdash-code-title)",
	},
]);

const theme = EditorView.theme({
	"&": {
		color: "var(--emdash-code-foreground)",
		backgroundColor: "var(--emdash-code-background)",
		maxHeight: "32rem",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", lineHeight: "1.6" },
	".cm-content, .cm-gutter": { minHeight: "10rem" },
	".cm-content": { caretColor: "var(--emdash-code-foreground)", paddingBlock: "0.75rem" },
	".cm-cursor": { borderInlineStartColor: "var(--emdash-code-foreground)" },
	".cm-gutters": {
		backgroundColor: "transparent",
		color: "var(--emdash-code-muted)",
		border: "none",
	},
	".cm-placeholder": { color: "var(--emdash-code-muted)" },
	".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
		{ backgroundColor: "color-mix(in srgb, var(--emdash-code-title) 22%, transparent)" },
});

function editability(editable: boolean): Extension {
	return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}

export default function CodeEditor({
	language,
	value,
	editable,
	autoFocus,
	ariaLabel,
	placeholder: placeholderText,
	...callbacks
}: CodeEditorProps) {
	const { t } = useLingui();
	const hintId = React.useId();
	const hostRef = React.useRef<HTMLDivElement>(null);
	const viewRef = React.useRef<EditorView | null>(null);
	const callbacksRef = React.useRef(callbacks);
	callbacksRef.current = callbacks;
	const [editableCompartment] = React.useState(() => new Compartment());

	React.useEffect(() => {
		const view = new EditorView({
			parent: hostRef.current!,
			doc: value,
			extensions: [
				lineNumbers(),
				history(),
				drawSelection(),
				indentOnInput(),
				bracketMatching(),
				closeBrackets(),
				EditorView.lineWrapping,
				placeholder(placeholderText),
				LANGUAGES[language](),
				syntaxHighlighting(highlightStyle),
				theme,
				Prec.high(
					keymap.of([
						{
							key: "Escape",
							run: () => {
								callbacksRef.current.onEscape();
								return true;
							},
						},
					]),
				),
				keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
				editableCompartment.of(editability(editable)),
				EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-describedby": hintId }),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) callbacksRef.current.onChange(update.state.doc.toString());
				}),
				EditorView.domEventHandlers({
					focus: () => callbacksRef.current.onFocusChange(true),
					blur: () => callbacksRef.current.onFocusChange(false),
				}),
			],
		});
		viewRef.current = view;
		return () => {
			viewRef.current = null;
			view.destroy();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- created once; the parent remounts it to change language or content
	}, []);

	React.useEffect(() => {
		viewRef.current?.dispatch({ effects: editableCompartment.reconfigure(editability(editable)) });
	}, [editable, editableCompartment]);

	React.useEffect(() => {
		if (autoFocus) viewRef.current?.focus();
	}, [autoFocus]);

	return (
		<div className="emdash-code-editor" dir="ltr">
			<div ref={hostRef} />
			<span id={hintId} className="sr-only">
				{t`Press Escape to leave the code editor.`}
			</span>
		</div>
	);
}
