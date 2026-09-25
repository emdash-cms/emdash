import {
	Badge,
	Button,
	Checkbox,
	Dialog,
	Input,
	InputArea,
	Select,
	Switch,
	Tooltip,
} from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
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
	GlobeSimple,
	Rows,
	Plus,
	Trash,
	X,
	Info,
	ArrowUp,
	ArrowDown,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import * as React from "react";

import { fetchCollections, fetchRelations } from "../lib/api";
import type { FieldType, CreateFieldInput, SchemaField } from "../lib/api";
import type {
	CreateRelationInput,
	RelationDef,
	RelationSide,
	RelationWithUsage,
} from "../lib/api/relations.js";
import { fetchBlockTypes } from "../lib/api/schema.js";
import { singularize } from "../lib/singularize.js";
import { cn } from "../lib/utils";
import { AllowedTypesEditor } from "./AllowedTypesEditor";
import {
	RELATION_DIALOG_CLASS,
	RELATION_DIALOG_STYLE,
	RelationFormPanel,
} from "./RelationFormPanel.js";

// ============================================================================
// Constants
// ============================================================================

const SLUG_INVALID_CHARS_REGEX = /[^a-z0-9]+/g;
const SLUG_LEADING_TRAILING_REGEX = /^_|_$/g;
const SEARCHABLE_FIELD_TYPES = new Set<FieldType>([
	"string",
	"text",
	"portableText",
	"slug",
	"url",
]);
const INDEXABLE_FIELD_TYPES = new Set<FieldType>([
	"string",
	"url",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"slug",
]);

/** Stands for "make a new relationship" in the relationship picker. Not a slug:
 * a relationship named this cannot exist, since slugs cannot hold `:`. */
const CREATE_RELATION = "create:relation";

/**
 * Which ends of `relation` a field on `collection` could still bind to.
 *
 * A self-referential relation offers both; any other relation offers the one
 * end that matches. An end a field already picks from is not offered again.
 */
function freeSidesFor(relation: RelationWithUsage, collection: string): RelationSide[] {
	const taken = new Set(relation.boundFields.map((f) => f.side));
	const sides: RelationSide[] = [];
	if (relation.parentCollection === collection && !taken.has("parent")) sides.push("parent");
	if (relation.childCollection === collection && !taken.has("child")) sides.push("child");
	return sides;
}

function slugifyLabel(value: string): string {
	return value
		.toLowerCase()
		.replace(SLUG_INVALID_CHARS_REGEX, "_")
		.replace(SLUG_LEADING_TRAILING_REGEX, "");
}

/**
 * A picker is called what the side it picks is called: a field over the linked
 * end of Chapters → Lessons is "Lessons", and the inverse one is "Chapters".
 * A label the user typed stands.
 */
function nameAfterRelation(
	state: FieldFormState,
	relation: RelationWithUsage | undefined,
	side: RelationSide,
): FieldFormState {
	if (!relation || state.labelEdited) return state;
	const label = side === "parent" ? relation.childLabel : relation.parentLabel;
	return { ...state, label, slug: slugifyLabel(label) };
}

/** What one side of a relation calls a single entry. */
function sideSingular(relation: RelationWithUsage, side: RelationSide): string {
	return side === "parent"
		? relation.parentLabelSingular || singularize(relation.parentLabel)
		: relation.childLabelSingular || singularize(relation.childLabel);
}

function isSearchableFieldType(type: FieldType | null): type is FieldType {
	return type !== null && SEARCHABLE_FIELD_TYPES.has(type);
}

function isIndexableFieldType(type: FieldType | null): type is FieldType {
	return type !== null && INDEXABLE_FIELD_TYPES.has(type);
}

// ============================================================================
// Types
// ============================================================================

export interface FieldEditorProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	field?: SchemaField;
	onSave: (input: CreateFieldInput) => void;
	isSaving?: boolean;
	/** The collection the field belongs to. Reference fields need it to work out
	 * which relations they can bind to, and from which end. */
	collectionSlug?: string;
	/** Lets a new reference field make the relationship it needs without
	 * leaving the dialog. Resolves with the relationship it created. */
	onCreateRelation?: (input: CreateRelationInput) => Promise<RelationDef>;
}

interface FieldTypeConfig {
	type: FieldType;
	label: string;
	description: string;
	icon: React.ElementType;
}

interface RepeaterSubFieldState {
	slug: string;
	type: string;
	label: string;
	required: boolean;
}

