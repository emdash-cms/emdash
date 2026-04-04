import { Badge, Button, Checkbox, Input, Label, cn } from "@cloudflare/kumo";
import { ArrowLeft, Database, Pencil, Plus, Trash } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { CreateFieldInput, SchemaField } from "../lib/api";
import type { TaxonomyDef, TaxonomyFieldDef, CreateTaxonomyInput, UpdateTaxonomyInput } from "../lib/api/taxonomies.js";
import { FieldEditor } from "./FieldEditor";

// Regex patterns for name generation (lowercase alphanumeric + underscores)
const NAME_INVALID_CHARS_PATTERN = /[^a-z0-9]+/g;
const NAME_LEADING_TRAILING_PATTERN = /^_|_$/g;

const SUPPORT_OPTIONS = [
	{
		value: "drafts",
		label: "Drafts",
		description: "Save terms as draft before publishing",
	},
	{
		value: "revisions",
		label: "Revisions",
		description: "Track term history",
	},
	{
		value: "preview",
		label: "Preview",
		description: "Preview terms before publishing",
	},
	{
		value: "search",
		label: "Search",
		description: "Enable full-text search on this taxonomy",
	},
];

export interface TaxonomyTypeEditorProps {
	taxonomy?: TaxonomyDef;
	collections?: Array<{ slug: string; label: string }>;
	isNew?: boolean;
	isSaving?: boolean;
	onSave: (input: CreateTaxonomyInput | UpdateTaxonomyInput) => void;
}

// ============================================================================
// Converters between TaxonomyFieldDef and SchemaField / CreateFieldInput
// ============================================================================

function fieldDefToSchemaField(def: TaxonomyFieldDef, index: number): SchemaField {
	return {
		id: `tax-field-${index}`,
		collectionId: "",
		slug: def.name,
		label: def.label,
		type: def.type as SchemaField["type"],
		columnType: "",
		required: def.required ?? false,
		unique: false,
		searchable: false,
		sortOrder: index,
		createdAt: "",
		validation: {
			...def.validation,
			options: def.options?.map((o) => o.value),
		},
	};
}

function schemaFieldToFieldDef(input: CreateFieldInput): TaxonomyFieldDef {
	return {
		name: input.slug,
		label: input.label,
		type: input.type as TaxonomyFieldDef["type"],
		required: input.required || undefined,
		options: input.validation?.options?.map((v) => ({ value: v, label: v })),
		validation: input.validation
			? {
					min: input.validation.min,
					max: input.validation.max,
					minLength: input.validation.minLength,
					maxLength: input.validation.maxLength,
					pattern: input.validation.pattern,
				}
			: undefined,
	};
}

/**
 * Taxonomy Type editor for creating/editing taxonomy definitions.
 */
