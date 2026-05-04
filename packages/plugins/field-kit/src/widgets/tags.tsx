import { Badge, Button } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import * as React from "react";

import type { FieldWidgetProps } from "../shared/types";
import { normalizeTags } from "../shared/utils";

/**
 * Tags widget — free-form chip/tag input for json fields that store string arrays.
 *
 * Seed usage:
 *   {
 *     "slug": "keywords",
 *     "type": "json",
 *     "widget": "field-kit:tags",
 *     "options": {
 *       "placeholder": "Add keyword...",
 *       "max": 10,
 *       "suggestions": ["organic", "seasonal", "dried"],
 *       "allowCustom": true,
 *       "transform": "lowercase"
 *     }
 *   }
 *
 * Stored value: ["organic", "seasonal"]
 */
export function Tags({ value, onChange, label, id, required, options, minimal }: FieldWidgetProps) {
	const placeholder = (options?.placeholder as string | undefined) ?? "Add...";
	const max = options?.max as number | undefined;
	const suggestions = (options?.suggestions as string[] | undefined) ?? [];
	const allowCustom = (options?.allowCustom as boolean | undefined) ?? true;
	const transform = (options?.transform as string | undefined) ?? "none";
	const helpText = options?.helpText as string | undefined;

	const tags = normalizeTags(value);
	const tagsRef = React.useRef(tags);
	tagsRef.current = tags;

	const [input, setInput] = React.useState("");
	const datalistId = `${id}-suggestions`;
	const atLimit = max !== undefined && tags.length >= max;

	const applyTransform = React.useCallback(
		(val: string): string => {
			const trimmed = val.trim();
			switch (transform) {
				case "lowercase":
					return trimmed.toLowerCase();
				case "uppercase":
					return trimmed.toUpperCase();
				case "trim":
					return trimmed;
				default:
					return trimmed;
			}
		},
		[transform],
	);

	const addTag = React.useCallback(
		(raw: string) => {
			const tag = applyTransform(raw);
			if (!tag) return;
			if (tagsRef.current.includes(tag)) return;
			if (!allowCustom && !suggestions.includes(tag)) return;
			if (max !== undefined && tagsRef.current.length >= max) return;
			onChange([...tagsRef.current, tag]);
			setInput("");
		},
		[onChange, applyTransform, allowCustom, suggestions, max],
	);

	const removeTag = React.useCallback(
		(index: number) => {
			const next = [...tagsRef.current];
			next.splice(index, 1);
			onChange(next);
		},
		[onChange],
	);

	const handleKeyDown = React.useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter" || e.key === ",") {
				e.preventDefault();
				addTag(input);
			}
			if (e.key === "Backspace" && input === "" && tagsRef.current.length > 0) {
				removeTag(tagsRef.current.length - 1);
			}
		},
		[input, addTag, removeTag],
	);

	return (
		<div>
			{!minimal && (
				<label htmlFor={id} className="mb-1.5 block text-sm font-medium text-kumo-default">
					{label}
					{required && <span className="ml-0.5 text-kumo-danger">*</span>}
				</label>
			)}

			<div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md bg-kumo-base p-1.5 ring ring-kumo-hairline focus-within:ring-kumo-hairline">
				{tags.map((tag, i) => (
					<span key={`${tag}-${i}`} className="inline-flex items-center gap-1">
						<Badge variant="secondary">
							<span className="mr-1">{tag}</span>
							<Button
								variant="ghost"
								shape="circle"
								size="xs"
								aria-label={`Remove ${tag}`}
								onClick={() => removeTag(i)}
								icon={<X />}
							/>
						</Badge>
					</span>
				))}

				{!atLimit && (
					<input
						id={id}
						type="text"
						aria-label={label}
						className="min-w-32 flex-1 border-none bg-transparent p-1 text-sm text-kumo-default outline-none placeholder:text-kumo-subtle"
						value={input}
						placeholder={tags.length === 0 ? placeholder : ""}
						list={suggestions.length > 0 ? datalistId : undefined}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						onBlur={() => {
							if (input.trim()) addTag(input);
						}}
					/>
				)}
			</div>

			{suggestions.length > 0 && (
				<datalist id={datalistId}>
					{suggestions
						.filter((s) => !tags.includes(s))
						.map((s) => (
							<option key={s} value={s} />
						))}
				</datalist>
			)}

			{helpText && <p className="mt-1.5 text-xs text-kumo-subtle">{helpText}</p>}

			{max !== undefined && (
				<p className="mt-1 text-xs text-kumo-subtle">
					{tags.length}/{max}
				</p>
			)}
		</div>
	);
}
