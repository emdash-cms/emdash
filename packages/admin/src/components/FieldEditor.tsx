import { Button, Dialog, Input, InputArea } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	TextT,
	TextAlignLeft,
	Hash,
	ToggleLeft,
	Calendar,
	List,
	ListChecks,
	FileText,
	Image as ImageIcon,
	File,
	LinkSimple,
	BracketsCurly,
	Link,
} from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import * as React from "react";

import type { FieldType, CreateFieldInput, SchemaField } from "../lib/api";
import { cn } from "../lib/utils";

// ============================================================================
// Constants
// ============================================================================

const SLUG_INVALID_CHARS_REGEX = /[^a-z0-9]+/g;
const SLUG_LEADING_TRAILING_REGEX = /^_|_$/g;

// ============================================================================
// Types
// ============================================================================

export interface FieldEditorProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	field?: SchemaField;
	onSave: (input: CreateFieldInput) => void;
	isSaving?: boolean;
}

interface FieldFormState {
	step: "type" | "config";
	selectedType: FieldType | null;
	slug: string;
	label: string;
	required: boolean;
	unique: boolean;
	searchable: boolean;
	minLength: string;
	maxLength: string;
	min: string;
	max: string;
	pattern: string;
	options: string;
}

function getInitialFormState(field?: SchemaField): FieldFormState {
	if (field) {
		return {
			step: "config",
			selectedType: field.type,
			slug: field.slug,
			label: field.label,
			required: field.required,
			unique: field.unique,
			searchable: field.searchable,
			minLength: field.validation?.minLength?.toString() ?? "",
			maxLength: field.validation?.maxLength?.toString() ?? "",
			min: field.validation?.min?.toString() ?? "",
			max: field.validation?.max?.toString() ?? "",
			pattern: field.validation?.pattern ?? "",
			options: field.validation?.options?.join("\n") ?? "",
		};
	}
	return {
		step: "type",
		selectedType: null,
		slug: "",
		label: "",
		required: false,
		unique: false,
		searchable: false,
		minLength: "",
		maxLength: "",
		min: "",
		max: "",
		pattern: "",
		options: "",
	};
}

/**
 * Field editor dialog for creating/editing fields
 */
