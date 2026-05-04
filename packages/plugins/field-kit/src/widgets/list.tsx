import { Button } from "@cloudflare/kumo";
import { CaretRight, CaretUp, CaretDown, Plus, X } from "@phosphor-icons/react";
import * as React from "react";

import { SubField } from "../shared/sub-field";
import type { FieldWidgetProps, SubFieldDef } from "../shared/types";
import { normalizeArray, normalizeObject, renderSummary } from "../shared/utils";

/**
 * List widget — ordered array editor with add/remove/reorder for json fields.
 *
 * Seed usage:
 *   {
 *     "slug": "ingredients",
 *     "type": "json",
 *     "widget": "field-kit:list",
 *     "options": {
 *       "itemLabel": "Ingredient",
 *       "min": 1,
 *       "max": 50,
 *       "sortable": true,
 *       "summary": "{{name}} — {{amount}}",
 *       "fields": [
 *         { "key": "name", "label": "Name", "type": "text" },
 *         { "key": "amount", "label": "Amount", "type": "text" },
 *         { "key": "optional", "label": "Optional", "type": "boolean" }
 *       ]
 *     }
 *   }
 *
 * Stored value: [{ "name": "Flour", "amount": "500g", "optional": false }, ...]
 */
function makeItemId(): string {
	// `crypto.randomUUID` is available in all modern browsers and in Node ≥ 14.17.
	// This id is a React-key concern only and never persisted to the stored JSON.
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `item-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function List({ value, onChange, label, id, required, options, minimal }: FieldWidgetProps) {
	const fields = (options?.fields as SubFieldDef[] | undefined) ?? [];
	const itemLabel = (options?.itemLabel as string | undefined) ?? "Item";
	const min = options?.min as number | undefined;
	const max = options?.max as number | undefined;
	const sortable = (options?.sortable as boolean | undefined) ?? true;
	const summaryTemplate = options?.summary as string | undefined;
	const helpText = options?.helpText as string | undefined;

	const items = normalizeArray(value).map((item) => normalizeObject(item, fields));
	const itemsRef = React.useRef(items);
	itemsRef.current = items;

	// Parallel stable-key array, kept in lockstep with `items`. Regenerated
	// only when the externally-supplied value length changes unexpectedly
	// (e.g. reset from outside); local add/remove/reorder splice this array
	// alongside items so each row keeps the same key across moves.
	const [itemIds, setItemIds] = React.useState<string[]>(() => items.map(() => makeItemId()));
	const itemIdsRef = React.useRef(itemIds);
	itemIdsRef.current = itemIds;

	React.useEffect(() => {
		if (itemIdsRef.current.length !== items.length) {
			setItemIds((prev) => {
				if (prev.length === items.length) return prev;
				if (prev.length < items.length) {
					const added: string[] = [];
					for (let i = prev.length; i < items.length; i++) added.push(makeItemId());
					return [...prev, ...added];
				}
				return prev.slice(0, items.length);
			});
		}
	}, [items.length]);

	const [expandedIndex, setExpandedIndex] = React.useState<number | null>(
		items.length === 0 ? null : 0,
	);
	const expandedRef = React.useRef(expandedIndex);
	expandedRef.current = expandedIndex;

	const canAdd = max === undefined || items.length < max;
	const canRemove = min === undefined || items.length > min;

	const updateItems = React.useCallback(
		(next: Record<string, unknown>[]) => {
			onChange(next);
		},
		[onChange],
	);

	const addItem = React.useCallback(() => {
		const newItem = normalizeObject(undefined, fields);
		const next = [...itemsRef.current, newItem];
		setItemIds([...itemIdsRef.current, makeItemId()]);
		updateItems(next);
		setExpandedIndex(next.length - 1);
	}, [fields, updateItems]);

	const removeItem = React.useCallback(
		(index: number) => {
			const next = [...itemsRef.current];
			next.splice(index, 1);
			const nextIds = [...itemIdsRef.current];
			nextIds.splice(index, 1);
			setItemIds(nextIds);
			updateItems(next);
			const exp = expandedRef.current;
			if (exp === index) {
				setExpandedIndex(null);
			} else if (exp !== null && exp > index) {
				setExpandedIndex(exp - 1);
			}
		},
		[updateItems],
	);

	const moveItem = React.useCallback(
		(index: number, direction: -1 | 1) => {
			const target = index + direction;
			if (target < 0 || target >= itemsRef.current.length) return;
			const next = [...itemsRef.current];
			const a = next[index];
			const b = next[target];
			if (!a || !b) return;
			next[index] = b;
			next[target] = a;
			const nextIds = [...itemIdsRef.current];
			const idA = nextIds[index];
			const idB = nextIds[target];
			if (idA !== undefined && idB !== undefined) {
				nextIds[index] = idB;
				nextIds[target] = idA;
				setItemIds(nextIds);
			}
			updateItems(next);
			const exp = expandedRef.current;
			if (exp === index) {
				setExpandedIndex(target);
			} else if (exp === target) {
				setExpandedIndex(index);
			}
		},
		[updateItems],
	);

	const updateField = React.useCallback(
		(itemIndex: number, key: string, fieldValue: unknown) => {
			const next = itemsRef.current.map((item, i) =>
				i === itemIndex ? { ...item, [key]: fieldValue } : item,
			);
			updateItems(next);
		},
		[updateItems],
	);

	const getSummary = React.useCallback(
		(item: Record<string, unknown>, index: number): string => {
			if (summaryTemplate) {
				const rendered = renderSummary(summaryTemplate, item).trim();
				if (rendered) return rendered;
			}
			return `${itemLabel} ${index + 1}`;
		},
		[summaryTemplate, itemLabel],
	);

	if (fields.length === 0) {
		return (
			<div>
				{!minimal && (
					<label className="mb-1.5 block text-sm font-medium text-kumo-default">
						{label}
						{required && <span className="ml-0.5 text-kumo-danger">*</span>}
					</label>
				)}
				<div className="rounded-md bg-kumo-danger-tint/60 p-3 text-sm text-kumo-danger">
					<p className="font-medium">Widget misconfigured</p>
					<p className="mt-1 opacity-80">
						The field's <code>options.fields</code> array is empty or missing. Define sub-fields in
						your seed file to use this widget.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div>
			{!minimal && (
				<label className="mb-1.5 block text-sm font-medium text-kumo-default">
					{label}
					{required && <span className="ml-0.5 text-kumo-danger">*</span>}
					<span className="ml-1.5 text-xs font-normal text-kumo-subtle">
						({items.length}
						{max !== undefined ? `/${max}` : ""})
					</span>
				</label>
			)}

			<div className="rounded-md ring ring-kumo-hairline">
				{items.length === 0 && (
					<div className="p-3 text-center text-sm text-kumo-subtle">No items yet</div>
				)}

				{items.map((item, index) => {
					const isExpanded = expandedIndex === index;
					const rowKey = itemIds[index] ?? `fallback-${index}`;
					return (
						<div
							key={rowKey}
							className={`border-b border-kumo-hairline last:border-b-0 ${
								isExpanded ? "bg-kumo-tint" : ""
							}`}
						>
							<div className="flex items-center gap-1 px-2 py-1.5">
								<Button
									variant="ghost"
									size="sm"
									className="flex-1 justify-start"
									onClick={() => setExpandedIndex(isExpanded ? null : index)}
									icon={
										<CaretRight
											style={{
												transform: isExpanded ? "rotate(90deg)" : undefined,
												transition: "transform 150ms ease",
											}}
										/>
									}
								>
									<span className={isExpanded ? "font-medium" : ""}>{getSummary(item, index)}</span>
								</Button>

								{sortable && (
									<>
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											disabled={index === 0}
											onClick={(e) => {
												e.stopPropagation();
												moveItem(index, -1);
											}}
											aria-label="Move up"
											title="Move up"
											icon={<CaretUp />}
										/>
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											disabled={index === items.length - 1}
											onClick={(e) => {
												e.stopPropagation();
												moveItem(index, 1);
											}}
											aria-label="Move down"
											title="Move down"
											icon={<CaretDown />}
										/>
									</>
								)}

								{canRemove && (
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										onClick={(e) => {
											e.stopPropagation();
											removeItem(index);
										}}
										aria-label={`Remove ${itemLabel} ${index + 1}`}
										title="Remove"
										icon={<X />}
									/>
								)}
							</div>

							{isExpanded && (
								<div className="space-y-3 border-t border-kumo-hairline px-3 pb-3 pt-2">
									{fields.map((field) => (
										<SubField
											key={field.key}
											id={`${id}-${rowKey}-${field.key}`}
											def={field}
											value={item[field.key]}
											onChange={(v) => updateField(index, field.key, v)}
										/>
									))}
								</div>
							)}
						</div>
					);
				})}
			</div>

			{canAdd && (
				<Button variant="outline" size="sm" className="mt-2" onClick={addItem} icon={<Plus />}>
					Add {itemLabel}
				</Button>
			)}

			{helpText && <p className="mt-1.5 text-xs text-kumo-subtle">{helpText}</p>}
		</div>
	);
}
