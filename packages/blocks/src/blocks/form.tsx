import { Button } from "@cloudflare/kumo";
import { useCallback, useRef, useState } from "react";

import { FormOwnerContext } from "../form-context.js";
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
	const container = useRef<HTMLDivElement>(null);
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

	function validate() {
		const controls = container.current?.querySelectorAll<
			HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
		>("input, select, textarea");
		return controls ? [...controls].every((control) => control.reportValidity()) : false;
	}

	function handleClick() {
		if (validate()) submit();
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
		// Leave multiline editing, IME confirmation and combobox selection to the control.
		const input = e.target;
		if (
			e.key !== "Enter" ||
			e.defaultPrevented ||
			e.nativeEvent.isComposing ||
			e.nativeEvent.keyCode === 229 ||
			!(input instanceof HTMLInputElement) ||
			input.getAttribute("role") === "combobox" ||
			!["text", "number", "email", "url", "password", "search", "tel", "date"].includes(input.type)
		)
			return;
		e.preventDefault();
		e.stopPropagation();
		if (validate()) submit();
	}

	return (
		<FormOwnerContext.Provider value="">
			<div
				ref={container}
				role="group"
				aria-label={block.submit.label}
				onKeyDown={handleKeyDown}
				className="flex flex-col gap-4"
			>
				{block.fields.map((field) => {
					if (field.condition && !evaluateCondition(field.condition, values)) {
						return null;
					}
					return <div key={field.action_id}>{renderElement(field, onAction, handleChange)}</div>;
				})}
				<div>
					<Button type="button" onClick={handleClick}>
						{block.submit.label}
					</Button>
				</div>
			</div>
		</FormOwnerContext.Provider>
	);
}