export function FieldEditor({ open, onOpenChange, field, onSave, isSaving }: FieldEditorProps) {
	const { t } = useLingui();
	const FIELD_TYPES = React.useMemo(
		/* prettier-ignore */
		() => [
			{ type: "string" as const, label: t`Short Text`, description: t`Single line text input`, icon: TextT },
			{ type: "text" as const, label: t`Long Text`, description: t`Multi-line plain text`, icon: TextAlignLeft },
			{ type: "number" as const, label: t`Number`, description: t`Decimal number`, icon: Hash },
			{ type: "integer" as const, label: t`Integer`, description: t`Whole number`, icon: Hash },
			{ type: "boolean" as const, label: t`Boolean`, description: t`True/false toggle`, icon: ToggleLeft },
			{ type: "datetime" as const, label: t`Date & Time`, description: t`Date and time picker`, icon: Calendar },
			{ type: "select" as const, label: t`Select`, description: t`Single choice from options`, icon: List },
			{ type: "multiSelect" as const, label: t`Multi Select`, description: t`Multiple choices from options`, icon: ListChecks },
			{ type: "portableText" as const, label: t`Rich Text`, description: t`Rich text editor`, icon: FileText },
			{ type: "image" as const, label: t`Image`, description: t`Image from media library`, icon: ImageIcon },
			{ type: "file" as const, label: t`File`, description: t`File from media library`, icon: File },
			{ type: "reference" as const, label: t`Reference`, description: t`Link to another content item`, icon: LinkSimple },
			{ type: "json" as const, label: "JSON", description: t`Arbitrary JSON data`, icon: BracketsCurly },
			{ type: "slug" as const, label: t`Slug`, description: t`URL-friendly identifier`, icon: Link },
		],
		[t],
	);
	const [formState, setFormState] = React.useState(() => getInitialFormState(field));

	// Reset state when dialog opens
	React.useEffect(() => {
		if (open) {
			setFormState(getInitialFormState(field));
		}
	}, [open, field]);

	const { step, selectedType, slug, label, required, unique, searchable } = formState;
	const { minLength, maxLength, min, max, pattern, options } = formState;
	const setField = <K extends keyof FieldFormState>(key: K, value: FieldFormState[K]) =>
		setFormState((prev) => ({ ...prev, [key]: value }));

	// Auto-generate slug from label
	const handleLabelChange = (value: string) => {
		setField("label", value);
		if (!field) {
			// Only auto-generate for new fields
			setField(
				"slug",
				value
					.toLowerCase()
					.replace(SLUG_INVALID_CHARS_REGEX, "_")
					.replace(SLUG_LEADING_TRAILING_REGEX, ""),
			);
		}
	};

	const handleTypeSelect = (type: FieldType) => {
		setFormState((prev) => ({ ...prev, selectedType: type, step: "config" }));
	};

	const handleSave = () => {
		if (!selectedType || !slug || !label) return;

		const validation: CreateFieldInput["validation"] = {};

		// Build validation based on field type
		if (selectedType === "string" || selectedType === "text" || selectedType === "slug") {
			if (minLength) validation.minLength = parseInt(minLength, 10);
			if (maxLength) validation.maxLength = parseInt(maxLength, 10);
			if (pattern) validation.pattern = pattern;
		}

		if (selectedType === "number" || selectedType === "integer") {
			if (min) validation.min = parseFloat(min);
			if (max) validation.max = parseFloat(max);
		}

		if (selectedType === "select" || selectedType === "multiSelect") {
			const optionList = options
				.split("\n")
				.map((o) => o.trim())
				.filter(Boolean);
			if (optionList.length > 0) {
				validation.options = optionList;
			}
		}

		// Only include searchable for text-based fields
		const isSearchableType =
			selectedType === "string" ||
			selectedType === "text" ||
			selectedType === "portableText" ||
			selectedType === "slug";

		const input: CreateFieldInput = {
			slug,
			label,
			type: selectedType,
			required,
			unique,
			searchable: isSearchableType ? searchable : undefined,
			validation: Object.keys(validation).length > 0 ? validation : undefined,
		};

		onSave(input);
	};

	const typeConfig = FIELD_TYPES.find((ft) => ft.type === selectedType);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog className="p-6 max-w-2xl" size="lg">
				<div className="flex items-start justify-between gap-4 mb-4">
					<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
						{field ? t`Edit Field` : step === "type" ? t`Add Field` : t`Configure Field`}
					</Dialog.Title>
					<Dialog.Close
						aria-label={t`Close`}
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label={t`Close`}
								className="absolute right-4 top-4"
							>
								<X className="h-4 w-4" />
								<span className="sr-only">{t`Close`}</span>
							</Button>
						)}
					/>
				</div>

				{step === "type" ? (
					<div className="grid grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto">
						{FIELD_TYPES.map((ft) => {
							const Icon = ft.icon;
							return (
								<button
									key={ft.type}
									type="button"
									onClick={() => handleTypeSelect(ft.type)}
									className={cn(
										"flex items-start space-x-3 p-4 rounded-lg border text-left transition-colors hover:border-kumo-brand hover:bg-kumo-tint/50",
									)}
								>
									<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-kumo-tint">
										<Icon className="h-5 w-5" />
									</div>
									<div>
										<p className="font-medium">{ft.label}</p>
										<p className="text-sm text-kumo-subtle">{ft.description}</p>
									</div>
								</button>
							);
						})}
					</div>
				) : (
					<div className="space-y-6">
						{/* Type indicator */}
						{typeConfig && (
							<div className="flex items-center space-x-3 p-3 bg-kumo-tint/50 rounded-lg">
								<typeConfig.icon className="h-5 w-5" />
								<div>
									<p className="font-medium">{typeConfig.label}</p>
									<p className="text-sm text-kumo-subtle">{typeConfig.description}</p>
								</div>
								{!field && (
									<Button
										variant="ghost"
										size="sm"
										className="ml-auto"
										onClick={() => setField("step", "type")}
									>
										{t`Change`}
									</Button>
								)}
							</div>
						)}

						{/* Basic info */}
						<div className="grid grid-cols-2 gap-4">
							<Input
								label={t`Label`}
								value={label}
								onChange={(e) => handleLabelChange(e.target.value)}
								placeholder={t`Field Label`}
							/>
							<div>
								<Input
									label={t`Slug`}
									value={slug}
									onChange={(e) => setField("slug", e.target.value)}
									placeholder="field_slug"
									disabled={!!field}
								/>
								{field && (
									<p className="text-xs text-kumo-subtle mt-2">
										{t`Field slugs cannot be changed after creation`}
									</p>
								)}
							</div>
						</div>

						{/* Toggles */}
						<div className="flex items-center space-x-6">
							<label className="flex items-center space-x-2">
								<input
									type="checkbox"
									checked={required}
									onChange={(e) => setField("required", e.target.checked)}
									className="rounded border-kumo-line"
								/>
								<span className="text-sm">{t`Required`}</span>
							</label>
							<label className="flex items-center space-x-2">
								<input
									type="checkbox"
									checked={unique}
									onChange={(e) => setField("unique", e.target.checked)}
									className="rounded border-kumo-line"
								/>
								<span className="text-sm">{t`Unique`}</span>
							</label>
							{(selectedType === "string" ||
								selectedType === "text" ||
								selectedType === "portableText" ||
								selectedType === "slug") && (
								<label className="flex items-center space-x-2">
									<input
										type="checkbox"
										checked={searchable}
										onChange={(e) => setField("searchable", e.target.checked)}
										className="rounded border-kumo-line"
									/>
									<span className="text-sm">{t`Searchable`}</span>
								</label>
							)}
						</div>

						{/* Type-specific validation */}
						{(selectedType === "string" || selectedType === "text" || selectedType === "slug") && (
							<div className="space-y-4">
								<h4 className="font-medium text-sm">{t`Validation`}</h4>
								<div className="grid grid-cols-2 gap-4">
									<Input
										label={t`Min Length`}
										type="number"
										value={minLength}
										onChange={(e) => setField("minLength", e.target.value)}
										placeholder={t`No minimum`}
									/>
									<Input
										label={t`Max Length`}
										type="number"
										value={maxLength}
										onChange={(e) => setField("maxLength", e.target.value)}
										placeholder={t`No maximum`}
									/>
								</div>
								{selectedType === "string" && (
									<Input
										label={t`Pattern (Regex)`}
										value={pattern}
										onChange={(e) => setField("pattern", e.target.value)}
										placeholder="^[a-z]+$"
									/>
								)}
							</div>
						)}

						{(selectedType === "number" || selectedType === "integer") && (
							<div className="space-y-4">
								<h4 className="font-medium text-sm">{t`Validation`}</h4>
								<div className="grid grid-cols-2 gap-4">
									<Input
										label={t`Min Value`}
										type="number"
										value={min}
										onChange={(e) => setField("min", e.target.value)}
										placeholder={t`No minimum`}
									/>
									<Input
										label={t`Max Value`}
										type="number"
										value={max}
										onChange={(e) => setField("max", e.target.value)}
										placeholder={t`No maximum`}
									/>
								</div>
							</div>
						)}

						{(selectedType === "select" || selectedType === "multiSelect") && (
							<InputArea
								label={t`Options (one per line)`}
								value={options}
								onChange={(e) => setField("options", e.target.value)}
								placeholder={"Option 1\nOption 2\nOption 3"}
								rows={5}
							/>
						)}
					</div>
				)}

				{step === "config" && (
					<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
						<Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
							{t`Cancel`}
						</Button>
						<Button onClick={handleSave} disabled={!slug || !label || isSaving}>
							{isSaving ? t`Saving...` : field ? t`Update Field` : t`Add Field`}
						</Button>
					</div>
				)}
			</Dialog>
		</Dialog.Root>
	);
}
