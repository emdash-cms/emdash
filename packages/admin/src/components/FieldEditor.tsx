import {
	Badge,
	Button,
	Checkbox,
	Input,
	InputArea,
	LayerDialog,
	Select,
	Switch,
} from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
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
	ArrowUp,
	ArrowDown,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import * as React from "react";

import { fetchCollections, fetchRelations } from "../lib/api";
import type { FieldType, CreateFieldInput, SchemaField } from "../lib/api";
import { ApiResponseError } from "../lib/api/client.js";
import type {
	CreateRelationInput,
	RelationDef,
	RelationSide,
	RelationWithUsage,
} from "../lib/api/relations.js";
import { fetchBlockTypes } from "../lib/api/schema.js";
import {
	focusFirstInvalid,
	guardUnsavedInput,
	revealErrors,
	useSingleFlight,
	useValueAtFailure,
} from "../lib/dialog-form.js";
import { singularize } from "../lib/singularize.js";
import { cn, slugifyIdentifier } from "../lib/utils";
import { AllowedTypesEditor, draftProblem, expandShorthand } from "./AllowedTypesEditor";
import { DialogError, getMutationError } from "./DialogError";
import { DialogSection } from "./DialogSection.js";
import { HelpLabel, HelpTooltip } from "./FieldHelpLabel.js";
import { RelationDialog } from "./RelationDialog.js";

// ============================================================================
// Constants
// ============================================================================

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
	return { ...state, label, slug: slugifyIdentifier(label) };
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
	/** Return the save's promise so a second submit waits for it. */
	onSave: (input: CreateFieldInput) => void | Promise<unknown>;
	isSaving?: boolean;
	/** The error a save was rejected with, as thrown. One the dialog can pin on
	 * a field shows there; any other shows below the form. */
	saveError?: unknown;
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
	slugEdited: boolean;
	slugPersisted: boolean;
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
	/** A type typed into the allowed types but not added to them yet. */
	mimeDraft: string;
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
				? ((field.validation as Record<string, unknown>).subFields as RepeaterSubFieldState[]).map(
						(sf) => ({ ...sf, slugEdited: true, slugPersisted: true }),
					)
				: [],
			minItems: (field.validation as Record<string, unknown>)?.minItems?.toString() ?? "",
			maxItems: (field.validation as Record<string, unknown>)?.maxItems?.toString() ?? "",
			allowedMimeTypes: field.validation?.allowedMimeTypes ?? [],
			mimeDraft: "",
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
		mimeDraft: "",
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

/** The inputs that can keep a field from saving. */
const FIELD_INPUTS = [
	"relation",
	"targetCollection",
	"label",
	"slug",
	"minLength",
	"maxLength",
	"pattern",
	"min",
	"max",
	"options",
	"subFields",
	"allowedTypes",
	"minItems",
	"maxItems",
	"mimeDraft",
] as const;

type FieldInput = (typeof FIELD_INPUTS)[number];

type SubFieldInput = "label" | "slug";

interface FormProblems {
	fields: Partial<Record<FieldInput, MessageDescriptor>>;
	/** By the sub-field's position. */
	subFields: Partial<Record<SubFieldInput, MessageDescriptor>>[];
}

interface ProblemContext {
	isNew: boolean;
	/** A new reference field still has to pick the relationship it views. */
	relationMissing: boolean;
	/** An unbound reference field still names no collection to point at. */
	targetMissing: boolean;
	/** Whether the label, slug and switches are on screen. */
	detailsShown: boolean;
	/** Whether a blocks field lists block types to choose from, or is still
	 * fetching them. When there are none, the notice in their place explains. */
	blockTypesOffered: boolean;
}

const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const SLUG_MAX_LENGTH = 63;
const MAX_BLOCKS_ITEMS = 100;

const ENTER_SLUG = msg`Enter a slug.`;
const ENTER_LABEL = msg`Enter a label.`;
const AT_LEAST_ZERO = msg`Enter a whole number of 0 or more.`;
const NOT_A_NUMBER = msg`Enter a number.`;
const MAXIMUM_BELOW_MINIMUM = msg`Enter a maximum that is at least the minimum.`;
const AT_MOST_BLOCKS = msg`Enter a number of 100 or less.`;

