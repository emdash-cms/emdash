/**
 * Taxonomy Terms Manager
 *
 * Provides UI for managing taxonomy terms (categories, tags, custom taxonomies).
 * Shows hierarchical structure for categories, flat list for tags.
 */

import { Button, Checkbox, Dialog, Input, InputArea, Select, Toast } from "@cloudflare/kumo";
import { Plus, Pencil, Trash, X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchManifest } from "../lib/api/client.js";
import type { TaxonomyTerm, TaxonomyDef, CreateTaxonomyInput } from "../lib/api/taxonomies.js";
import {
	fetchTaxonomyDef,
	fetchTerms,
	createTaxonomy,
	createTerm,
	updateTerm,
	deleteTerm,
} from "../lib/api/taxonomies.js";
import { slugify } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";

interface TaxonomyManagerProps {
	taxonomyName: string;
}

// Regex patterns for taxonomy name generation and validation (module-scoped per lint rules)
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/g;
const LEADING_TRAILING_UNDERSCORE_PATTERN = /^_|_$/g;
const TAXONOMY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Flatten tree to get all terms
 */
function flattenTerms(terms: TaxonomyTerm[]): TaxonomyTerm[] {
	return terms.flatMap((t) => [t, ...flattenTerms(t.children)]);
}

/**
 * Term row component (recursive for hierarchy)
 */
function TermRow({
	term,
	level = 0,
	onEdit,
	onDelete,
}: {
	term: TaxonomyTerm;
	level?: number;
	onEdit: (term: TaxonomyTerm) => void;
	onDelete: (term: TaxonomyTerm) => void;
}) {
	return (
		<>
			<div className="flex items-center gap-4 py-2 px-4 border-b hover:bg-kumo-tint/50">
				<div style={{ marginLeft: `${level * 1.5}rem` }} className="flex-1">
					<span className="font-medium">{term.label}</span>
					<span className="text-sm text-kumo-subtle ml-2">({term.slug})</span>
				</div>
				<div className="text-sm text-kumo-subtle">{term.count || 0}</div>
				<div className="flex gap-2">
					<Button
						variant="ghost"
						size="sm"
						aria-label={`Edit ${term.label}`}
						onClick={() => onEdit(term)}
					>
						<Pencil className="w-4 h-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-label={`Delete ${term.label}`}
						onClick={() => onDelete(term)}
					>
						<Trash className="w-4 h-4" />
					</Button>
				</div>
			</div>
			{term.children.map((child) => (
				<TermRow
					key={child.id}
					term={child}
					level={level + 1}
					onEdit={onEdit}
					onDelete={onDelete}
				/>
			))}
		</>
	);
}

/**
 * Term form dialog
 */
