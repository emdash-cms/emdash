import { Badge, Button, Input, InputArea, Label, Select, buttonVariants } from "@cloudflare/kumo";
import {
	DndContext,
	closestCenter,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	Plus,
	DotsSixVertical,
	Pencil,
	Trash,
	Database,
	FileText,
} from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import type {
	SchemaCollectionWithFields,
	SchemaField,
	CreateFieldInput,
	CreateCollectionInput,
	UpdateCollectionInput,
} from "../lib/api";
import { cn } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { FieldEditor } from "./FieldEditor";

// Regex patterns for slug generation
const SLUG_INVALID_CHARS_PATTERN = /[^a-z0-9]+/g;
const SLUG_LEADING_TRAILING_PATTERN = /^_|_$/g;

export interface ContentTypeEditorProps {
	collection?: SchemaCollectionWithFields;
	isNew?: boolean;
	isSaving?: boolean;
	onSave: (input: CreateCollectionInput | UpdateCollectionInput) => void;
	onAddField?: (input: CreateFieldInput) => void;
	onUpdateField?: (fieldSlug: string, input: CreateFieldInput) => void;
	onDeleteField?: (fieldSlug: string) => void;
	onReorderFields?: (fieldSlugs: string[]) => void;
}

interface SupportOptionDef {
	value: string;
	label: MessageDescriptor;
	description: MessageDescriptor;
}

const SUPPORT_OPTIONS: SupportOptionDef[] = [
	{
		value: "drafts",
		label: msg`Drafts`,
		description: msg`Save content as draft before publishing`,
	},
	{
		value: "revisions",
		label: msg`Revisions`,
		description: msg`Track content history`,
	},
	{
		value: "preview",
		label: msg`Preview`,
		description: msg`Preview content before publishing`,
	},
	{
		value: "search",
		label: msg`Search`,
		description: msg`Enable full-text search on this collection`,
	},
];

/**
 * System fields that exist on every collection
 * These are created automatically and cannot be modified
 */
interface SystemFieldDef {
	slug: string;
	label: MessageDescriptor;
	type: string;
	description: MessageDescriptor;
}

const SYSTEM_FIELDS: SystemFieldDef[] = [
	{
		slug: "id",
		label: msg`ID`,
		type: "text",
		description: msg`Unique identifier (ULID)`,
	},
	{
		slug: "slug",
		label: msg`Slug`,
		type: "text",
		description: msg`URL-friendly identifier`,
	},
	{
		slug: "status",
		label: msg`Status`,
		type: "text",
		description: msg`draft, published, or archived`,
	},
	{
		slug: "created_at",
		label: msg`Created At`,
		type: "datetime",
		description: msg`When the entry was created`,
	},
	{
		slug: "updated_at",
		label: msg`Updated At`,
		type: "datetime",
		description: msg`When the entry was last modified`,
	},
	{
		slug: "published_at",
		label: msg`Published At`,
		type: "datetime",
		description: msg`When the entry was published`,
	},
];

/**
 * Content Type editor for creating/editing collections
 */
