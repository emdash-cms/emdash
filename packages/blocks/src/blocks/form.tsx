import { Button } from "@cloudflare/kumo";
import { useCallback, useState } from "react";

import { renderElement } from "../render-element.js";
import type { BlockInteraction, FieldCondition, FormBlock, FormField } from "../types.js";

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	return false;
}

function evaluateCondition(condition: FieldCondition, values: Record<string, unknown>): boolean {
	const fieldValue = values[condition.field];
	if ("eq" in condition && condition.eq !== undefined) {
		return deepEqual(fieldValue, condition.eq);
	}
	if ("neq" in condition && condition.neq !== undefined) {
		return !deepEqual(fieldValue, condition.neq);
	}
	return true;
}

function getInitialValues(fields: FormField[]): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of fields) {
		if ("initial_value" in field && field.initial_value !== undefined) {
			values[field.action_id] = field.initial_value;
		}
	}
	return values;
}

export function FormBlockComponent({
	block,
	onAction,
}: {
	block: FormBlock;
	onAction: (interaction: BlockInteraction) => void;
}) {
	const [values, setValues] = useState<Record<string, unknown>>(() =>
		getInitialValues(block.fields),
	);

	const handleChange = useCallback((actionId: string, value: unknown) => {
		setValues((prev) => ({ ...prev, [actionId]: value }));
	}, []);

	function submit() {
		onAction({
			type: "form_submit",
			action_id: block.submit.action_id,
			block_id: block.block_id,
			values,
		});
	}

	// Submit from the button's click so no native submit event is dispatched. Plugin editor
	// panels render inside the content editor's form, and Chromium stops a nested form's
	// `submit` from bubbling past the outer form, so React's onSubmit never runs and the
	// browser reloads the editor. Pressing Enter in a single-line input clicks this button
	// too. Preventing the click also skips the browser's validation, so run it here.
	function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
		e.preventDefault();
		const form = e.currentTarget.form;
		if (form && !form.reportValidity()) return;
		submit();
	}

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		submit();
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			{block.fields.map((field) => {
				if (field.condition && !evaluateCondition(field.condition, values)) {
					return null;
				}
				return <div key={field.action_id}>{renderElement(field, onAction, handleChange)}</div>;
			})}
			<div>
				<Button type="submit" onClick={handleClick}>
					{block.submit.label}
				</Button>
			</div>
		</form>
	);
}
