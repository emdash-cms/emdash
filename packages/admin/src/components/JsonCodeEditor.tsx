import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate, keymap, placeholder } from "@codemirror/view";
import * as React from "react";

import { cn } from "../lib/utils";

function formatJsonValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return "";
	}
}

const jsonEditorTheme = EditorView.theme({
	"&": {
		fontFamily:
			'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
		fontSize: "13px",
	},
	".cm-scroller": { overflow: "auto", maxHeight: "20rem", minHeight: "10rem" },
	".cm-content": { padding: "0.625rem 0.75rem", caretColor: "currentColor" },
	".cm-line": { padding: "0" },
	"&.cm-focused": { outline: "none" },
	".cm-gutters": { display: "none" },
});

export interface JsonCodeEditorProps {
	id: string;
	label: string;
	labelClass?: string;
	value: unknown;
	onChange: (value: unknown) => void;
	onValidationChange?: (error: string | null) => void;
}

export function JsonCodeEditor({
	id,
	label,
	labelClass,
	value,
	onChange,
	onValidationChange,
}: JsonCodeEditorProps) {
	const containerRef = React.useRef<HTMLDivElement>(null);
	const viewRef = React.useRef<EditorView | null>(null);
	const onChangeRef = React.useRef(onChange);
	const onValidationRef = React.useRef(onValidationChange);
	onChangeRef.current = onChange;
	onValidationRef.current = onValidationChange;

	React.useEffect(() => {
		if (!containerRef.current) return;

		const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
			if (!update.docChanged) return;
			const content = update.state.doc.toString();
			if (!content.trim()) {
				onChangeRef.current(null);
				onValidationRef.current?.(null);
				return;
			}
			try {
				onChangeRef.current(JSON.parse(content));
				onValidationRef.current?.(null);
			} catch (e) {
				onValidationRef.current?.(e instanceof Error ? e.message : "Invalid JSON");
			}
		});

		const view = new EditorView({
			state: EditorState.create({
				doc: formatJsonValue(value),
				extensions: [
					json(),
					linter(jsonParseLinter()),
					syntaxHighlighting(defaultHighlightStyle),
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({ "aria-labelledby": `${id}-label` }),
					placeholder('{\n  "key": "value"\n}'),
					jsonEditorTheme,
					updateListener,
				],
			}),
			parent: containerRef.current,
		});
		viewRef.current = view;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// Only runs on mount. The component is intentionally uncontrolled.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="space-y-1.5">
			<div
				id={`${id}-label`}
				className={cn("text-sm font-medium leading-none text-kumo-default", labelClass)}
			>
				{label}
			</div>
			<div
				className={cn(
					"overflow-hidden rounded-md border border-kumo-line bg-transparent",
					"focus-within:ring-2 focus-within:ring-kumo-ring focus-within:ring-offset-2",
				)}
			>
				<div ref={containerRef} />
			</div>
		</div>
	);
}