interface FieldFormState {
	/** `relation` is the relationship being made for a reference field, which
	 * the dialog returns from once it exists. */
	step: "type" | "config" | "relation";
	selectedType: FieldType | null;
	slug: string;
	label: string;
	required: boolean;
	unique: boolean;
	searchable: boolean;
	indexed: boolean;
	minLength: string;
	maxLength: string;
	min: string;
	max: string;
	pattern: string;
	options: string;
	subFields: RepeaterSubFieldState[];
	minItems: string;
	maxItems: string;
	allowedMimeTypes: string[];
	targetCollection: string;
	allowMultiple: boolean;
	darkVariant: boolean;
	/** Relation slug to bind to, `""` for "create a new one" on an existing
	 * field, or `CREATE_RELATION` for a new field on its way to making one. */
	relation: string;
	relationSide: RelationSide;
	/** A label the user typed, which the relationship must not overwrite. */
	labelEdited: boolean;
	allowedTypes: string[];
	retiredTypes: string[];
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
			indexed: field.indexed ?? false,
			minLength: field.validation?.minLength?.toString() ?? "",
			maxLength: field.validation?.maxLength?.toString() ?? "",
			min: field.validation?.min?.toString() ?? "",
			max: field.validation?.max?.toString() ?? "",
			pattern: field.validation?.pattern ?? "",
			options: field.validation?.options?.join("\n") ?? "",
			subFields: (field.validation as Record<string, unknown>)?.subFields
				? ((field.validation as Record<string, unknown>).subFields as RepeaterSubFieldState[])
				: [],
			minItems: (field.validation as Record<string, unknown>)?.minItems?.toString() ?? "",
			maxItems: (field.validation as Record<string, unknown>)?.maxItems?.toString() ?? "",
			allowedMimeTypes: field.validation?.allowedMimeTypes ?? [],
			// A reference field created before relations existed named its target in
			// `options.collection`. Showing it here is what lets the editor confirm
			// it and turn the field into a picker.
			targetCollection:
				field.validation?.targetCollection ??
				(typeof field.options?.collection === "string" ? field.options.collection : ""),
			// An unbound legacy field carries no `multiple`; the API and migration 077
			// both read a missing one as single, so the switch must not say otherwise.
			allowMultiple: field.validation?.multiple ?? false,
			darkVariant: field.options?.darkVariant === true,
			relation: field.validation?.relation ?? "",
			relationSide: field.validation?.relationSide ?? "parent",
			labelEdited: true,
			allowedTypes: field.validation?.allowedTypes ?? [],
			retiredTypes: field.validation?.retiredTypes ?? [],
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
		indexed: false,
		minLength: "",
		maxLength: "",
		min: "",
		max: "",
		pattern: "",
		options: "",
		subFields: [],
		minItems: "",
		maxItems: "",
		allowedMimeTypes: [],
		targetCollection: "",
		allowMultiple: false,
		darkVariant: false,
		relation: "",
		relationSide: "parent",
		labelEdited: false,
		allowedTypes: [],
		retiredTypes: [],
	};
}

/**
 * Field editor dialog for creating/editing fields
 */
