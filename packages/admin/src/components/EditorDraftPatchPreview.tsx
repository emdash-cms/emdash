import { LayerDialog } from "@cloudflare/kumo";
import type { EditorDraftPatchOperation } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { guardUnsavedInput } from "../lib/dialog-form.js";

interface PreviewField {
	label?: string;
	kind?: string;
	widget?: string;
}

interface EditorDraftPatchPreviewProps {
	operations: EditorDraftPatchOperation[];
	fields: Record<string, PreviewField>;
	currentValues: Record<string, unknown>;
	onApply: () => void;
	onClose: () => void;
}

const PLAIN_BLOCK_KEYS = new Set(["_type", "_key", "style", "markDefs", "children"]);
const PLAIN_SPAN_KEYS = new Set(["_type", "_key", "text", "marks"]);

function hasOnlyKeys(value: object, keys: Set<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

/** The text of a plain span: one with no marks and nothing besides its text. */
function plainSpanText(child: unknown): string | null {
	if (typeof child !== "object" || child === null) return null;
	if (!hasOnlyKeys(child, PLAIN_SPAN_KEYS)) return null;
	if (!("_type" in child) || child._type !== "span") return null;
	if ("marks" in child && !(Array.isArray(child.marks) && child.marks.length === 0)) return null;
	return "text" in child && typeof child.text === "string" ? child.text : null;
}

/** The text of a normal paragraph made only of plain spans, or null for any other block. */
function plainBlockText(block: unknown): string | null {
	if (typeof block !== "object" || block === null) return null;
	if (!hasOnlyKeys(block, PLAIN_BLOCK_KEYS)) return null;
	if (!("_type" in block) || block._type !== "block") return null;
	if ("style" in block && block.style !== "normal") return null;
	if ("markDefs" in block && !(Array.isArray(block.markDefs) && block.markDefs.length === 0)) {
		return null;
	}
	if (!("children" in block) || !Array.isArray(block.children)) return null;
	let text = "";
	for (const child of block.children) {
		const span = plainSpanText(child);
		if (span === null) return null;
		text += span;
	}
	return text;
}

/**
 * One rich-text block on one line: a plain paragraph as its text, and any other block as its
 * JSON, so that styles, lists, marks and links all show.
 */
function describeBlock(block: unknown): string {
	return plainBlockText(block) ?? JSON.stringify(block);
}

/**
 * The whole value, untruncated, since applying takes all of it. Only rich text without a plugin
 * widget is read as blocks: elsewhere an item shaped like a text block can hold more than its text.
 */
function describe(value: unknown, field: PreviewField | undefined): string {
	if (value === null || value === undefined || value === "") return "—";
	if (typeof value === "string") return value;
	try {
		if (field?.kind === "portableText" && !field.widget && Array.isArray(value)) {
			return value.map(describeBlock).join("\n").trim() || "—";
		}
		return JSON.stringify(value) ?? "—";
	} catch {
		return "—";
	}
}

export function EditorDraftPatchPreview({
	operations,
	fields,
	currentValues,
	onApply,
	onClose,
}: EditorDraftPatchPreviewProps) {
	const { t } = useLingui();
	return (
		<LayerDialog.Root
			open
			{...guardUnsavedInput(true, (open) => {
				if (!open) onClose();
			})}
		>
			<LayerDialog.Content size="lg">
				<LayerDialog.Title>{t`Review proposed changes`}</LayerDialog.Title>
				<LayerDialog.Description>
					{t`The plugin has not saved these changes. Review them before updating the editor.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<div className="space-y-3">
						{operations.map((operation) => (
							<div key={operation.field} className="rounded-md border p-3">
								<p className="font-medium">{fields[operation.field]?.label ?? operation.field}</p>
								<dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
									<div className="min-w-0">
										<dt className="text-kumo-subtle">{t`Before`}</dt>
										<dd className="break-words whitespace-pre-wrap" dir="auto">
											{describe(currentValues[operation.field], fields[operation.field])}
										</dd>
									</div>
									<div className="min-w-0">
										<dt className="text-kumo-subtle">{t`After`}</dt>
										<dd className="break-words whitespace-pre-wrap" dir="auto">
											{describe(
												operation.op === "clear" ? null : operation.value,
												fields[operation.field],
											)}
										</dd>
									</div>
								</dl>
							</div>
						))}
					</div>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action onClick={onApply}>{t`Apply changes`}</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}