export function TaxonomyTypeEditor({
	taxonomy,
	collections,
	isNew,
	isSaving,
	onSave,
}: TaxonomyTypeEditorProps) {
	const [label, setLabel] = React.useState(taxonomy?.label ?? "");
	const [name, setName] = React.useState(taxonomy?.name ?? "");
	const [nameManuallyEdited, setNameManuallyEdited] = React.useState(!isNew);
	const [hierarchical, setHierarchical] = React.useState(taxonomy?.hierarchical ?? false);
	const [selectedCollections, setSelectedCollections] = React.useState<string[]>(
		taxonomy?.collections ?? [],
	);
	const [fields, setFields] = React.useState<TaxonomyFieldDef[]>(taxonomy?.fields ?? []);
	const [supports, setSupports] = React.useState<string[]>(taxonomy?.supports ?? []);
	const [hasSeo, setHasSeo] = React.useState(taxonomy?.hasSeo ?? false);

	// Field editor dialog state
	const [fieldEditorOpen, setFieldEditorOpen] = React.useState(false);
	const [editingFieldIndex, setEditingFieldIndex] = React.useState<number | null>(null);

	// Auto-generate name from label (only for new taxonomies)
	React.useEffect(() => {
		if (isNew && !nameManuallyEdited && label) {
			const generated = label
				.toLowerCase()
				.replace(NAME_INVALID_CHARS_PATTERN, "_")
				.replace(NAME_LEADING_TRAILING_PATTERN, "");
			setName(generated);
		}
	}, [label, isNew, nameManuallyEdited]);

	function handleSupportToggle(value: string) {
		setSupports((prev) =>
			prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
		);
	}

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (isNew) {
			onSave({
				name,
				label,
				hierarchical,
				collections: selectedCollections,
				fields: fields.length > 0 ? fields : undefined,
				supports: supports.length > 0 ? supports : undefined,
				hasSeo,
			} satisfies CreateTaxonomyInput);
		} else {
			onSave({
				label,
				hierarchical,
				collections: selectedCollections,
				fields: fields.length > 0 ? fields : undefined,
				supports: supports.length > 0 ? supports : undefined,
				hasSeo,
			} satisfies UpdateTaxonomyInput);
		}
	}

	const handleAddField = () => {
		setEditingFieldIndex(null);
		setFieldEditorOpen(true);
	};

	const handleEditField = (index: number) => {
		setEditingFieldIndex(index);
		setFieldEditorOpen(true);
	};

	const handleFieldSave = (input: CreateFieldInput) => {
		const newDef = schemaFieldToFieldDef(input);
		if (editingFieldIndex !== null) {
			setFields((prev) => prev.map((f, i) => (i === editingFieldIndex ? newDef : f)));
		} else {
			setFields((prev) => [...prev, newDef]);
		}
		setFieldEditorOpen(false);
		setEditingFieldIndex(null);
	};

	const handleDeleteField = (index: number) => {
		setFields((prev) => prev.filter((_, i) => i !== index));
	};

	// Convert the field being edited to SchemaField format for the FieldEditor
	const editingSchemaField: SchemaField | undefined =
		editingFieldIndex !== null && fields[editingFieldIndex]
			? fieldDefToSchemaField(fields[editingFieldIndex], editingFieldIndex)
			: undefined;

	function toggleCollection(slug: string) {
		setSelectedCollections((prev) =>
			prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-3">
				<Link
					to="/taxonomy-types"
					className="inline-flex items-center justify-center rounded-md p-2 hover:bg-kumo-tint"
					aria-label="Back to taxonomy types"
				>
					<ArrowLeft className="h-4 w-4" />
				</Link>
				<div>
					<h1 className="text-2xl font-bold">
						{isNew ? "New Taxonomy Type" : `Edit: ${taxonomy?.label}`}
					</h1>
					<p className="text-kumo-subtle text-sm">
						{isNew
							? "Define a new way to classify your content"
							: "Update taxonomy settings"}
					</p>
				</div>
			</div>

			<form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
				{/* Label */}
				<div className="space-y-2">
					<Label htmlFor="taxonomy-label">Label</Label>
					<Input
						id="taxonomy-label"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="e.g. Categories, Tags, Attributes"
						required
					/>
					<p className="text-xs text-kumo-subtle">
						The display name shown in the admin interface.
					</p>
				</div>

				{/* Name (slug) */}
				<div className="space-y-2">
					<Label htmlFor="taxonomy-name">Name (slug)</Label>
					<Input
						id="taxonomy-name"
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							setNameManuallyEdited(true);
						}}
						placeholder="e.g. category, tag, attribute"
						pattern="^[a-z][a-z0-9_]*$"
						required
						disabled={!isNew}
					/>
					<p className="text-xs text-kumo-subtle">
						{isNew
							? "Lowercase letters, numbers, and underscores. Cannot be changed after creation."
							: "The unique identifier for this taxonomy (read-only)."}
					</p>
				</div>

				{/* Hierarchical */}
				<div className="flex items-start gap-3">
					<Checkbox
						id="taxonomy-hierarchical"
						checked={hierarchical}
						onCheckedChange={(checked) => setHierarchical(checked === true)}
					/>
					<div>
						<Label htmlFor="taxonomy-hierarchical" className="cursor-pointer">
							Hierarchical
						</Label>
						<p className="text-xs text-kumo-subtle">
							Hierarchical taxonomies support parent-child relationships (like
							categories). Flat taxonomies are simple lists (like tags).
						</p>
					</div>
				</div>

				{/* Collections */}
				{collections && collections.length > 0 && (
					<div className="space-y-3">
						<div>
							<Label>Collections</Label>
							<p className="text-xs text-kumo-subtle">
								Select which content types can use this taxonomy. Leave empty to
								make it available to all collections.
							</p>
						</div>
						<div className="space-y-2 rounded-md border p-3">
							{collections.map((col) => (
								<div key={col.slug} className="flex items-center gap-2">
									<Checkbox
										id={`col-${col.slug}`}
										checked={selectedCollections.includes(col.slug)}
										onCheckedChange={() => toggleCollection(col.slug)}
									/>
									<Label htmlFor={`col-${col.slug}`} className="cursor-pointer text-sm">
										{col.label}{" "}
										<code className="text-xs text-kumo-subtle">({col.slug})</code>
									</Label>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Custom Fields */}
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<div>
							<Label>Custom Fields</Label>
							<p className="text-xs text-kumo-subtle">
								Define additional fields that appear when editing terms.
							</p>
						</div>
						<Button type="button" variant="outline" size="sm" icon={<Plus />} onClick={handleAddField}>
							Add Field
						</Button>
					</div>

					{fields.length === 0 ? (
						<div className="rounded-md border p-8 text-center text-kumo-subtle">
							<Database className="mx-auto h-12 w-12 mb-4 opacity-50" />
							<p className="font-medium">No custom fields yet</p>
							<p className="text-sm">Add fields to define the structure of your taxonomy terms</p>
							<Button type="button" className="mt-4" icon={<Plus />} onClick={handleAddField}>
								Add First Field
							</Button>
						</div>
					) : (
						<div className="rounded-md border divide-y">
							{fields.map((field, index) => (
								<div key={index} className="flex items-center px-4 py-3 hover:bg-kumo-tint/25">
									<div className="flex-1 min-w-0">
										<div className="flex items-center space-x-2">
											<span className="font-medium">{field.label}</span>
											<code className="text-xs bg-kumo-tint px-1.5 py-0.5 rounded text-kumo-subtle">
												{field.name}
											</code>
										</div>
										<div className="flex items-center space-x-2 mt-1">
											<span className="text-xs text-kumo-subtle capitalize">{field.type}</span>
											{field.required && <Badge variant="secondary">Required</Badge>}
										</div>
									</div>
									<div className="flex items-center space-x-1">
										<Button
											type="button"
											variant="ghost"
											shape="square"
											onClick={() => handleEditField(index)}
											aria-label={`Edit ${field.label} field`}
										>
											<Pencil className="h-4 w-4" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											shape="square"
											onClick={() => handleDeleteField(index)}
											aria-label={`Delete ${field.label} field`}
										>
											<Trash className="h-4 w-4 text-kumo-danger" />
										</Button>
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				{/* Features */}
				<div className="space-y-3">
					<Label>Features</Label>
					{SUPPORT_OPTIONS.map((option) => (
						<label
							key={option.value}
							className="flex items-start space-x-3 p-2 rounded-md cursor-pointer hover:bg-kumo-tint/50"
						>
							<input
								type="checkbox"
								checked={supports.includes(option.value)}
								onChange={() => handleSupportToggle(option.value)}
								className="mt-1 rounded border-kumo-line"
							/>
							<div>
								<span className="text-sm font-medium">{option.label}</span>
								<p className="text-xs text-kumo-subtle">{option.description}</p>
							</div>
						</label>
					))}
				</div>

				{/* SEO toggle */}
				<div className="pt-2 border-t">
					<label className="flex items-start space-x-3 p-2 rounded-md cursor-pointer hover:bg-kumo-tint/50">
						<input
							type="checkbox"
							checked={hasSeo}
							onChange={() => setHasSeo(!hasSeo)}
							className="mt-1 rounded border-kumo-line"
						/>
						<div>
							<span className="text-sm font-medium">SEO</span>
							<p className="text-xs text-kumo-subtle">
								Add SEO metadata fields (title, description, image) and include in sitemap
							</p>
						</div>
					</label>
				</div>

				{/* Submit */}
				<div className="flex gap-3 pt-2">
					<Button type="submit" disabled={isSaving || !label || !name}>
						{isSaving
							? isNew
								? "Creating..."
								: "Saving..."
							: isNew
								? "Create Taxonomy"
								: "Save Changes"}
					</Button>
					<Link
						to="/taxonomy-types"
						className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm hover:bg-kumo-tint"
					>
						Cancel
					</Link>
				</div>
			</form>

			{/* Field editor dialog */}
			<FieldEditor
				open={fieldEditorOpen}
				onOpenChange={setFieldEditorOpen}
				field={editingSchemaField}
				onSave={handleFieldSave}
			/>
		</div>
	);
}
