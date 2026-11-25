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

function spanText(child: unknown): string | null {
	if (typeof child !== "object" || child === null) return null;
	if (!("_type" in child) || child._type !== "span") return null;
	return "text" in child && typeof child.text === "string" ? child.text : null;
}

/**
 * One rich-text block on one line. A text block reads as its text followed by the JSON of what
 * the text doesn't show: inline objects and the mark definitions that hold link targets. Any
 * other block is its JSON.
 */
function describeBlock(block: unknown): string {
	if (typeof block !== "object" || block === null) return JSON.stringify(block);
	if (!("_type" in block) || block._type !== "block") return JSON.stringify(block);
	if (!("children" in block) || !Array.isArray(block.children)) return JSON.stringify(block);
	const markDefs: unknown = "markDefs" in block ? block.markDefs : [];
	if (!Array.isArray(markDefs)) return JSON.stringify(block);
	let text = "";
	const rest: unknown[] = [];
	for (const child of block.children) {
		const span = spanText(child);
		if (span === null) rest.push(child);
		else text += span;
	}
	rest.push(...markDefs);
	return [text, ...rest.map((part) => JSON.stringify(part))].join(" ");
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
