import { Button, Input, Switch } from "@cloudflare/kumo";
import type { Element } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { Image as ImageIcon, X } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../lib/api";
import { MediaPickerModal } from "./MediaPickerModal";

interface BlockKitFieldWidgetProps {
	label: string;
	elements: Element[];
	value: unknown;
	onChange: (value: unknown) => void;
}

/**
 * Renders Block Kit elements as a field widget for sandboxed plugins.
 * Decomposes a JSON value into per-element values keyed by action_id,
 * and recomposes on change.
 */
export function BlockKitFieldWidget({
	label,
	elements,
	value,
	onChange,
}: BlockKitFieldWidgetProps) {
	const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;

	// Use a ref to avoid stale closure -- rapid changes to different elements
	// would otherwise lose updates because each callback spreads from a stale obj.
	const objRef = React.useRef(obj);
	objRef.current = obj;

	const handleElementChange = React.useCallback(
		(actionId: string, elementValue: unknown) => {
			onChange({ ...objRef.current, [actionId]: elementValue });
		},
		[onChange],
	);

	// Filter out elements without action_id -- they can't be mapped to values
	const validElements = elements.filter((el) => el.action_id);

	return (
		<div>
			<span className="text-sm font-medium leading-none">{label}</span>
			<div className="mt-2 space-y-3">
				{validElements.map((el) => (
					<BlockKitFieldElement
						key={el.action_id}
						element={el}
						value={obj[el.action_id]}
						onChange={handleElementChange}
					/>
				))}
			</div>
		</div>
	);
}

function BlockKitFieldElement({
	element,
	value,
	onChange,
}: {
	element: Element;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
}) {
	switch (element.type) {
		case "text_input":
			return (
				<Input
					label={element.label}
					placeholder={element.placeholder}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(element.action_id, e.target.value)}
				/>
			);
		case "number_input":
			return (
				<Input
					label={element.label}
					type="number"
					value={typeof value === "number" ? String(value) : ""}
					onChange={(e) => {
						const n = Number(e.target.value);
						onChange(element.action_id, e.target.value && Number.isFinite(n) ? n : undefined);
					}}
				/>
			);
		case "toggle":
			return (
				<Switch
					label={element.label}
					checked={!!value}
					onCheckedChange={(checked) => onChange(element.action_id, checked)}
				/>
			);
		case "select": {
			const options = Array.isArray(element.options) ? element.options : [];
			return (
				<div>
					<label className="text-sm font-medium mb-1.5 block">{element.label}</label>
					<select
						className="flex w-full rounded-md border border-kumo-line bg-transparent px-3 py-2 text-sm"
						value={typeof value === "string" ? value : ""}
						onChange={(e) => onChange(element.action_id, e.target.value)}
					>
						<option value="">Select...</option>
						{options.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</div>
			);
		}
		case "media_picker":
			return <MediaPickerWidget element={element} value={value} onChange={onChange} />;
		default:
			return (
				<div className="text-sm text-kumo-subtle">
					Unsupported widget element type: {(element as { type: string }).type}
				</div>
			);
	}
}

function MediaPickerWidget({
	element,
	value,
	onChange,
}: {
	element: Extract<Element, { type: "media_picker" }>;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
}) {
	const { t } = useLingui();
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const url = typeof value === "string" && value.length > 0 ? value : "";
	const mimeTypeFilter = element.mime_type_filter ?? "image/";

	const handleSelect = (item: MediaItem) => {
		const isLocalProvider = !item.provider || item.provider === "local";
		const nextUrl = isLocalProvider
			? `/_emdash/api/media/file/${item.storageKey || item.id}`
			: item.url;
		onChange(element.action_id, nextUrl);
	};

	return (
		<div>
			<label className="text-sm font-medium mb-1.5 block">{element.label}</label>
			{url ? (
				<div className="relative group">
					<img
						src={url}
						alt=""
						className="max-h-40 w-full rounded-md border border-kumo-line object-contain bg-kumo-muted"
					/>
					<div className="absolute top-2 end-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
						<Button type="button" size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
							{t`Change`}
						</Button>
						<Button
							type="button"
							shape="square"
							variant="destructive"
							className="h-8 w-8"
							onClick={() => onChange(element.action_id, "")}
							aria-label={t`Remove`}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				</div>
			) : (
				<Button
					type="button"
					variant="outline"
					className="w-full h-24 border-dashed"
					onClick={() => setPickerOpen(true)}
				>
					<div className="flex flex-col items-center gap-1.5 text-kumo-subtle">
						<ImageIcon className="h-6 w-6" />
						<span className="text-sm">{element.placeholder ?? t`Select media`}</span>
					</div>
				</Button>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilter={mimeTypeFilter}
				title={t`Select ${element.label}`}
			/>
		</div>
	);
}