function TermFormDialog({
	open,
	onClose,
	taxonomyName,
	taxonomyDef,
	term,
	allTerms,
}: {
	open: boolean;
	onClose: () => void;
	taxonomyName: string;
	taxonomyDef: TaxonomyDef;
	term?: TaxonomyTerm;
	allTerms: TaxonomyTerm[];
}) {
	const queryClient = useQueryClient();
	const [label, setLabel] = React.useState(term?.label || "");
	const [slug, setSlug] = React.useState(term?.slug || "");
	const [parentId, setParentId] = React.useState(term?.parentId || "");
	const [description, setDescription] = React.useState(term?.description || "");
	const [autoSlug, setAutoSlug] = React.useState(!term);
	const [error, setError] = React.useState<string | null>(null);

	// Auto-generate slug from label
	React.useEffect(() => {
		if (autoSlug && label) {
			setSlug(slugify(label));
		}
	}, [label, autoSlug]);

	const createMutation = useMutation({
		mutationFn: () =>
			createTerm(taxonomyName, {
				slug,
				label,
				parentId: parentId || undefined,
				description: description || undefined,
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomyName],
			});
			onClose();
		},
		onError: (err: Error) => {
			setError(err.message);
		},
	});

	const updateMutation = useMutation({
		mutationFn: () => {
			if (!term) throw new Error("No term to update");
			return updateTerm(taxonomyName, term.slug, {
				slug,
				label,
				parentId: parentId || undefined,
				description: description || undefined,
			});
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomyName],
			});
			onClose();
		},
		onError: (err: Error) => {
			setError(err.message);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (term) {
			updateMutation.mutate();
		} else {
			createMutation.mutate();
		}
	};

	// Flatten terms for parent selector (exclude current term and its children)
	const flatTerms = flattenTerms(allTerms);
	const availableParents = term
		? flatTerms.filter((t) => t.id !== term.id && t.parentId !== term.id)
		: flatTerms;

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(isOpen: boolean) => {
				if (!isOpen) {
					setError(null);
					onClose();
				}
			}}
		>
			<Dialog className="p-6" size="lg">
				<form onSubmit={handleSubmit}>
					<div className="flex items-start justify-between gap-4 mb-4">
						<div className="flex flex-col space-y-1.5">
							<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
								{term ? "Edit" : "Add"} {taxonomyDef.labelSingular || "Term"}
							</Dialog.Title>
							<Dialog.Description className="text-sm text-kumo-subtle">
								{term
									? `Update the ${taxonomyDef.labelSingular?.toLowerCase() || "term"} details`
									: `Create a new ${taxonomyDef.labelSingular?.toLowerCase() || "term"}`}
							</Dialog.Description>
						</div>
						<Dialog.Close
							aria-label="Close"
							render={(props) => (
								<Button
									{...props}
									variant="ghost"
									shape="square"
									aria-label="Close"
									className="absolute right-4 top-4"
								>
									<X className="h-4 w-4" />
									<span className="sr-only">Close</span>
								</Button>
							)}
						/>
					</div>

					<div className="space-y-4 py-4">
						<Input
							label="Name"
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="News"
							required
						/>

						<div>
							<Input
								label="Slug"
								value={slug}
								onChange={(e) => {
									setSlug(e.target.value);
									setAutoSlug(false);
								}}
								placeholder="news"
								required
							/>
							<p className="text-sm text-kumo-subtle mt-1">
								Auto-generated from name (you can edit)
							</p>
						</div>

						{taxonomyDef.hierarchical && (
							<Select
								label="Parent"
								value={parentId}
								onValueChange={(v) => setParentId(v ?? "")}
								items={{
									"": "None (top level)",
									...Object.fromEntries(availableParents.map((t) => [t.id, t.label])),
								}}
							>
								<Select.Option value="">None (top level)</Select.Option>
								{availableParents.map((t) => (
									<Select.Option key={t.id} value={t.id}>
										{t.label}
									</Select.Option>
								))}
							</Select>
						)}

						<InputArea
							label="Description (optional)"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Optional description"
							rows={3}
						/>

						<DialogError
							message={
								error ||
								getMutationError(createMutation.error) ||
								getMutationError(updateMutation.error)
							}
						/>
					</div>

					<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
							{createMutation.isPending || updateMutation.isPending
								? "Saving..."
								: term
									? "Update"
									: "Create"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * Create Taxonomy dialog
 */
function CreateTaxonomyDialog({
	open,
	onClose,
	onCreated,
}: {
	open: boolean;
	onClose: () => void;
	onCreated: () => void;
}) {
	const queryClient = useQueryClient();
	const [name, setName] = React.useState("");
	const [label, setLabel] = React.useState("");
	const [hierarchical, setHierarchical] = React.useState(false);
	const [selectedCollections, setSelectedCollections] = React.useState<string[]>([]);
	const [autoName, setAutoName] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const collectionEntries = manifest
		? Object.entries(manifest.collections).map(([slug, config]) => ({
				slug,
				label: config.label,
			}))
		: [];

	// Auto-generate name from label
	React.useEffect(() => {
		if (autoName && label) {
			setName(
				label
					.toLowerCase()
					.replace(NON_ALPHANUMERIC_PATTERN, "_")
					.replace(LEADING_TRAILING_UNDERSCORE_PATTERN, ""),
			);
		}
	}, [label, autoName]);

	const createMutation = useMutation({
		mutationFn: (input: CreateTaxonomyInput) => createTaxonomy(input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-defs"] });
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-def"] });
			onCreated();
			resetForm();
		},
	});

	const resetForm = () => {
		setName("");
		setLabel("");
		setHierarchical(false);
		setSelectedCollections([]);
		setAutoName(true);
		setError(null);
		createMutation.reset();
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		if (!name || !label) {
			setError("Name and label are required");
			return;
		}

		if (!TAXONOMY_NAME_PATTERN.test(name)) {
			setError(
				"Name must start with a letter and contain only lowercase letters, numbers, and underscores",
			);
			return;
		}

		createMutation.mutate({
			name,
			label,
			hierarchical,
			collections: selectedCollections,
		});
	};

	const toggleCollection = (slug: string) => {
		setSelectedCollections((prev) =>
			prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
		);
	};

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(isOpen: boolean) => {
				if (!isOpen) {
					resetForm();
					onClose();
				}
			}}
		>
			<Dialog className="p-6" size="lg">
				<form onSubmit={handleSubmit}>
					<div className="flex items-start justify-between gap-4 mb-4">
						<div className="flex flex-col space-y-1.5">
							<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
								Create Taxonomy
							</Dialog.Title>
							<Dialog.Description className="text-sm text-kumo-subtle">
								Define a new taxonomy for classifying content
							</Dialog.Description>
						</div>
						<Dialog.Close
							aria-label="Close"
							render={(props) => (
								<Button
									{...props}
									variant="ghost"
									shape="square"
									aria-label="Close"
									className="absolute right-4 top-4"
								>
									<X className="h-4 w-4" />
									<span className="sr-only">Close</span>
								</Button>
							)}
						/>
					</div>

					<div className="space-y-4 py-4">
						<Input
							label="Label"
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="Genres"
							required
						/>

						<div>
							<Input
								label="Name"
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									setAutoName(false);
								}}
								placeholder="genre"
								required
								pattern="[a-z][a-z0-9_]*"
								title="Lowercase letters, numbers, and underscores only, starting with a letter"
							/>
							<p className="text-xs text-kumo-subtle mt-1">
								Used as the identifier. Lowercase letters, numbers, and underscores only.
							</p>
						</div>

						<Checkbox
							label="Hierarchical (like categories, with parent/child relationships)"
							checked={hierarchical}
							onCheckedChange={(checked) => setHierarchical(checked)}
						/>

						{collectionEntries.length > 0 && (
							<div>
								<label className="text-sm font-medium">Collections</label>
								<p className="text-xs text-kumo-subtle mb-2">
									Which content types can use this taxonomy
								</p>
								<div className="border rounded-md p-2 space-y-1">
									{collectionEntries.map(({ slug, label: collLabel }) => (
										<label
											key={slug}
											className="flex items-center gap-2 py-1 px-2 cursor-pointer hover:bg-kumo-tint/50 rounded"
										>
											<input
												type="checkbox"
												checked={selectedCollections.includes(slug)}
												onChange={() => toggleCollection(slug)}
												className="rounded"
											/>
											<span className="text-sm">{collLabel}</span>
										</label>
									))}
								</div>
							</div>
						)}

						<DialogError message={error || getMutationError(createMutation.error)} />
					</div>

					<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								resetForm();
								onClose();
							}}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={createMutation.isPending}>
							{createMutation.isPending ? "Creating..." : "Create Taxonomy"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * Main TaxonomyManager component
 */
export function TaxonomyManager({ taxonomyName }: TaxonomyManagerProps) {
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [formOpen, setFormOpen] = React.useState(false);
	const [editingTerm, setEditingTerm] = React.useState<TaxonomyTerm | undefined>();
	const [deleteTarget, setDeleteTarget] = React.useState<TaxonomyTerm | null>(null);
	const [createTaxonomyOpen, setCreateTaxonomyOpen] = React.useState(false);

	const { data: taxonomyDef, isLoading: defLoading } = useQuery({
		queryKey: ["taxonomy-def", taxonomyName],
		queryFn: () => fetchTaxonomyDef(taxonomyName),
	});

	const { data: terms = [], isLoading: termsLoading } = useQuery({
		queryKey: ["taxonomy-terms", taxonomyName],
		queryFn: () => fetchTerms(taxonomyName),
	});

	const deleteMutation = useMutation({
		mutationFn: (term: TaxonomyTerm) => deleteTerm(taxonomyName, term.slug),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["taxonomy-terms", taxonomyName],
			});
			setDeleteTarget(null);
			toastManager.add({ title: "Term deleted" });
		},
	});

	const handleEdit = (term: TaxonomyTerm) => {
		setEditingTerm(term);
		setFormOpen(true);
	};

	const handleDelete = (term: TaxonomyTerm) => {
		setDeleteTarget(term);
	};

	const handleCloseForm = () => {
		setFormOpen(false);
		setEditingTerm(undefined);
	};

	if (defLoading) {
		return <div>Loading...</div>;
	}

	if (!taxonomyDef) {
		return <div>Taxonomy not found: {taxonomyName}</div>;
	}

	const flatTerms = flattenTerms(terms);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold">{taxonomyDef.label}</h1>
					<p className="text-kumo-subtle mt-1">
						Manage {taxonomyDef.label.toLowerCase()} for {taxonomyDef.collections.join(", ")}
					</p>
				</div>
				<div className="flex gap-2">
					<Button variant="outline" icon={<Plus />} onClick={() => setCreateTaxonomyOpen(true)}>
						New Taxonomy
					</Button>
					<Button icon={<Plus />} onClick={() => setFormOpen(true)}>
						Add {taxonomyDef.labelSingular || "Term"}
					</Button>
				</div>
			</div>

			<div className="border rounded-lg">
				<div className="flex items-center gap-4 py-2 px-4 border-b bg-kumo-tint/50 font-medium">
					<div className="flex-1">Name</div>
					<div className="w-16 text-center">Count</div>
					<div className="w-24 text-center">Actions</div>
				</div>

				{termsLoading ? (
					<div className="p-8 text-center text-kumo-subtle">Loading terms...</div>
				) : terms.length === 0 ? (
					<div className="p-8 text-center text-kumo-subtle">
						No {taxonomyDef.label.toLowerCase()} yet. Create one to get started.
					</div>
				) : (
					<div>
						{terms.map((term) => (
							<TermRow key={term.id} term={term} onEdit={handleEdit} onDelete={handleDelete} />
						))}
					</div>
				)}
			</div>

			<TermFormDialog
				open={formOpen}
				onClose={handleCloseForm}
				taxonomyName={taxonomyName}
				taxonomyDef={taxonomyDef}
				term={editingTerm}
				allTerms={flatTerms}
			/>

			<ConfirmDialog
				open={!!deleteTarget}
				onClose={() => {
					setDeleteTarget(null);
					deleteMutation.reset();
				}}
				title={`Delete ${taxonomyDef.labelSingular || "Term"}?`}
				description={
					<>This will permanently delete "{deleteTarget?.label}" and remove it from all content.</>
				}
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
			/>

			<CreateTaxonomyDialog
				open={createTaxonomyOpen}
				onClose={() => setCreateTaxonomyOpen(false)}
				onCreated={() => {
					setCreateTaxonomyOpen(false);
					toastManager.add({ title: "Taxonomy created" });
				}}
			/>
		</div>
	);
}