export function FieldEditor({
	open,
	onOpenChange,
	field,
	onSave,
	isSaving,
	collectionSlug,
	onCreateRelation,
}: FieldEditorProps) {
	const { t } = useLingui();
	const [formState, setFormState] = React.useState(() => getInitialFormState(field));
	const [refError, setRefError] = React.useState(false);
	// The relationship this dialog just made. The relations query refetches
	// after it, but the picker names it before that answer arrives.
	const [createdRelation, setCreatedRelation] = React.useState<RelationWithUsage | null>(null);

	const isReferenceType = formState.selectedType === "reference";

	const { data: collections = [] } = useQuery({
		queryKey: ["collections"],
		queryFn: fetchCollections,
		enabled: open && isReferenceType,
	});

	const { data: fetchedRelations = [] } = useQuery({
		queryKey: ["relations"],
		queryFn: () => fetchRelations(),
		enabled: open && isReferenceType,
		// A relationship made in another tab has to show up on the way back.
		refetchOnWindowFocus: "always",
	});

	const allRelations = React.useMemo(
		() =>
			createdRelation && !fetchedRelations.some((rel) => rel.slug === createdRelation.slug)
				? [...fetchedRelations, createdRelation]
				: fetchedRelations,
		[fetchedRelations, createdRelation],
	);

	// Reset state when dialog opens
	React.useEffect(() => {
		if (open) {
			setFormState(getInitialFormState(field));
			setRefError(false);
			setCreatedRelation(null);
		}
	}, [open, field]);

	const { step, selectedType, slug, label, required, unique, searchable, indexed } = formState;
	const { minLength, maxLength, min, max, pattern, options } = formState;
	const { targetCollection, allowMultiple, relation, relationSide } = formState;
	const setField = <K extends keyof FieldFormState>(key: K, value: FieldFormState[K]) =>
		setFormState((prev) => ({ ...prev, [key]: value }));
	const {
		data: blockTypes = [],
		isLoading: blockTypesLoading,
		error: blockTypesError,
	} = useQuery({
		queryKey: ["schema", "block-types"],
		queryFn: fetchBlockTypes,
		enabled: open && selectedType === "blocks",
	});

	// Only a reference field already bound to a relation has an immutable target;
	// one that predates relations is still waiting for its first.
	const isBoundReference = typeof field?.validation?.relation === "string";

	// Relations this collection can still bind a field to, with the ends that
	// are free. A relation whose every matching end already has a field is left
	// out: two pickers over one link set have no defined merge.
	const bindableRelations = React.useMemo(
		() =>
			collectionSlug
				? allRelations
						.map((rel) => ({ relation: rel, sides: freeSidesFor(rel, collectionSlug) }))
						.filter((candidate) => candidate.sides.length > 0)
				: [],
		[allRelations, collectionSlug],
	);

	const selectedRelation = bindableRelations.find((c) => c.relation.slug === relation);
	// The side is only a genuine choice when both ends of the relation are this
	// collection and both are free — a self-referential relation such as related
	// posts. Anywhere else the matching end decides it.
	const sideIsAChoice = (selectedRelation?.sides.length ?? 0) > 1;
	const derivedSide = selectedRelation?.sides[0] ?? "parent";
	const effectiveSide = sideIsAChoice ? relationSide : derivedSide;
	const boundTarget = selectedRelation
		? effectiveSide === "parent"
			? selectedRelation.relation.childCollection
			: selectedRelation.relation.parentCollection
		: "";
	const boundRelation = allRelations.find((rel) => rel.slug === field?.validation?.relation);

	// A new reference field is defined by its relationship, so the rest of the
	// dialog waits for one: the relationship is what names the field.
	const referenceNeedsRelation = selectedType === "reference" && !field;
	const showFieldDetails = !referenceNeedsRelation || Boolean(selectedRelation);
	const isCreatingRelation = referenceNeedsRelation && relation === CREATE_RELATION;
	const isRelationStep = step === "relation";
	const boundToRelation = Boolean(relation) && relation !== CREATE_RELATION;

	// Build field types inside the component so t`` works
	const FIELD_TYPES: FieldTypeConfig[] = [
		{
			type: "string",
			label: t`Short Text`,
			description: t`Single line text input`,
			icon: TextT,
		},
		{
			type: "text",
			label: t`Long Text`,
			description: t`Multi-line plain text`,
			icon: TextAlignLeft,
		},
		{
			type: "number",
			label: t`Number`,
			description: t`Decimal number`,
			icon: Hash,
		},
		{
			type: "integer",
			label: t`Integer`,
			description: t`Whole number`,
			icon: Hash,
		},
		{
			type: "boolean",
			label: t`Boolean`,
			description: t`True/false toggle`,
			icon: ToggleLeft,
		},
		{
			type: "datetime",
			label: t`Date & Time`,
			description: t`Date and time picker`,
			icon: Calendar,
		},
		{
			type: "select",
			label: t`Select`,
			description: t`Single choice from options`,
			icon: List,
		},
		{
			type: "multiSelect",
			label: t`Multi Select`,
			description: t`Multiple choices from options`,
			icon: ListChecks,
		},
		{
			type: "portableText",
			label: t`Rich Text`,
			description: t`Rich text editor`,
			icon: FileText,
		},
		{
			type: "image",
			label: t`Image`,
			description: t`Image from media library`,
			icon: ImageIcon,
		},
		{
			type: "file",
			label: t`File`,
			description: t`File from media library`,
			icon: File,
		},
		{
			type: "reference",
			label: t`Reference`,
			description: t`Link to another content item`,
			icon: LinkSimple,
		},
		{
			type: "json",
			label: t`JSON`,
			description: t`Arbitrary JSON data`,
			icon: BracketsCurly,
		},
		{
			type: "slug",
			label: t`Slug`,
			description: t`URL-friendly identifier`,
			icon: Link,
		},
		{
			type: "url",
			label: t`URL`,
			description: t`Web address`,
			icon: GlobeSimple,
		},
		{
			type: "repeater",
			label: t`Repeater`,
			description: t`Repeating group of fields`,
			icon: Rows,
		},
		{
			type: "blocks",
			label: t`Blocks`,
			description: t`Ordered page-building blocks`,
			icon: Rows,
		},
	];

	// Auto-generate slug from label
	const handleLabelChange = (value: string) => {
		setFormState((prev) => ({
			...prev,
			label: value,
			labelEdited: true,
			// Only auto-generate for new fields
			...(field ? {} : { slug: slugifyLabel(value) }),
		}));
	};

	const handleTypeSelect = (type: FieldType) => {
		setFormState((prev) => ({
			...prev,
			selectedType: type,
			step: "config",
			...(type === "blocks"
				? { required: false, unique: false, searchable: false, indexed: false }
				: {}),
		}));
	};

	const handleRelationChange = (value: string) => {
		setRefError(false);
		setFormState((prev) => {
			const candidate = bindableRelations.find((c) => c.relation.slug === value);
			const side = candidate?.sides[0] ?? "parent";
			return nameAfterRelation(
				{ ...prev, relation: value, relationSide: side },
				candidate?.relation,
				side,
			);
		});
	};

	const handleSideChange = (side: RelationSide) => {
		setFormState((prev) =>
			nameAfterRelation({ ...prev, relationSide: side }, selectedRelation?.relation, side),
		);
	};

	/** Back from the relationship the dialog just made, with it picked. */
	const handleRelationCreated = (created: RelationWithUsage) => {
		setCreatedRelation(created);
		const side = freeSidesFor(created, collectionSlug ?? "")[0] ?? "parent";
		setFormState((prev) =>
			nameAfterRelation(
				{ ...prev, step: "config", relation: created.slug, relationSide: side },
				created,
				side,
			),
		);
	};

	const handleSave = () => {
		if (!selectedType || !slug || !label) return;

		if (selectedType === "reference" && !boundToRelation && !targetCollection) {
			setRefError(true);
			return;
		}

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

		if (selectedType === "repeater") {
			if (formState.subFields.length > 0) {
				(validation as Record<string, unknown>).subFields = formState.subFields.map((sf) => ({
					slug: sf.slug,
					type: sf.type,
					label: sf.label,
					required: sf.required || undefined,
				}));
			}
			if (formState.minItems)
				(validation as Record<string, unknown>).minItems = parseInt(formState.minItems, 10);
			if (formState.maxItems)
				(validation as Record<string, unknown>).maxItems = parseInt(formState.maxItems, 10);
		}

		if (selectedType === "blocks") {
			validation.allowedTypes = formState.allowedTypes;
			if (formState.minItems) validation.minItems = parseInt(formState.minItems, 10);
			if (formState.maxItems) validation.maxItems = parseInt(formState.maxItems, 10);
		}

		if (
			(selectedType === "file" || selectedType === "image") &&
			formState.allowedMimeTypes.length > 0
		) {
			validation.allowedMimeTypes = formState.allowedMimeTypes;
		}

		if (selectedType === "reference") {
			if (boundToRelation) {
				// The relation owns the target and the limits; sending a target
				// collection too would let the two disagree.
				validation.relation = relation;
				validation.relationSide = effectiveSide;
			} else {
				validation.targetCollection = targetCollection;
				validation.multiple = allowMultiple;
			}
		}

		// Only include searchable for text-based fields
		const isSearchableType = isSearchableFieldType(selectedType);
		const isIndexableType = isIndexableFieldType(selectedType);

		const input: CreateFieldInput = {
			slug,
			label,
			type: selectedType,
			required,
			unique,
			searchable: isSearchableType ? searchable : undefined,
			indexed: isIndexableType ? indexed : false,
			validation: Object.keys(validation).length > 0 ? validation : null,
		};

		if (selectedType === "image") {
			const widgetOptions: Record<string, unknown> = { ...field?.options };
			delete widgetOptions.darkVariant;
			if (formState.darkVariant) widgetOptions.darkVariant = true;
			input.options = widgetOptions;
		}

		onSave(input);
	};

	const typeConfig = FIELD_TYPES.find((fieldType) => fieldType.type === selectedType);

	// The relationship step is the relation dialog, in this dialog's frame:
	// same header, same scroll area, same actions as defining one anywhere else.
	if (isRelationStep && onCreateRelation) {
		return (
			<Dialog.Root open={open} onOpenChange={onOpenChange}>
				<Dialog size="lg" className={RELATION_DIALOG_CLASS} style={RELATION_DIALOG_STYLE}>
					<RelationFormPanel
						collections={collections}
						defaultParentCollection={collectionSlug}
						onSubmit={async (input) => {
							const created = await onCreateRelation(input);
							handleRelationCreated({ ...created, boundFields: [], linkCount: 0 });
						}}
						cancelLabel={t`Back`}
						onCancel={() => setField("step", "config")}
						headerAction={
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="ghost" shape="square" aria-label={t`Close`}>
										<X className="h-4 w-4" />
									</Button>
								)}
							/>
						}
					/>
				</Dialog>
			</Dialog.Root>
		);
	}

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
								className="absolute end-4 top-4"
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
										"flex items-start space-x-3 p-4 rounded-lg border text-start transition-colors hover:border-kumo-brand hover:bg-kumo-tint/50",
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
					<div
						className="space-y-6 max-h-[60vh] overflow-y-auto"
						data-testid="field-editor-config-content"
					>
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
										className="ms-auto"
										onClick={() => setField("step", "type")}
									>
										{t`Change`}
									</Button>
								)}
							</div>
						)}

						{/* The relationship a new reference field views, chosen before the
						    field itself: it decides what the field is called, what it
						    points at, and how many entries it holds. */}
						{referenceNeedsRelation && (
							<div className="flex flex-col gap-4">
								<h4 className="font-medium text-sm">{t`Reference`}</h4>

								<Select
									label={t`Relationship`}
									value={relation}
									onValueChange={(v) => handleRelationChange(v ?? "")}
									items={[
										...bindableRelations.map(({ relation: rel }) => ({
											label: rel.slug,
											value: rel.slug,
										})),
										...(onCreateRelation
											? [{ label: t`Create relation`, value: CREATE_RELATION }]
											: []),
									]}
									placeholder={t`Select a relationship`}
									error={refError ? t`A relationship is required` : undefined}
								/>

								{selectedRelation && (
									<>
										<Select
											label={t`Referenced collection`}
											value={boundTarget}
											onValueChange={() => undefined}
											items={collections.map((c) => ({ label: c.label, value: c.slug }))}
											disabled
										/>
										{sideIsAChoice && (
											<div className="flex items-end gap-1.5">
												<Select
													label={t`This field picks`}
													value={effectiveSide}
													onValueChange={(v) =>
														handleSideChange(v === "child" ? "child" : "parent")
													}
													items={{
														parent: t`Entries this one links to`,
														child: t`Entries that link to this one`,
													}}
												/>
												<SideTooltip />
											</div>
										)}
										<div className="flex items-center gap-1.5">
											<SideNote relation={selectedRelation.relation} side={effectiveSide} />
											{!sideIsAChoice && <SideTooltip />}
										</div>
										<p className="text-xs text-kumo-subtle">
											{t`The relationship decides the referenced collection and how many entries this field accepts.`}
										</p>
									</>
								)}
							</div>
						)}

						{showFieldDetails && (
							<>
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
									{selectedType !== "blocks" && (
										<>
											<Switch
												checked={required}
												onCheckedChange={(checked) => setField("required", checked)}
												label={<span className="text-sm">{t`Required`}</span>}
											/>
											<Switch
												checked={unique}
												onCheckedChange={(checked) => setField("unique", checked)}
												label={<span className="text-sm">{t`Unique`}</span>}
											/>
										</>
									)}
									{isSearchableFieldType(selectedType) && (
										<Switch
											checked={searchable}
											onCheckedChange={(checked) => setField("searchable", checked)}
											label={<span className="text-sm">{t`Searchable`}</span>}
										/>
									)}
									{isIndexableFieldType(selectedType) && (
										<Switch
											checked={indexed}
											onCheckedChange={(checked) => setField("indexed", checked)}
											label={<span className="text-sm">{t`Indexed`}</span>}
										/>
									)}
								</div>
							</>
						)}

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
								placeholder={t`Option 1\nOption 2\nOption 3`}
								rows={5}
							/>
						)}

						{selectedType === "reference" && field && (
							<div className="flex flex-col gap-4">
								<h4 className="font-medium text-sm">{t`Reference`}</h4>

								{isBoundReference ? (
									<>
										<Select
											label={t`Relationship`}
											value={field?.validation?.relation ?? ""}
											onValueChange={() => undefined}
											items={{
												[field?.validation?.relation ?? ""]: field?.validation?.relation ?? "",
											}}
											disabled
										/>
										<Select
											label={t`Referenced collection`}
											value={targetCollection}
											onValueChange={() => undefined}
											items={collections.map((c) => ({ label: c.label, value: c.slug }))}
											disabled
										/>
										<SideNote
											relation={boundRelation}
											side={field?.validation?.relationSide ?? "parent"}
										/>
										<p className="text-xs text-kumo-subtle">
											{t`The relationship and the referenced collection cannot be changed after creation. How many entries this field accepts is set on the relationship.`}
										</p>
									</>
								) : (
									<>
										<Select
											label={t`Relationship`}
											value={relation}
											onValueChange={(v) => handleRelationChange(v ?? "")}
											items={[
												{ label: t`Quick create a relationship`, value: "" },
												...bindableRelations.map(({ relation: rel }) => ({
													label: rel.slug,
													value: rel.slug,
												})),
											]}
										/>

										{relation ? (
											<>
												<Select
													label={t`Referenced collection`}
													value={boundTarget}
													onValueChange={() => undefined}
													items={collections.map((c) => ({ label: c.label, value: c.slug }))}
													disabled
												/>
												{sideIsAChoice && (
													<div className="flex items-end gap-1.5">
														<Select
															label={t`This field picks`}
															value={effectiveSide}
															onValueChange={(v) =>
																handleSideChange(v === "child" ? "child" : "parent")
															}
															items={{
																parent: t`Entries this one links to`,
																child: t`Entries that link to this one`,
															}}
														/>
														<SideTooltip />
													</div>
												)}
												<div className="flex items-center gap-1.5">
													<SideNote relation={selectedRelation?.relation} side={effectiveSide} />
													{!sideIsAChoice && <SideTooltip />}
												</div>
												<p className="text-xs text-kumo-subtle">
													{t`The relationship decides the referenced collection and how many entries this field accepts.`}
												</p>
											</>
										) : (
											<>
												<Select
													label={t`Referenced collection`}
													value={targetCollection}
													onValueChange={(v) => {
														setField("targetCollection", v ?? "");
														setRefError(false);
													}}
													items={collections.map((c) => ({ label: c.label, value: c.slug }))}
													placeholder={t`Select a collection`}
													error={refError ? t`Referenced collection is required` : undefined}
												/>
												{field && (
													<p className="text-xs text-kumo-subtle">
														{t`Saving a collection here turns this field into an entry picker. Its stored entry IDs move to the relationship, and the field can no longer be searched or filtered on.`}
													</p>
												)}
												<Switch
													checked={allowMultiple}
													onCheckedChange={(checked) => setField("allowMultiple", checked)}
													label={<span className="text-sm">{t`Allow multiple references`}</span>}
												/>
												<p className="text-xs text-kumo-subtle">
													<Trans>
														Quick create names the relationship after this field and this
														collection, takes how many entries it holds from the switch above, and
														puts no limit on how many entries link back the other way.{" "}
														<RouterLink
															to="/content-types/relations"
															target="_blank"
															className="text-kumo-link underline"
														>
															Create the relationship yourself
														</RouterLink>{" "}
														to set its slug, the name each side goes by, and both limits, then pick
														it above.
													</Trans>
												</p>
											</>
										)}
									</>
								)}
							</div>
						)}

						{selectedType === "blocks" && (
							<div className="space-y-4">
								<div>
									<h4 className="font-medium text-sm">{t`Allowed block types`}</h4>
									<p className="text-xs text-kumo-subtle">
										{t`The order controls how block types appear in the picker.`}
									</p>
								</div>
								{blockTypesLoading ? (
									<p className="text-sm text-kumo-subtle">{t`Loading block types…`}</p>
								) : blockTypesError ? (
									<p className="rounded-lg border border-kumo-danger/50 p-4 text-sm text-kumo-danger">
										{t`Block types could not be loaded.`}
									</p>
								) : blockTypes.length === 0 ? (
									<p className="rounded-lg border border-dashed p-4 text-sm text-kumo-subtle">
										{t`Create a block type before adding a blocks field.`}
									</p>
								) : (
									<div className="space-y-2">
										{blockTypes.map((blockType) => {
											const selectedIndex = formState.allowedTypes.indexOf(blockType.slug);
											const selected = selectedIndex !== -1;
											const retired = formState.retiredTypes.includes(blockType.slug);
											return (
												<div
													key={blockType.slug}
													className="rounded-lg border border-kumo-line p-3"
												>
													<div className="flex items-center gap-2">
														<Checkbox
															label={blockType.label}
															checked={selected}
															disabled={retired && !selected}
															onCheckedChange={(checked) => {
																setField(
																	"allowedTypes",
																	checked
																		? [...formState.allowedTypes, blockType.slug]
																		: formState.allowedTypes.filter(
																				(candidateSlug) => candidateSlug !== blockType.slug,
																			),
																);
															}}
														/>
														<code className="text-xs text-kumo-subtle">{blockType.slug}</code>
														{retired && <Badge variant="secondary">{t`Retired`}</Badge>}
														{selected && (
															<div className="ms-auto flex gap-1">
																<Button
																	variant="ghost"
																	shape="square"
																	size="sm"
																	disabled={selectedIndex === 0}
																	onClick={() => {
																		const next = [...formState.allowedTypes];
																		[next[selectedIndex - 1], next[selectedIndex]] = [
																			next[selectedIndex]!,
																			next[selectedIndex - 1]!,
																		];
																		setField("allowedTypes", next);
																	}}
																	aria-label={t`Move ${blockType.label} up`}
																>
																	<ArrowUp className="h-4 w-4" />
																</Button>
																<Button
																	variant="ghost"
																	shape="square"
																	size="sm"
																	disabled={selectedIndex === formState.allowedTypes.length - 1}
																	onClick={() => {
																		const next = [...formState.allowedTypes];
																		[next[selectedIndex], next[selectedIndex + 1]] = [
																			next[selectedIndex + 1]!,
																			next[selectedIndex]!,
																		];
																		setField("allowedTypes", next);
																	}}
																	aria-label={t`Move ${blockType.label} down`}
																>
																	<ArrowDown className="h-4 w-4" />
																</Button>
															</div>
														)}
													</div>
													<div className="mt-2 flex flex-wrap gap-2">
														{blockType.versions.map((version) => (
															<span key={version.version} className="text-xs text-kumo-subtle">
																{version.active
																	? t`Active v${version.version}`
																	: t`v${version.version}`}{" "}
																· <code>{version.fingerprint.slice(-8)}</code>
															</span>
														))}
													</div>
												</div>
											);
										})}
									</div>
								)}
								<div className="grid grid-cols-2 gap-4">
									<Input
										label={t`Minimum blocks`}
										type="number"
										min={0}
										value={formState.minItems}
										onChange={(event) => setField("minItems", event.target.value)}
										placeholder="0"
									/>
									<Input
										label={t`Maximum blocks`}
										type="number"
										min={1}
										max={100}
										value={formState.maxItems}
										onChange={(event) => setField("maxItems", event.target.value)}
										placeholder="100"
									/>
								</div>
							</div>
						)}

						{selectedType === "repeater" && (
							<div className="space-y-4">
								<div className="flex items-center justify-between">
									<h4 className="font-medium text-sm">{t`Sub-Fields`}</h4>
									<Button
										variant="outline"
										size="sm"
										icon={<Plus />}
										onClick={() =>
											setFormState((prev) => ({
												...prev,
												subFields: [
													...prev.subFields,
													{ slug: "", type: "string", label: "", required: false },
												],
											}))
										}
									>
										{t`Add Sub-Field`}
									</Button>
								</div>

								{formState.subFields.length === 0 && (
									<p className="text-sm text-kumo-subtle text-center py-4">
										{t`Add at least one sub-field to define the repeater structure.`}
									</p>
								)}

								{formState.subFields.map((sf, i) => (
									<div key={i} className="flex gap-2 items-start border rounded-lg p-3">
										<div className="flex-1 space-y-2">
											<div className="grid grid-cols-2 gap-2">
												<Input
													label={t`Label`}
													value={sf.label}
													onChange={(e) => {
														const updated = [...formState.subFields];
														updated[i] = {
															...sf,
															label: e.target.value,
															slug: e.target.value
																.toLowerCase()
																.replace(SLUG_INVALID_CHARS_REGEX, "_")
																.replace(SLUG_LEADING_TRAILING_REGEX, ""),
														};
														setFormState((prev) => ({ ...prev, subFields: updated }));
													}}
													placeholder={t`Field label`}
												/>
												<div>
													<Select
														label={t`Type`}
														value={sf.type}
														onValueChange={(v) => {
															const updated = [...formState.subFields];
															updated[i] = { ...sf, type: v ?? "string" };
															setFormState((prev) => ({ ...prev, subFields: updated }));
														}}
														items={{
															string: t`Short Text`,
															text: t`Long Text`,
															number: t`Number`,
															integer: t`Integer`,
															boolean: t`Boolean`,
															datetime: t`Date & Time`,
															select: t`Select`,
															url: t`URL`,
															image: t`Image`,
														}}
													/>
												</div>
											</div>
											<Switch
												label={t`Required`}
												checked={sf.required ?? false}
												onCheckedChange={(checked) => {
													const updated = [...formState.subFields];
													updated[i] = { ...sf, required: checked };
													setFormState((prev) => ({ ...prev, subFields: updated }));
												}}
											/>
										</div>
										<Button
											variant="ghost"
											shape="square"
											onClick={() =>
												setFormState((prev) => ({
													...prev,
													subFields: prev.subFields.filter((_, j) => j !== i),
												}))
											}
											aria-label={t`Remove sub-field`}
										>
											<Trash className="h-4 w-4 text-kumo-danger" />
										</Button>
									</div>
								))}

								<div className="grid grid-cols-2 gap-4">
									<Input
										label={t`Min Items`}
										type="number"
										value={formState.minItems}
										onChange={(e) => setField("minItems", e.target.value)}
										placeholder="0"
									/>
									<Input
										label={t`Max Items`}
										type="number"
										value={formState.maxItems}
										onChange={(e) => setField("maxItems", e.target.value)}
										placeholder={t`No limit`}
									/>
								</div>
							</div>
						)}

						{(selectedType === "file" || selectedType === "image") && (
							<AllowedTypesEditor
								value={formState.allowedMimeTypes}
								onChange={(next) => setField("allowedMimeTypes", next)}
							/>
						)}

						{selectedType === "image" && (
							<div className="grid gap-1">
								<Switch
									checked={formState.darkVariant}
									onCheckedChange={(checked) => setField("darkVariant", checked)}
									label={<span className="text-sm">{t`Dark mode variant`}</span>}
								/>
								<p className="text-xs text-kumo-subtle">
									{t`Editors can select a second image that the site shows in dark mode.`}
								</p>
							</div>
						)}
					</div>
				)}

				{step === "config" && (
					<div className="flex flex-col-reverse gap-2 py-2 sm:flex-row sm:justify-end sm:space-x-2">
						<Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
							{t`Cancel`}
						</Button>
						{isCreatingRelation ? (
							<Button onClick={() => setField("step", "relation")}>{t`Next`}</Button>
						) : (
							<Button
								onClick={handleSave}
								disabled={
									!slug ||
									!label ||
									isSaving ||
									(selectedType === "repeater" && formState.subFields.length === 0)
								}
							>
								{isSaving ? t`Saving...` : field ? t`Update Field` : t`Add Field`}
							</Button>
						)}
					</div>
				)}
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * States what the field will hold, in the names the relation gives its two
 * sides: "the Lessons this Chapter links to", or "the Chapter linking to this
 * Lesson". Falls back to the generic wording until a relation is known.
 */
