import { LayerDialog } from "@cloudflare/kumo";
import type { EditorDraftPatchOperation } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

interface EditorDraftPatchPreviewProps {
	operations: EditorDraftPatchOperation[];
	fields: Record<string, { label?: string }>;
	currentValues: Record<string, unknown>;
	onApply: () => void;
	onClose: () => void;
}

function collectText(value: unknown, output: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectText(item, output);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	if ("text" in value && typeof value.text === "string") output.push(value.text);
	if ("children" in value) collectText(value.children, output);
}

function summarize(value: unknown): string {
	if (value === null || value === undefined || value === "") return "—";
	if (Array.isArray(value)) {
		const text: string[] = [];
		collectText(value, text);
		if (text.length > 0) return summarize(text.join(" "));
	}
	let rendered: string;
	try {
		rendered = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return "—";
	}
	return rendered.length > 160 ? `${rendered.slice(0, 157)}…` : rendered;
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
			onOpenChange={(open, details) => {
				// Like a press outside, a swipe down on the phone sheet must not discard the changes.
				if (!open && details.reason === "swipe") {
					details.cancel();
					return;
				}
				if (!open) onClose();
			}}
			disablePointerDismissal
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
										<dd className="break-words" dir="auto">
											{summarize(currentValues[operation.field])}
										</dd>
									</div>
									<div className="min-w-0">
										<dt className="text-kumo-subtle">{t`After`}</dt>
										<dd className="break-words" dir="auto">
											{summarize(operation.op === "clear" ? null : operation.value)}
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