export function ContentTypeEditor({
	collection,
	isNew,
	isSaving,
	onSave,
	onAddField,
	onUpdateField,
	onDeleteField,
	onReorderFields,
}: ContentTypeEditorProps) {
	const { t } = useLingui();
	const _navigate = useNavigate();

	// Form state
	const [slug, setSlug] = React.useState(collection?.slug ?? "");
	const [label, setLabel] = React.useState(collection?.label ?? "");
	const [labelSingular, setLabelSingular] = React.useState(collection?.labelSingular ?? "");
	const [description, setDescription] = React.useState(collection?.description ?? "");
	const [urlPattern, setUrlPattern] = React.useState(collection?.urlPattern ?? "");
	// SEO is managed via the separate `hasSeo` field; strip any legacy "seo" entry
	// so it isn't sent back on save (the API enum rejects it).
	const [supports, setSupports] = React.useState<string[]>(
		(collection?.supports ?? ["drafts"]).filter((s) => s !== "seo"),
	);

	// SEO state
	const [hasSeo, setHasSeo] = React.useState(collection?.hasSeo ?? false);

	// Comment settings state
	const [commentsEnabled, setCommentsEnabled] = React.useState(
		collection?.commentsEnabled ?? false,
	);
	const [commentsModeration, setCommentsModeration] = React.useState<"all" | "first_time" | "none">(
		collection?.commentsModeration ?? "first_time",
	);
	const [commentsClosedAfterDays, setCommentsClosedAfterDays] = React.useState(
		collection?.commentsClosedAfterDays ?? 90,
	);
	const [commentsAutoApproveUsers, setCommentsAutoApproveUsers] = React.useState(
		collection?.commentsAutoApproveUsers ?? true,
	);

	// Field editor state
	const [fieldEditorOpen, setFieldEditorOpen] = React.useState(false);
	const [editingField, setEditingField] = React.useState<SchemaField | undefined>();
	const [fieldSaving, setFieldSaving] = React.useState(false);
	const [deleteFieldTarget, setDeleteFieldTarget] = React.useState<SchemaField | null>(null);

	const urlPatternValid = !urlPattern || urlPattern.includes("{slug}");

	// Track whether form has unsaved changes
	const hasChanges = React.useMemo(() => {
		if (isNew) return slug && label;
		if (!collection) return false;
		return (
			label !== collection.label ||
			labelSingular !== (collection.labelSingular ?? "") ||
			description !== (collection.description ?? "") ||
			urlPattern !== (collection.urlPattern ?? "") ||
			JSON.stringify([...supports].toSorted()) !==
				JSON.stringify(collection.supports.filter((s) => s !== "seo").toSorted()) ||
			hasSeo !== collection.hasSeo ||
			commentsEnabled !== collection.commentsEnabled ||
			commentsModeration !== collection.commentsModeration ||
			commentsClosedAfterDays !== collection.commentsClosedAfterDays ||
			commentsAutoApproveUsers !== collection.commentsAutoApproveUsers
		);
	}, [
		isNew,
		collection,
		slug,
		label,
		labelSingular,
		description,
		urlPattern,
		supports,
		hasSeo,
		commentsEnabled,
		commentsModeration,
		commentsClosedAfterDays,
		commentsAutoApproveUsers,
	]);

	// Auto-generate slug from plural label
	const handleLabelChange = (value: string) => {
		setLabel(value);
		if (isNew) {
			setSlug(
				value
					.toLowerCase()
					.replace(SLUG_INVALID_CHARS_PATTERN, "_")
					.replace(SLUG_LEADING_TRAILING_PATTERN, ""),
			);
		}
	};

	// Auto-generate plural label (and slug) from singular label
	const handleSingularLabelChange = (value: string) => {
		setLabelSingular(value);
		if (isNew) {
			const plural = value ? `${value}s` : "";
			handleLabelChange(plural);
		}
	};

	const handleSupportToggle = (value: string) => {
		setSupports((prev) =>
			prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value],
		);
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isNew) {
			onSave({
				slug,
				label,
				labelSingular: labelSingular || undefined,
				description: description || undefined,
				urlPattern: urlPattern || undefined,
				supports,
				hasSeo,
			});
		} else {
			onSave({
				label,
				labelSingular: labelSingular || undefined,
				description: description || undefined,
				urlPattern: urlPattern || undefined,
				supports,
				hasSeo,
				commentsEnabled,
				commentsModeration,
				commentsClosedAfterDays,
				commentsAutoApproveUsers,
			});
		}
	};

	const handleFieldSave = async (input: CreateFieldInput) => {
		setFieldSaving(true);
		try {
			if (editingField) {
				onUpdateField?.(editingField.slug, input);
			} else {
				onAddField?.(input);
			}
			setFieldEditorOpen(false);
			setEditingField(undefined);
		} finally {
			setFieldSaving(false);
		}
	};

	const handleEditField = (field: SchemaField) => {
		setEditingField(field);
		setFieldEditorOpen(true);
	};

	const handleAddField = () => {
		setEditingField(undefined);
		setFieldEditorOpen(true);
	};

	const isFromCode = collection?.source === "code";
	const fields = collection?.fields ?? [];

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		const oldIndex = fields.findIndex((f) => f.id === active.id);
		const newIndex = fields.findIndex((f) => f.id === over.id);
		if (oldIndex === -1 || newIndex === -1) return;
		const reordered = arrayMove(fields, oldIndex, newIndex);
		onReorderFields?.(reordered.map((f) => f.slug));
	};

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center space-x-4">
				<Link
					to="/content-types"
					aria-label="Back to Content Types"
					className={buttonVariants({ variant: "ghost", shape: "square" })}
				>
					<ArrowLeft className="h-5 w-5" />
				</Link>
				<div className="flex-1">
					<h1 className="text-2xl font-bold">{isNew ? "New Content Type" : collection?.label}</h1>
					{!isNew && (
						<p className="text-kumo-subtle text-sm">
							<code className="bg-kumo-tint px-1.5 py-0.5 rounded">{collection?.slug}</code>
							{isFromCode && (
								<span className="ms-2 text-purple-600 dark:text-purple-400">Defined in code</span>
							)}
						</p>
					)}
				</div>
			</div>

			{isFromCode && (
				<div className="rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950 p-4">
					<div className="flex items-center space-x-2">
						<FileText className="h-5 w-5 text-purple-600 dark:text-purple-400" />
						<p className="text-sm text-purple-700 dark:text-purple-300">
							This collection is defined in code. Some settings cannot be changed here. Edit your
							live.config.ts file to modify the schema.
						</p>
					</div>
				</div>
			)}

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Settings form */}
				<div className="lg:col-span-1">
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="rounded-lg border p-4 space-y-4">
							<h2 className="font-semibold">Settings</h2>

							<Input
								label="Label (Singular)"
								value={labelSingular}
								onChange={(e) => handleSingularLabelChange(e.target.value)}
								placeholder="Post"
								disabled={isFromCode}
							/>

							<Input
								label="Label (Plural)"
								value={label}
								onChange={(e) => handleLabelChange(e.target.value)}
								placeholder="Posts"
								disabled={isFromCode}
							/>

							{isNew && (
								<div>
									<Input
										label="Slug"
										value={slug}
										onChange={(e) => setSlug(e.target.value)}
										placeholder="posts"
										disabled={!isNew}
									/>
									<p className="text-xs text-kumo-subtle mt-2">Used in URLs and API endpoints</p>
								</div>
							)}

							<InputArea
								label="Description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="A brief description of this content type"
								rows={3}
								disabled={isFromCode}
							/>

							<div>
								<Input
									label="URL Pattern"
									value={urlPattern}
									onChange={(e) => setUrlPattern(e.target.value)}
									placeholder={`/${slug === "pages" ? "" : `${slug}/`}{slug}`}
									disabled={isFromCode}
								/>
								{urlPattern && !urlPattern.includes("{slug}") && (
									<p className="text-xs text-kumo-danger mt-2">
										Pattern must include a {"{slug}"} placeholder
									</p>
								)}
								<p className="text-xs text-kumo-subtle mt-1">
									Pattern for generating URLs, e.g. /blog/{"{slug}"}
								</p>
							</div>

							<div className="space-y-3">
								<Label>Features</Label>
								{SUPPORT_OPTIONS.map((option) => (
									<label
										key={option.value}
										className={cn(
											"flex items-start space-x-3 p-2 rounded-md cursor-pointer hover:bg-kumo-tint/50",
											isFromCode && "opacity-60 cursor-not-allowed",
										)}
									>
										<input
											type="checkbox"
											checked={supports.includes(option.value)}
											onChange={() => handleSupportToggle(option.value)}
											className="mt-1 rounded border-kumo-line"
											disabled={isFromCode}
										/>
										<div>
											<span className="text-sm font-medium">{t(option.label)}</span>
											<p className="text-xs text-kumo-subtle">{t(option.description)}</p>
										</div>
									</label>
								))}
							</div>

							{/* SEO toggle */}
							<div className="pt-2 border-t">
								<label
									className={cn(
										"flex items-start space-x-3 p-2 rounded-md cursor-pointer hover:bg-kumo-tint/50",
										isFromCode && "opacity-60 cursor-not-allowed",
									)}
								>
									<input
										type="checkbox"
										checked={hasSeo}
										onChange={() => setHasSeo(!hasSeo)}
										className="mt-1 rounded border-kumo-line"
										disabled={isFromCode}
									/>
									<div>
										<span className="text-sm font-medium">SEO</span>
										<p className="text-xs text-kumo-subtle">
											Add SEO metadata fields (title, description, image) and include in sitemap
										</p>
									</div>
								</label>
							</div>
						</div>

						{/* Comments settings — only for existing collections */}
						{!isNew && (
							<div className="rounded-lg border p-4 space-y-4">
								<h2 className="font-semibold">Comments</h2>

								<label
									className={cn(
										"flex items-start space-x-3 p-2 rounded-md cursor-pointer hover:bg-kumo-tint/50",
										isFromCode && "opacity-60 cursor-not-allowed",
									)}
								>
									<input
										type="checkbox"
										checked={commentsEnabled}
										onChange={() => setCommentsEnabled(!commentsEnabled)}
										className="mt-1 rounded border-kumo-line"
										disabled={isFromCode}
									/>
									<div>
										<span className="text-sm font-medium">Enable comments</span>
										<p className="text-xs text-kumo-subtle">
											Allow visitors to leave comments on this collection's content
										</p>
									</div>
								</label>

								{commentsEnabled && (
									<>
										<Select
											label="Moderation"
											value={commentsModeration}
											onValueChange={(v) =>
												setCommentsModeration((v as "all" | "first_time" | "none") ?? "first_time")
											}
											items={{
												all: "All comments require approval",
												first_time: "First-time commenters only",
												none: "No moderation (auto-approve all)",
											}}
											disabled={isFromCode}
										/>

										<Input
											label="Close comments after (days)"
											type="number"
											min={0}
											value={String(commentsClosedAfterDays)}
											onChange={(e) => {
												const parsed = Number.parseInt(e.target.value, 10);
												setCommentsClosedAfterDays(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
											}}
											disabled={isFromCode}
										/>
										<p className="text-xs text-kumo-subtle -mt-2">
											Set to 0 to never close comments automatically.
										</p>

										<label
											className={cn(
												"flex items-start space-x-3 p-2 rounded-md cursor-pointer hover:bg-kumo-tint/50",
												isFromCode && "opacity-60 cursor-not-allowed",
											)}
										>
											<input
												type="checkbox"
												checked={commentsAutoApproveUsers}
												onChange={() => setCommentsAutoApproveUsers(!commentsAutoApproveUsers)}
												className="mt-1 rounded border-kumo-line"
												disabled={isFromCode}
											/>
											<div>
												<span className="text-sm font-medium">
													Auto-approve authenticated users
												</span>
												<p className="text-xs text-kumo-subtle">
													Comments from logged-in CMS users are approved automatically
												</p>
											</div>
										</label>
									</>
								)}
							</div>
						)}

						{!isFromCode && (
							<Button
								type="submit"
								disabled={!hasChanges || !urlPatternValid || isSaving}
								className="w-full"
							>
								{isSaving ? "Saving..." : isNew ? "Create Content Type" : "Save Changes"}
							</Button>
						)}
					</form>
				</div>

				{/* Fields section - only show for existing collections */}
				{!isNew && (
					<div className="lg:col-span-2">
						<div className="rounded-lg border">
							<div className="flex items-center justify-between p-4 border-b">
								<div>
									<h2 className="font-semibold">Fields</h2>
									<p className="text-sm text-kumo-subtle">
										{SYSTEM_FIELDS.length} system + {fields.length} custom field
										{fields.length !== 1 ? "s" : ""}
									</p>
								</div>
								{!isFromCode && (
									<Button icon={<Plus />} onClick={handleAddField}>
										Add Field
									</Button>
								)}
							</div>

							{/* System fields - always shown */}
							<div className="border-b bg-kumo-tint/30">
								<div className="px-4 py-2 text-xs font-medium text-kumo-subtle uppercase tracking-wider">
									System Fields
								</div>
								<div className="divide-y divide-kumo-line/50">
									{SYSTEM_FIELDS.map((field) => (
										<SystemFieldRow key={field.slug} field={field} />
									))}
								</div>
							</div>

							{/* Custom fields */}
							{fields.length === 0 ? (
								<div className="p-8 text-center text-kumo-subtle">
									<Database className="mx-auto h-12 w-12 mb-4 opacity-50" />
									<p className="font-medium">No custom fields yet</p>
									<p className="text-sm">Add fields to define the structure of your content</p>
									{!isFromCode && (
										<Button className="mt-4" icon={<Plus />} onClick={handleAddField}>
											Add First Field
										</Button>
									)}
								</div>
							) : (
								<>
									<div className="px-4 py-2 text-xs font-medium text-kumo-subtle uppercase tracking-wider border-b">
										Custom Fields
									</div>
									<DndContext
										sensors={sensors}
										collisionDetection={closestCenter}
										onDragEnd={handleDragEnd}
									>
										<SortableContext
											items={fields.map((f) => f.id)}
											strategy={verticalListSortingStrategy}
										>
											<div className="divide-y">
												{fields.map((field) => (
													<FieldRow
														key={field.id}
														field={field}
														isFromCode={isFromCode}
														onEdit={() => handleEditField(field)}
														onDelete={() => setDeleteFieldTarget(field)}
													/>
												))}
											</div>
										</SortableContext>
									</DndContext>
								</>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Field editor dialog */}
			<FieldEditor
				open={fieldEditorOpen}
				onOpenChange={setFieldEditorOpen}
				field={editingField}
				onSave={handleFieldSave}
				isSaving={fieldSaving}
			/>

			<ConfirmDialog
				open={!!deleteFieldTarget}
				onClose={() => setDeleteFieldTarget(null)}
				title="Delete Field?"
				description={
					deleteFieldTarget
						? `Are you sure you want to delete the "${deleteFieldTarget.label}" field?`
						: ""
				}
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={false}
				error={null}
				onConfirm={() => {
					if (deleteFieldTarget) {
						onDeleteField?.(deleteFieldTarget.slug);
						setDeleteFieldTarget(null);
					}
				}}
			/>
		</div>
	);
}

interface FieldRowProps {
	field: SchemaField;
	isFromCode?: boolean;
	onEdit: () => void;
	onDelete: () => void;
}

function FieldRow({ field, isFromCode, onEdit, onDelete }: FieldRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: field.id,
		disabled: isFromCode,
	});
	const style = { transform: CSS.Transform.toString(transform), transition };

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"flex items-center px-4 py-3 hover:bg-kumo-tint/25",
				isDragging && "opacity-50",
			)}
		>
			{!isFromCode && (
				<button
					{...attributes}
					{...listeners}
					className="cursor-grab active:cursor-grabbing me-3"
					aria-label={`Drag to reorder ${field.label}`}
				>
					<DotsSixVertical className="h-5 w-5 text-kumo-subtle" />
				</button>
			)}
			<div className="flex-1 min-w-0">
				<div className="flex items-center space-x-2">
					<span className="font-medium">{field.label}</span>
					<code className="text-xs bg-kumo-tint px-1.5 py-0.5 rounded text-kumo-subtle">
						{field.slug}
					</code>
				</div>
				<div className="flex items-center space-x-2 mt-1">
					<span className="text-xs text-kumo-subtle capitalize">{field.type}</span>
					{field.required && <Badge variant="secondary">Required</Badge>}
					{field.unique && <Badge variant="secondary">Unique</Badge>}
					{field.searchable && <Badge variant="secondary">Searchable</Badge>}
				</div>
			</div>
			{!isFromCode && (
				<div className="flex items-center space-x-1">
					<Button
						variant="ghost"
						shape="square"
						onClick={onEdit}
						aria-label={`Edit ${field.label} field`}
					>
						<Pencil className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						shape="square"
						onClick={onDelete}
						aria-label={`Delete ${field.label} field`}
					>
						<Trash className="h-4 w-4 text-kumo-danger" />
					</Button>
				</div>
			)}
		</div>
	);
}

interface SystemFieldInfo {
	slug: string;
	label: MessageDescriptor;
	type: string;
	description: MessageDescriptor;
}

function SystemFieldRow({ field }: { field: SystemFieldInfo }) {
	const { t } = useLingui();
	return (
		<div className="flex items-center px-4 py-2 opacity-75">
			<div className="w-8" /> {/* Spacer for alignment with draggable fields */}
			<div className="flex-1 min-w-0">
				<div className="flex items-center space-x-2">
					<span className="font-medium text-sm">{t(field.label)}</span>
					<code className="text-xs bg-kumo-tint px-1.5 py-0.5 rounded text-kumo-subtle">
						{field.slug}
					</code>
					<Badge variant="secondary">System</Badge>
				</div>
				<p className="text-xs text-kumo-subtle mt-0.5">{t(field.description)}</p>
			</div>
		</div>
	);
}
