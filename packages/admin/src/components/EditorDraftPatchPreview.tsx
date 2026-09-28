import { Button, Dialog } from "@cloudflare/kumo";
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
		<Dialog.Root open onOpenChange={(open) => !open && onClose()} disablePointerDismissal>
			<Dialog className="max-w-2xl p-6" size="sm">
				<Dialog.Title className="text-lg font-semibold">{t`Review proposed changes`}</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle">
					{t`The plugin has not saved these changes. Review them before updating the editor.`}
				</Dialog.Description>
				<div className="mt-4 max-h-96 space-y-3 overflow-y-auto">
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
				<div className="mt-6 flex justify-end gap-2">
					<Button type="button" variant="secondary" onClick={onClose}>
						{t`Cancel`}
					</Button>
					<Button type="button" variant="primary" onClick={onApply}>
						{t`Apply changes`}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