function SideNote({ relation, side }: { relation?: RelationWithUsage; side: RelationSide }) {
	const { t } = useLingui();

	if (!relation) {
		return (
			<p className="text-sm">
				{side === "parent"
					? t`This field picks entries this one links to.`
					: t`This field lists entries that link to this one.`}
			</p>
		);
	}

	const linkingSide = sideSingular(relation, "parent");
	const linkedSide = sideSingular(relation, "child");

	return (
		<p className="text-sm">
			{side === "parent" ? (
				<Trans>
					This field will show the <strong>{relation.childLabel}</strong> this {linkingSide} links
					to
				</Trans>
			) : (
				<Trans>
					This field will show the <strong>{linkingSide}</strong> linking to this {linkedSide}
				</Trans>
			)}
		</p>
	);
}

/** Explains what the side costs: only the linking end orders its selection,
 * because a link's position is scoped to the entry that made it. */
function SideTooltip() {
	const { t } = useLingui();
	return (
		<Tooltip
			content={
				<span className="block max-w-64 text-pretty">
					{t`Picking entries this one links to lets editors drag them into an order. The other direction lists whatever points at the entry and cannot be reordered.`}
				</span>
			}
			delay={0}
			closeDelay={0}
			render={
				<Button
					type="button"
					variant="ghost"
					shape="square"
					size="xs"
					icon={<Info aria-hidden="true" />}
					className="text-kumo-subtle hover:text-kumo-default ms-1"
					aria-label={t`What the direction changes`}
				/>
			}
		/>
	);
}