function slugFormatProblem(slug: string): MessageDescriptor | undefined {
	if (!SLUG_PATTERN.test(slug)) {
		return msg`Use lowercase letters, numbers, and underscores, starting with a letter.`;
	}
	if (slug.length > SLUG_MAX_LENGTH) return msg`Use 63 characters or fewer.`;
	return undefined;
}

/** A limit as typed: `undefined` when empty, and `NaN` when it isn't a whole number. */
function wholeNumber(value: string): number | undefined {
	if (!value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function belowOrNaN(value: number | undefined, min: number): boolean {
	return value !== undefined && (Number.isNaN(value) || value < min);
}

/**
 * The names of the number inputs in `form` that show text that isn't a number.
 * Such an input reads as empty, so the limit typed into it would be dropped.
 */
function unreadableNumbers(form: HTMLFormElement): Set<string> {
	const names = new Set<string>();
	for (const input of form.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
		if (input.validity.badInput) names.add(input.name);
	}
	return names;
}

function isValidPattern(pattern: string): boolean {
	try {
		void new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

function optionList(options: string): string[] {
	return options
		.split("\n")
		.map((o) => o.trim())
		.filter(Boolean);
}

/**
 * Checks item limits as the server does, which puts a clash between them on
 * the maximum. A blocks field also caps both at `MAX_BLOCKS_ITEMS`.
 */
function checkItemLimits(fields: FormProblems["fields"], state: FieldFormState, capped: boolean) {
	const minItems = wholeNumber(state.minItems);
	const maxItems = wholeNumber(state.maxItems);
	if (belowOrNaN(minItems, 0)) fields.minItems = AT_LEAST_ZERO;
	else if (capped && minItems !== undefined && minItems > MAX_BLOCKS_ITEMS) {
		fields.minItems = AT_MOST_BLOCKS;
	}
	if (belowOrNaN(maxItems, 1)) fields.maxItems = msg`Enter a whole number of 1 or more.`;
	else if (capped && maxItems !== undefined && maxItems > MAX_BLOCKS_ITEMS) {
		fields.maxItems = AT_MOST_BLOCKS;
	} else if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
		fields.maxItems = MAXIMUM_BELOW_MINIMUM;
	}
}

/** What keeps the form from saving, matching what the server would reject. */
function formProblems(state: FieldFormState, context: ProblemContext): FormProblems {
	const fields: FormProblems["fields"] = {};
	const type = state.selectedType;

	if (context.relationMissing) fields.relation = msg`Choose a relationship.`;
	if (context.targetMissing) fields.targetCollection = msg`Choose a collection.`;

	if (context.detailsShown) {
		const label = state.label.trim();
		if (!label) fields.label = ENTER_LABEL;
		if (context.isNew) {
			const slug = state.slug
				? slugFormatProblem(state.slug)
				: !label
					? // The slug follows the label, which already carries the error.
						undefined
					: slugifyIdentifier(state.label)
						? ENTER_SLUG
						: msg`A slug cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.`;
			if (slug) fields.slug = slug;
		}
	}

	if (type === "string" || type === "text" || type === "slug") {
		const minLength = wholeNumber(state.minLength);
		const maxLength = wholeNumber(state.maxLength);
		if (belowOrNaN(minLength, 0)) fields.minLength = AT_LEAST_ZERO;
		if (belowOrNaN(maxLength, 0)) fields.maxLength = AT_LEAST_ZERO;
		else if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
			fields.maxLength = MAXIMUM_BELOW_MINIMUM;
		}
		if (type === "string" && state.pattern && !isValidPattern(state.pattern)) {
			fields.pattern = msg`Enter a valid regular expression.`;
		}
	}

	if (type === "number" || type === "integer") {
		const min = state.min ? parseFloat(state.min) : undefined;
		const max = state.max ? parseFloat(state.max) : undefined;
		if (min !== undefined && max !== undefined && min > max) fields.max = MAXIMUM_BELOW_MINIMUM;
	}

	if (
		context.isNew &&
		(type === "select" || type === "multiSelect") &&
		optionList(state.options).length === 0
	) {
		fields.options = msg`Add at least one option.`;
	}

	const subFields: FormProblems["subFields"] = [];
	if (type === "repeater") {
		if (state.subFields.length === 0) {
			fields.subFields = msg`Add at least one sub-field to define the repeater structure.`;
		}
		state.subFields.forEach((sf, index) => {
			const problems: FormProblems["subFields"][number] = {};
			const label = sf.label.trim();
			if (!label) problems.label = ENTER_LABEL;
			if (!sf.slug) {
				if (sf.slugEdited) problems.slug = ENTER_SLUG;
				else if (label) {
					problems.slug = msg`A slug cannot be generated from this label. Type one manually.`;
				}
			} else if (!sf.slugPersisted) {
				const format = slugFormatProblem(sf.slug);
				if (format) problems.slug = format;
				else if (state.subFields.findIndex((other) => other.slug === sf.slug) !== index) {
					problems.slug = msg`Another sub-field already uses this slug. Enter a different one.`;
				}
			}
			subFields[index] = problems;
		});
		checkItemLimits(fields, state, false);
	}

	if (type === "blocks") {
		if (context.isNew && context.blockTypesOffered && state.allowedTypes.length === 0) {
			fields.allowedTypes = msg`Choose at least one block type.`;
		}
		checkItemLimits(fields, state, true);
	}

	if (type === "file" || type === "image") {
		const unmapped = draftProblem(state.mimeDraft);
		if (unmapped) fields.mimeDraft = unmapped;
	}

	return { fields, subFields };
}

/** The message for a slug the server turned down, when that was the reason. */
function slugRejection(error: unknown): MessageDescriptor | undefined {
	if (!(error instanceof ApiResponseError)) return undefined;
	if (error.code === "FIELD_EXISTS") {
		return msg`Another field already uses this slug. Enter a different one.`;
	}
	if (error.code === "RESERVED_SLUG") return msg`This slug is reserved. Enter a different one.`;
	return undefined;
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
	saveError,
	collectionSlug,
	onCreateRelation,
}: FieldEditorProps) {
	const { t } = useLingui();
	const [formState, setFormState] = React.useState(() => getInitialFormState(field));
	const formId = React.useId();
	const subFieldsErrorId = React.useId();
	const allowedTypesErrorId = React.useId();
	const formRef = React.useRef<HTMLFormElement>(null);
	const [submitted, setSubmitted] = React.useState(false);
	// The form as last sent, which a rejection of that save is about.
	const [sent, setSent] = React.useState<FieldFormState | null>(null);
	// Number inputs that showed text that isn't a number at the last submit.
	const [unreadable, setUnreadable] = React.useState<ReadonlySet<string>>(() => new Set());
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
			setSubmitted(false);
			setSent(null);
			setUnreadable(new Set());
			setCreatedRelation(null);
		}
	}, [open, field]);

	const initialSnapshot = React.useMemo(() => JSON.stringify(getInitialFormState(field)), [field]);
	const unsaved = JSON.stringify(formState) !== initialSnapshot;

	// A close mid-save would hand the in-flight save's completion handler a
	// dialog now showing a different field, discarding whatever it has typed.
	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen && isSaving) return;
		onOpenChange(nextOpen);
	};

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
			...(field ? {} : { slug: slugifyIdentifier(value) }),
		}));
	};

	const handleTypeSelect = (type: FieldType) => {
		setUnreadable(new Set());
		setFormState((prev) => ({
			...prev,
			selectedType: type,
			step: "config",
			// Long text and slug fields send a pattern too, but have no input showing it.
			...(type === "string" ? {} : { pattern: "" }),
			...(type === "blocks"
				? { required: false, unique: false, searchable: false, indexed: false }
				: {}),
		}));
	};

	const handleRelationChange = (value: string) => {
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

	const problems = formProblems(formState, {
		isNew: !field,
		relationMissing: referenceNeedsRelation && !selectedRelation,
		targetMissing:
			selectedType === "reference" && Boolean(field) && !boundToRelation && !targetCollection,
		detailsShown: showFieldDetails,
		blockTypesOffered: !blockTypesError && (blockTypesLoading || blockTypes.length > 0),
	});
	// The form as it stood when the failed save came back.
	const failedState = useValueAtFailure(saveError, formState);
	// A slug edited while the save ran isn't the one refused, so its refusal stays in the banner.
	const slugRefusal =
		sent && failedState?.slug === sent.slug && !field ? slugRejection(saveError) : undefined;
	if (slugRefusal && slug === sent?.slug) problems.fields.slug = slugRefusal;
	const hasProblems =
		Object.keys(problems.fields).length > 0 ||
		problems.subFields.some((subField) => subField.label || subField.slug);

	const errors: Partial<Record<FieldInput, string>> = {};
	const subFieldErrors: Partial<Record<SubFieldInput, string>>[] = [];
	if (submitted) {
		for (const key of FIELD_INPUTS) {
			const message = unreadable.has(key) ? NOT_A_NUMBER : problems.fields[key];
			if (message) errors[key] = t(message);
		}
		problems.subFields.forEach((subField, index) => {
			subFieldErrors[index] = {
				label: subField.label && t(subField.label),
				slug: subField.slug && t(subField.slug),
			};
		});
	}

	// Any change after a failed save came back may be the fix, so its message stops applying.
	const bannerError =
		slugRefusal || (failedState && formState !== failedState)
			? null
			: typeof saveError === "string"
				? saveError
				: getMutationError(saveError);

	// The action that started the save was disabled while it ran, so focus has
	// to be put back on the field the server turned down.
	const slugRefused = Boolean(slugRefusal);
	React.useEffect(() => {
		if (slugRefused) focusFirstInvalid(formRef.current);
	}, [saveError, slugRefused]);

	const submitSave = useSingleFlight((input: CreateFieldInput) => Promise.resolve(onSave(input)));

	const handleNumberInput = (event: React.FormEvent<HTMLFormElement>) => {
		const input = event.target;
		if (!(input instanceof HTMLInputElement) || !unreadable.has(input.name)) return;
		if (input.validity.badInput) return;
		setUnreadable((prev) => {
			const next = new Set(prev);
			next.delete(input.name);
			return next;
		});
	};

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSaving || !selectedType) return;
		const form = event.currentTarget;
		const unreadableNow = unreadableNumbers(form);
		if (hasProblems || unreadableNow.size > 0) {
			revealErrors(form, () => {
				setSubmitted(true);
				setUnreadable(unreadableNow);
			});
			return;
		}
		setSubmitted(true);
		const typedMime =
			selectedType === "file" || selectedType === "image"
				? expandShorthand(formState.mimeDraft)
				: null;
		// A type left in the input counts as added, as it would be on Add.
		const state =
			typedMime === null
				? formState
				: {
						...formState,
						mimeDraft: "",
						allowedMimeTypes: formState.allowedMimeTypes.includes(typedMime)
							? formState.allowedMimeTypes
							: [...formState.allowedMimeTypes, typedMime],
					};
		if (state !== formState) setFormState(state);
		setSent(state);

		const validation: CreateFieldInput["validation"] = {};

		// Build validation based on field type
		if (selectedType === "string" || selectedType === "text" || selectedType === "slug") {
			if (minLength) validation.minLength = wholeNumber(minLength);
			if (maxLength) validation.maxLength = wholeNumber(maxLength);
			if (pattern) validation.pattern = pattern;
		}

		if (selectedType === "number" || selectedType === "integer") {
			if (min) validation.min = parseFloat(min);
			if (max) validation.max = parseFloat(max);
		}

		if (selectedType === "select" || selectedType === "multiSelect") {
			validation.options = optionList(options);
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
				(validation as Record<string, unknown>).minItems = wholeNumber(formState.minItems);
			if (formState.maxItems)
				(validation as Record<string, unknown>).maxItems = wholeNumber(formState.maxItems);
		}

		if (selectedType === "blocks") {
			validation.allowedTypes = formState.allowedTypes;
			if (formState.minItems) validation.minItems = wholeNumber(formState.minItems);
			if (formState.maxItems) validation.maxItems = wholeNumber(formState.maxItems);
		}

		if (
			(selectedType === "file" || selectedType === "image") &&
			state.allowedMimeTypes.length > 0
		) {
			validation.allowedMimeTypes = state.allowedMimeTypes;
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

		submitSave(input);
	};

	const typeConfig = FIELD_TYPES.find((fieldType) => fieldType.type === selectedType);

	const slugUnderivable = !field && !slug && label.trim().length > 0 && !slugifyIdentifier(label);

	return (
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(unsaved, handleOpenChange)}
			dismissDisabled={isSaving}
		>
			<LayerDialog.Content size="lg">
				<LayerDialog.Title>
					{field ? t`Edit Field` : step === "type" ? t`Add Field` : t`Configure Field`}
				</LayerDialog.Title>
				<LayerDialog.Description>
					{field
						? t`Change the field's label and what it accepts.`
						: step === "type"
							? t`Choose what kind of content the field holds.`
							: t`Name the field and choose what it accepts.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					{step === "type" ? (
						<div className="grid grid-cols-2 gap-3">
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
						<form
							id={formId}
							ref={formRef}
							noValidate
							onSubmit={handleSubmit}
							onInput={handleNumberInput}
							className="grid gap-5"
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
								<div className="grid gap-5">
									<div data-field-invalid={errors.relation ? true : undefined}>
										<Select
											label={t`Relationship`}
											className="w-full"
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
											required
											error={errors.relation}
										/>
									</div>

									{selectedRelation && (
										<>
											<Select
												label={
													<HelpLabel
														help={t`The relationship decides the referenced collection and how many entries this field accepts.`}
													>
														{t`Referenced collection`}
													</HelpLabel>
												}
												aria-label={t`Referenced collection`}
												className="w-full"
												value={boundTarget}
												onValueChange={() => undefined}
												items={collections.map((c) => ({ label: c.label, value: c.slug }))}
												disabled
											/>
											{sideIsAChoice && (
												<div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5">
													<Select
														label={t`This field picks`}
														className="w-full"
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
										</>
									)}
								</div>
							)}

							{showFieldDetails && (
								<>
									{/* Basic info */}
									<div
										className={cn(
											"grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-4",
											referenceNeedsRelation && "border-t border-kumo-line pt-5",
										)}
									>
										<Input
											label={t`Label`}
											value={label}
											onChange={(e) => handleLabelChange(e.target.value)}
											placeholder={t`Field Label`}
											required
											error={errors.label}
											aria-invalid={errors.label ? true : undefined}
										/>
										<Input
											dir="ltr"
											label={
												field ? (
													<HelpLabel help={t`Field slugs cannot be changed after creation`}>
														{t`Slug`}
													</HelpLabel>
												) : (
													t`Slug`
												)
											}
											aria-label={t`Slug`}
											value={slug}
											onChange={(e) => setField("slug", e.target.value)}
											placeholder="field_slug"
											disabled={!!field}
											required={!field || undefined}
											description={
												slugUnderivable
													? t`A slug cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.`
													: undefined
											}
											error={errors.slug}
											aria-invalid={errors.slug ? true : undefined}
										/>
									</div>

									{/* Toggles */}
									<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
										{selectedType !== "blocks" && (
											<>
												<Switch
													checked={required}
													onCheckedChange={(checked) => setField("required", checked)}
													label={t`Required`}
												/>
												<Switch
													checked={unique}
													onCheckedChange={(checked) => setField("unique", checked)}
													label={t`Unique`}
												/>
											</>
										)}
										{isSearchableFieldType(selectedType) && (
											<Switch
												checked={searchable}
												onCheckedChange={(checked) => setField("searchable", checked)}
												label={t`Searchable`}
											/>
										)}
										{isIndexableFieldType(selectedType) && (
											<Switch
												checked={indexed}
												onCheckedChange={(checked) => setField("indexed", checked)}
												label={t`Indexed`}
											/>
										)}
									</div>
								</>
							)}

							{/* Type-specific validation */}
							{(selectedType === "string" ||
								selectedType === "text" ||
								selectedType === "slug") && (
								<DialogSection title={t`Validation`}>
									<div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-4">
										<Input
											label={t`Min Length`}
											name="minLength"
											type="number"
											value={minLength}
											onChange={(e) => setField("minLength", e.target.value)}
											placeholder={t`No minimum`}
											error={errors.minLength}
											aria-invalid={errors.minLength ? true : undefined}
										/>
										<Input
											label={t`Max Length`}
											name="maxLength"
											type="number"
											value={maxLength}
											onChange={(e) => setField("maxLength", e.target.value)}
											placeholder={t`No maximum`}
											error={errors.maxLength}
											aria-invalid={errors.maxLength ? true : undefined}
										/>
									</div>
									{selectedType === "string" && (
										<Input
											dir="ltr"
											label={t`Pattern (Regex)`}
											value={pattern}
											onChange={(e) => setField("pattern", e.target.value)}
											placeholder="^[a-z]+$"
											error={errors.pattern}
											aria-invalid={errors.pattern ? true : undefined}
										/>
									)}
								</DialogSection>
							)}

							{(selectedType === "number" || selectedType === "integer") && (
								<DialogSection title={t`Validation`}>
									<div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-4">
										<Input
											label={t`Min Value`}
											name="min"
											type="number"
											value={min}
											onChange={(e) => setField("min", e.target.value)}
											placeholder={t`No minimum`}
											error={errors.min}
											aria-invalid={errors.min ? true : undefined}
										/>
										<Input
											label={t`Max Value`}
											name="max"
											type="number"
											value={max}
											onChange={(e) => setField("max", e.target.value)}
											placeholder={t`No maximum`}
											error={errors.max}
											aria-invalid={errors.max ? true : undefined}
										/>
									</div>
								</DialogSection>
							)}

							{(selectedType === "select" || selectedType === "multiSelect") && (
								<InputArea
									label={t`Options (one per line)`}
									value={options}
									onChange={(e) => setField("options", e.target.value)}
									placeholder={t`Option 1\nOption 2\nOption 3`}
									rows={5}
									required={!field || undefined}
									error={errors.options}
									aria-invalid={errors.options ? true : undefined}
								/>
							)}

							{selectedType === "reference" && field && (
								<DialogSection title={t`Reference`}>
									{isBoundReference ? (
										<>
											<Select
												label={
													<HelpLabel
														help={t`The relationship and the referenced collection cannot be changed after creation. How many entries this field accepts is set on the relationship.`}
													>
														{t`Relationship`}
													</HelpLabel>
												}
												aria-label={t`Relationship`}
												className="w-full"
												value={field?.validation?.relation ?? ""}
												onValueChange={() => undefined}
												items={{
													[field?.validation?.relation ?? ""]: field?.validation?.relation ?? "",
												}}
												disabled
											/>
											<Select
												label={t`Referenced collection`}
												className="w-full"
												value={targetCollection}
												onValueChange={() => undefined}
												items={collections.map((c) => ({ label: c.label, value: c.slug }))}
												disabled
											/>
											<SideNote
												relation={boundRelation}
												side={field?.validation?.relationSide ?? "parent"}
											/>
										</>
									) : (
										<>
											<Select
												label={t`Relationship`}
												className="w-full"
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
														label={
															<HelpLabel
																help={t`The relationship decides the referenced collection and how many entries this field accepts.`}
															>
																{t`Referenced collection`}
															</HelpLabel>
														}
														aria-label={t`Referenced collection`}
														className="w-full"
														value={boundTarget}
														onValueChange={() => undefined}
														items={collections.map((c) => ({ label: c.label, value: c.slug }))}
														disabled
													/>
													{sideIsAChoice && (
														<div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5">
															<Select
																label={t`This field picks`}
																className="w-full"
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
												</>
											) : (
												<>
													<div data-field-invalid={errors.targetCollection ? true : undefined}>
														<Select
															label={t`Referenced collection`}
															className="w-full"
															value={targetCollection}
															onValueChange={(v) => setField("targetCollection", v ?? "")}
															items={collections.map((c) => ({ label: c.label, value: c.slug }))}
															placeholder={t`Select a collection`}
															required
															error={errors.targetCollection}
														/>
													</div>
													{field && (
														<p className="text-xs text-kumo-subtle">
															{t`Saving a collection here turns this field into an entry picker. Its stored entry IDs move to the relationship, and the field can no longer be searched or filtered on.`}
														</p>
													)}
													<Switch
														checked={allowMultiple}
														onCheckedChange={(checked) => setField("allowMultiple", checked)}
														label={t`Allow multiple references`}
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
															to set its slug, the name each side goes by, and both limits, then
															pick it above.
														</Trans>
													</p>
												</>
											)}
										</>
									)}
								</DialogSection>
							)}

							{selectedType === "blocks" && (
								<DialogSection
									title={t`Allowed block types`}
									help={t`The order controls how block types appear in the picker.`}
								>
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
										<div
											className="space-y-2"
											role="group"
											aria-label={t`Allowed block types`}
											aria-describedby={errors.allowedTypes ? allowedTypesErrorId : undefined}
											data-field-invalid={errors.allowedTypes ? true : undefined}
										>
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
															<code dir="ltr" className="text-xs text-kumo-subtle">
																{blockType.slug}
															</code>
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
																	· <code dir="ltr">{version.fingerprint.slice(-8)}</code>
																</span>
															))}
														</div>
													</div>
												);
											})}
										</div>
									)}
									{errors.allowedTypes && (
										<p id={allowedTypesErrorId} className="text-sm leading-snug text-kumo-danger">
											{errors.allowedTypes}
										</p>
									)}
									<div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-4">
										<Input
											label={t`Minimum blocks`}
											name="minItems"
											type="number"
											min={0}
											value={formState.minItems}
											onChange={(event) => setField("minItems", event.target.value)}
											placeholder="0"
											error={errors.minItems}
											aria-invalid={errors.minItems ? true : undefined}
										/>
										<Input
											label={t`Maximum blocks`}
											name="maxItems"
											type="number"
											min={1}
											max={100}
											value={formState.maxItems}
											onChange={(event) => setField("maxItems", event.target.value)}
											placeholder="100"
											error={errors.maxItems}
											aria-invalid={errors.maxItems ? true : undefined}
										/>
									</div>
								</DialogSection>
							)}

							{selectedType === "repeater" && (
								<DialogSection
									title={t`Sub-Fields`}
									action={
										<div data-field-invalid={errors.subFields ? true : undefined}>
											<Button
												variant="outline"
												size="sm"
												icon={<Plus />}
												aria-describedby={errors.subFields ? subFieldsErrorId : undefined}
												onClick={() =>
													setFormState((prev) => ({
														...prev,
														subFields: [
															...prev.subFields,
															{
																slug: "",
																slugEdited: false,
																slugPersisted: false,
																type: "string",
																label: "",
																required: false,
															},
														],
													}))
												}
											>
												{t`Add Sub-Field`}
											</Button>
										</div>
									}
								>
									{formState.subFields.length === 0 && (
										<p
											id={subFieldsErrorId}
											className={cn(
												"text-sm text-center py-4",
												errors.subFields ? "text-kumo-danger" : "text-kumo-subtle",
											)}
										>
											{t`Add at least one sub-field to define the repeater structure.`}
										</p>
									)}

									{formState.subFields.map((sf, i) => {
										const subFieldErrorsAt = subFieldErrors[i] ?? {};
										const slugUnderivableAt =
											!sf.slug && !sf.slugEdited && sf.label.trim().length > 0;
										return (
											<div key={i} className="flex gap-2 items-start border rounded-lg p-3">
												<div className="flex-1 space-y-2">
													<div className="grid grid-cols-1 sm:grid-cols-3 items-start gap-2">
														<Input
															label={t`Label`}
															className="min-w-0"
															value={sf.label}
															onChange={(e) => {
																const updated = [...formState.subFields];
																updated[i] = {
																	...sf,
																	label: e.target.value,
																	...(sf.slugEdited
																		? {}
																		: { slug: slugifyIdentifier(e.target.value) }),
																};
																setFormState((prev) => ({ ...prev, subFields: updated }));
															}}
															placeholder={t`Field label`}
															required
															error={subFieldErrorsAt.label}
															aria-invalid={subFieldErrorsAt.label ? true : undefined}
														/>
														<Input
															dir="ltr"
															label={
																sf.slugPersisted ? (
																	<HelpLabel
																		help={t`Sub-field slugs cannot be changed after creation.`}
																	>
																		{t`Slug`}
																	</HelpLabel>
																) : (
																	t`Slug`
																)
															}
															aria-label={t`Slug`}
															className="min-w-0"
															value={sf.slug}
															disabled={sf.slugPersisted}
															onChange={(e) => {
																const updated = [...formState.subFields];
																updated[i] = {
																	...sf,
																	slug: e.target.value,
																	slugEdited: true,
																};
																setFormState((prev) => ({ ...prev, subFields: updated }));
															}}
															placeholder={t`field_slug`}
															required={!sf.slugPersisted || undefined}
															description={
																slugUnderivableAt
																	? t`A slug cannot be generated from this label. Type one manually.`
																	: undefined
															}
															error={subFieldErrorsAt.slug}
															aria-invalid={subFieldErrorsAt.slug ? true : undefined}
														/>
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
										);
									})}

									<div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-4">
										<Input
											label={t`Min Items`}
											name="minItems"
											type="number"
											value={formState.minItems}
											onChange={(e) => setField("minItems", e.target.value)}
											placeholder="0"
											error={errors.minItems}
											aria-invalid={errors.minItems ? true : undefined}
										/>
										<Input
											label={t`Max Items`}
											name="maxItems"
											type="number"
											value={formState.maxItems}
											onChange={(e) => setField("maxItems", e.target.value)}
											placeholder={t`No limit`}
											error={errors.maxItems}
											aria-invalid={errors.maxItems ? true : undefined}
										/>
									</div>
								</DialogSection>
							)}

							{(selectedType === "file" || selectedType === "image") && (
								<AllowedTypesEditor
									value={formState.allowedMimeTypes}
									onChange={(next) => setField("allowedMimeTypes", next)}
									draft={formState.mimeDraft}
									onDraftChange={(next) => setField("mimeDraft", next)}
									error={errors.mimeDraft}
								/>
							)}

							{selectedType === "image" && (
								<Switch
									checked={formState.darkVariant}
									onCheckedChange={(checked) => setField("darkVariant", checked)}
									label={
										<HelpLabel
											help={t`Editors can select a second image that the site shows in dark mode.`}
										>
											{t`Dark mode variant`}
										</HelpLabel>
									}
									aria-label={t`Dark mode variant`}
								/>
							)}
						</form>
					)}

					{step !== "type" && <DialogError message={bannerError} className="mt-6" />}
					{onCreateRelation && (
						<RelationDialog
							open={open && isRelationStep}
							onOpenChange={(nextOpen) => {
								if (!nextOpen) setField("step", "config");
							}}
							collections={collections}
							defaultParentCollection={collectionSlug}
							onSubmit={async (input) => {
								const created = await onCreateRelation(input);
								handleRelationCreated({ ...created, boundFields: [], linkCount: 0 });
							}}
							dismissLabel={t`Back`}
						/>
					)}
				</LayerDialog.Body>
				{step !== "type" && (
					<LayerDialog.Actions dismissLabel={t`Cancel`}>
						{isCreatingRelation ? (
							<LayerDialog.Action onClick={() => setField("step", "relation")}>
								{t`Next`}
							</LayerDialog.Action>
						) : (
							<LayerDialog.Action type="submit" form={formId} disabled={isSaving}>
								{isSaving ? t`Saving...` : field ? t`Update Field` : t`Add Field`}
							</LayerDialog.Action>
						)}
					</LayerDialog.Actions>
				)}
			</LayerDialog.Content>
		</LayerDialog.Root>
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
		<HelpTooltip
			help={t`Picking entries this one links to lets editors drag them into an order. The other direction lists whatever points at the entry and cannot be reordered.`}
			ariaLabel={t`What the direction changes`}
		/>
	);
}
