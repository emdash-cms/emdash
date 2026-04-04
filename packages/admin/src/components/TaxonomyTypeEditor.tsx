import { Button, Checkbox, Input, Label } from "@cloudflare/kumo";
import { ArrowLeft } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { TaxonomyDef, CreateTaxonomyInput, UpdateTaxonomyInput } from "../lib/api/taxonomies.js";

// Regex patterns for name generation (lowercase alphanumeric + underscores)
const NAME_INVALID_CHARS_PATTERN = /[^a-z0-9]+/g;
const NAME_LEADING_TRAILING_PATTERN = /^_|_$/g;

export interface TaxonomyTypeEditorProps {
	taxonomy?: TaxonomyDef;
	collections?: Array<{ slug: string; label: string }>;
	isNew?: boolean;
	isSaving?: boolean;
	onSave: (input: CreateTaxonomyInput | UpdateTaxonomyInput) => void;
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

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (isNew) {
			onSave({
				name,
				label,
				hierarchical,
				collections: selectedCollections,
			} satisfies CreateTaxonomyInput);
		} else {
			onSave({
				label,
				hierarchical,
				collections: selectedCollections,
			} satisfies UpdateTaxonomyInput);
		}
	}

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
		</div>
	);
}
