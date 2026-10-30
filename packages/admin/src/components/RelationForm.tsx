/**
 * The relation form — the fields the relation dialog shows, whether it is
 * creating a relation or renaming the roles of one.
 *
 * The two collections and the slug are fixed once the relation exists: a
 * reference field stores the slug, and every link is keyed by the relation's
 * id, so changing either end would leave the stored links pointing at content
 * of the wrong type.
 *
 * Roles are single-valued, like a collection's label. A multi-locale admin
 * shows them untranslated.
 */

import { Input, Select } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type { SchemaCollection } from "../lib/api";
import type {
	CreateRelationInput,
	RelationWithUsage,
	UpdateRelationInput,
} from "../lib/api/relations.js";
import { singularize } from "../lib/singularize.js";
import { slugifyIdentifier } from "../lib/utils.js";
import { DialogSection } from "./DialogSection.js";
import { HelpLabel } from "./FieldHelpLabel.js";

/** How a limit is expressed in the form. `limit` reveals a number input. */
type LimitMode = "one" | "many" | "limit";

/** The four role names, which auto-fill writes and the user can overwrite. */
type LabelKey = "parentLabel" | "parentLabelSingular" | "childLabel" | "childLabelSingular";

function limitMode(value: number | null): LimitMode {
	if (value === null) return "many";
	return value === 1 ? "one" : "limit";
}

function limitValue(mode: LimitMode, custom: string): number | null {
	if (mode === "many") return null;
	if (mode === "one") return 1;
	const parsed = parseInt(custom, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Whether a limit is ready to save. "At most…" with nothing typed in it is not:
 * it reads as `null`, which the API takes as any number — the opposite of what
 * choosing a maximum means.
 */
function limitComplete(mode: LimitMode, custom: string): boolean {
	return mode !== "limit" || (limitValue(mode, custom) ?? 0) >= 2;
}

function customLimit(value: number | null | undefined): string {
	return value && value !== 1 ? String(value) : "";
}

/** The fields that can keep a relation from saving. */
export type RelationField =
	| "parentCollection"
	| "childCollection"
	| "parentLabel"
	| "parentLabelSingular"
	| "childLabel"
	| "childLabelSingular"
	| "childrenLimit"
	| "parentsLimit"
	| "slug";

/** The message each field shows, once a submit has found it wrong. */
export type RelationFormErrors = Partial<Record<RelationField, string>>;

const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const SLUG_MAX_LENGTH = 63;
const LABEL_MAX_LENGTH = 200;

const SLUG_UNDERIVABLE = msg`A slug cannot be generated from these role names. Type one manually using lowercase letters, numbers, and underscores.`;
const LABEL_TOO_LONG = msg`Use 200 characters or fewer.`;

/** The plural and singular names a collection lends to the end it sits on. */
function collectionLabels(
	collections: SchemaCollection[],
	slug: string,
): { plural: string; singular: string } {
	const collection = collections.find((c) => c.slug === slug);
	const label = collection?.label ?? slug;
	return { plural: label, singular: collection?.labelSingular || singularize(label) };
}

export interface RelationFormState {
	slug: string;
	slugEdited: boolean;
	parentCollection: string;
	childCollection: string;
	parentLabel: string;
	parentLabelSingular: string;
	childLabel: string;
	childLabelSingular: string;
	/** Roles the user typed into, which picking a content type must not undo. */
	labelsEdited: Partial<Record<LabelKey, boolean>>;
	childrenMode: LimitMode;
	childrenLimit: string;
	parentsMode: LimitMode;
	parentsLimit: string;
}

export interface UseRelationFormOptions {
	relation?: RelationWithUsage;
	isNew?: boolean;
	/** Names the roles of a new relation after the content types it joins. */
	collections?: SchemaCollection[];
	/** Prefills the linking end when a relation is created from a content type. */
	defaultParentCollection?: string;
}

export interface RelationForm {
	state: RelationFormState;
	set: <K extends keyof RelationFormState>(key: K, value: RelationFormState[K]) => void;
	/** Sets one end, naming its roles after the content type it holds. */
	setEnd: (end: "parent" | "child", value: string) => void;
	/** Sets one role name, and renames an unedited new relation after both. */
	setLabel: (key: LabelKey, value: string) => void;
	/** Back to the values the form opened with. */
	reset: () => void;
	/** What keeps the form from saving, by field. Empty when it can save. */
	problems: Partial<Record<RelationField, MessageDescriptor>>;
	/** Whether the user has changed anything since the form opened. */
	isDirty: boolean;
	toInput: () => CreateRelationInput | UpdateRelationInput;
}

function initialState(options: UseRelationFormOptions): RelationFormState {
	const { relation, defaultParentCollection, collections = [] } = options;
	const parentCollection = relation?.parentCollection ?? defaultParentCollection ?? "";
	const prefill =
		!relation && parentCollection
			? collectionLabels(collections, parentCollection)
			: { plural: "", singular: "" };

	return {
		slug: relation?.slug ?? "",
		slugEdited: false,
		parentCollection,
		childCollection: relation?.childCollection ?? "",
		parentLabel: relation?.parentLabel ?? prefill.plural,
		parentLabelSingular: relation?.parentLabelSingular ?? prefill.singular,
		childLabel: relation?.childLabel ?? "",
		childLabelSingular: relation?.childLabelSingular ?? "",
		labelsEdited: {},
		childrenMode: limitMode(relation?.maxChildrenPerParent ?? null),
		childrenLimit: customLimit(relation?.maxChildrenPerParent),
		parentsMode: limitMode(relation?.maxParentsPerChild ?? null),
		parentsLimit: customLimit(relation?.maxParentsPerChild),
	};
}

/** A new relation is named after what its two sides are called. */
function withDerivedSlug(state: RelationFormState, isNew?: boolean): RelationFormState {
	if (!isNew || state.slugEdited || !state.parentLabel || !state.childLabel) return state;
	return { ...state, slug: slugifyIdentifier(`${state.parentLabel}_${state.childLabel}`) };
}

function slugProblem(state: RelationFormState): MessageDescriptor | undefined {
	const namesGiven = Boolean(state.parentLabel && state.childLabel);
	if (!state.slug) {
		// An untouched slug fills in once both sides are named, and the missing
		// name already carries the error.
		if (!state.slugEdited && !namesGiven) return undefined;
		return namesGiven && !state.slugEdited ? SLUG_UNDERIVABLE : msg`Enter a slug.`;
	}
	if (!SLUG_PATTERN.test(state.slug)) {
		return msg`Use lowercase letters, numbers, and underscores, starting with a letter.`;
	}
	if (state.slug.length > SLUG_MAX_LENGTH) return msg`Use 63 characters or fewer.`;
	return undefined;
}

function formProblems(
	state: RelationFormState,
	isNew?: boolean,
): Partial<Record<RelationField, MessageDescriptor>> {
	const problems: Partial<Record<RelationField, MessageDescriptor>> = {};
	if (isNew && !state.parentCollection) problems.parentCollection = msg`Choose a content type.`;
	if (isNew && !state.childCollection) problems.childCollection = msg`Choose a content type.`;
	if (!state.parentLabel.trim()) problems.parentLabel = msg`Enter a name.`;
	else if (state.parentLabel.length > LABEL_MAX_LENGTH) problems.parentLabel = LABEL_TOO_LONG;
	if (state.parentLabelSingular.length > LABEL_MAX_LENGTH) {
		problems.parentLabelSingular = LABEL_TOO_LONG;
	}
	if (!state.childLabel.trim()) problems.childLabel = msg`Enter a name.`;
	else if (state.childLabel.length > LABEL_MAX_LENGTH) problems.childLabel = LABEL_TOO_LONG;
	if (state.childLabelSingular.length > LABEL_MAX_LENGTH) {
		problems.childLabelSingular = LABEL_TOO_LONG;
	}
	if (!limitComplete(state.childrenMode, state.childrenLimit)) {
		problems.childrenLimit = msg`Enter a number of 2 or more.`;
	}
	if (!limitComplete(state.parentsMode, state.parentsLimit)) {
		problems.parentsLimit = msg`Enter a number of 2 or more.`;
	}
	const slug = isNew ? slugProblem(state) : undefined;
	if (slug) problems.slug = slug;
	return problems;
}

export function useRelationForm(options: UseRelationFormOptions): RelationForm {
	const { relation, isNew, collections = [] } = options;
	const [state, setState] = React.useState<RelationFormState>(() => initialState(options));
	const [edited, setEdited] = React.useState(false);

	const set = React.useCallback(
		<K extends keyof RelationFormState>(key: K, value: RelationFormState[K]) => {
			setEdited(true);
			setState((current) => ({ ...current, [key]: value }));
		},
		[],
	);

	const setLabel = React.useCallback(
		(key: LabelKey, value: string) => {
			setEdited(true);
			setState((current) =>
				withDerivedSlug(
					{ ...current, [key]: value, labelsEdited: { ...current.labelsEdited, [key]: true } },
					isNew,
				),
			);
		},
		[isNew],
	);

	// Both sides start out called what the content types on them are called,
	// which is what a reference field bound to either end then reads as.
	const collectionsRef = React.useRef(collections);
	collectionsRef.current = collections;
	const setEnd = React.useCallback(
		(end: "parent" | "child", value: string) => {
			setEdited(true);
			setState((current) => {
				const names = collectionLabels(collectionsRef.current, value);
				const pluralKey = end === "parent" ? "parentLabel" : "childLabel";
				const singularKey = end === "parent" ? "parentLabelSingular" : "childLabelSingular";
				const next = {
					...current,
					...(end === "parent" ? { parentCollection: value } : { childCollection: value }),
					...(current.labelsEdited[pluralKey] ? {} : { [pluralKey]: names.plural }),
					...(current.labelsEdited[singularKey] ? {} : { [singularKey]: names.singular }),
				};
				return withDerivedSlug(next, isNew);
			});
		},
		[isNew],
	);

	const optionsRef = React.useRef(options);
	optionsRef.current = options;
	const reset = React.useCallback(() => {
		setState(initialState(optionsRef.current));
		setEdited(false);
	}, []);

	const problems = React.useMemo(() => formProblems(state, isNew), [state, isNew]);

	const isDirty =
		isNew || !relation
			? edited
			: state.parentLabel !== relation.parentLabel ||
				state.parentLabelSingular !== (relation.parentLabelSingular ?? "") ||
				state.childLabel !== relation.childLabel ||
				state.childLabelSingular !== (relation.childLabelSingular ?? "") ||
				state.childrenMode !== limitMode(relation.maxChildrenPerParent) ||
				state.parentsMode !== limitMode(relation.maxParentsPerChild) ||
				limitValue(state.childrenMode, state.childrenLimit) !== relation.maxChildrenPerParent ||
				limitValue(state.parentsMode, state.parentsLimit) !== relation.maxParentsPerChild;

	const toInput = React.useCallback((): CreateRelationInput | UpdateRelationInput => {
		const roles = {
			parentLabel: state.parentLabel,
			parentLabelSingular: state.parentLabelSingular || null,
			childLabel: state.childLabel,
			childLabelSingular: state.childLabelSingular || null,
			maxChildrenPerParent: limitValue(state.childrenMode, state.childrenLimit),
			maxParentsPerChild: limitValue(state.parentsMode, state.parentsLimit),
		};
		return isNew
			? {
					slug: state.slug,
					parentCollection: state.parentCollection,
					childCollection: state.childCollection,
					...roles,
				}
			: roles;
	}, [state, isNew]);

	return { state, set, setEnd, setLabel, reset, problems, isDirty, toInput };
}

export interface RelationFormFieldsProps {
	form: RelationForm;
	collections: SchemaCollection[];
	isNew?: boolean;
	errors?: RelationFormErrors;
}

export function RelationFormFields({
	form,
	collections,
	isNew,
	errors = {},
}: RelationFormFieldsProps) {
	const { t } = useLingui();
	const { state, set, setEnd, setLabel } = form;

	const collectionItems = collections.map((c) => ({ label: c.label, value: c.slug }));
	const slugUnderivable =
		isNew && !state.slug && !state.slugEdited && Boolean(state.parentLabel && state.childLabel);

	// Named here rather than inside the label template: a `t` call nested in
	// another `t` template is not something the macro can extract.
	const linkingSideName = state.parentLabelSingular || t`entry on the linking side`;
	const linkedSideName = state.childLabelSingular || t`entry on the linked side`;

	return (
		<div className="grid gap-5">
			<DialogSection title={t`Content types`}>
				<div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-4">
					<div data-field-invalid={errors.parentCollection ? true : undefined}>
						<Select
							label={t`Links from`}
							className="w-full"
							value={state.parentCollection}
							onValueChange={(v) => setEnd("parent", v ?? "")}
							items={collectionItems}
							placeholder={t`Select a content type`}
							disabled={!isNew}
							required
							error={errors.parentCollection}
						/>
					</div>
					<div data-field-invalid={errors.childCollection ? true : undefined}>
						<Select
							label={t`Links to`}
							className="w-full"
							value={state.childCollection}
							onValueChange={(v) => setEnd("child", v ?? "")}
							items={collectionItems}
							placeholder={t`Select a content type`}
							disabled={!isNew}
							required
							error={errors.childCollection}
						/>
					</div>
				</div>
			</DialogSection>

			<DialogSection
				title={t`Roles`}
				help={t`What each side is called. These name the fields bound to this relationship.`}
			>
				<div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-x-4">
					<Input
						label={t`Linking side (plural)`}
						value={state.parentLabel}
						onChange={(e) => setLabel("parentLabel", e.target.value)}
						placeholder={t`Posts`}
						required
						error={errors.parentLabel}
						aria-invalid={errors.parentLabel ? true : undefined}
					/>
					<Input
						label={t`Linking side (singular)`}
						value={state.parentLabelSingular}
						onChange={(e) => setLabel("parentLabelSingular", e.target.value)}
						placeholder={t`Post`}
						error={errors.parentLabelSingular}
						aria-invalid={errors.parentLabelSingular ? true : undefined}
					/>
					<Input
						label={t`Linked side (plural)`}
						value={state.childLabel}
						onChange={(e) => setLabel("childLabel", e.target.value)}
						placeholder={t`Authors`}
						required
						error={errors.childLabel}
						aria-invalid={errors.childLabel ? true : undefined}
					/>
					<Input
						label={t`Linked side (singular)`}
						value={state.childLabelSingular}
						onChange={(e) => setLabel("childLabelSingular", e.target.value)}
						placeholder={t`Author`}
						error={errors.childLabelSingular}
						aria-invalid={errors.childLabelSingular ? true : undefined}
					/>
				</div>
			</DialogSection>

			<DialogSection
				title={t`How many`}
				help={t`Both reference fields bound to this relation share these limits, so the two sides cannot disagree about the same links.`}
			>
				<div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:grid-rows-[auto_auto] sm:gap-x-4 sm:gap-y-2">
					<LimitControl
						label={t`Each ${linkingSideName} links to`}
						oneLabel={t`One`}
						manyLabel={t`Any number`}
						mode={state.childrenMode}
						onModeChange={(mode) => set("childrenMode", mode)}
						limit={state.childrenLimit}
						onLimitChange={(value) => set("childrenLimit", value)}
						error={errors.childrenLimit}
					/>
					<LimitControl
						label={t`Each ${linkedSideName} is linked from`}
						oneLabel={t`One`}
						manyLabel={t`Any number`}
						mode={state.parentsMode}
						onModeChange={(mode) => set("parentsMode", mode)}
						limit={state.parentsLimit}
						onLimitChange={(value) => set("parentsLimit", value)}
						error={errors.parentsLimit}
					/>
				</div>
			</DialogSection>

			<div className="border-t border-kumo-line pt-5">
				<Input
					dir="ltr"
					label={
						isNew ? (
							t`Slug`
						) : (
							<HelpLabel
								help={t`The content types and slug cannot be changed after a relation is created.`}
							>
								{t`Slug`}
							</HelpLabel>
						)
					}
					aria-label={t`Slug`}
					description={
						isNew
							? slugUnderivable
								? t(SLUG_UNDERIVABLE)
								: t`Lowercase letters, numbers and underscores. Reference fields store this.`
							: undefined
					}
					value={state.slug}
					onChange={(e) => {
						set("slugEdited", true);
						set("slug", e.target.value);
					}}
					placeholder="posts_authors"
					disabled={!isNew}
					required={isNew || undefined}
					error={errors.slug}
					aria-invalid={errors.slug ? true : undefined}
				/>
			</div>
		</div>
	);
}

interface LimitControlProps {
	label: string;
	oneLabel: string;
	manyLabel: string;
	mode: LimitMode;
	onModeChange: (mode: LimitMode) => void;
	limit: string;
	onLimitChange: (limit: string) => void;
	error?: string;
}

function LimitControl({
	label,
	oneLabel,
	manyLabel,
	mode,
	onModeChange,
	limit,
	onLimitChange,
	error,
}: LimitControlProps) {
	const { t } = useLingui();
	const labelId = React.useId();

	// The label sits in the parent grid's own row so that a label wrapping onto
	// a second line still leaves the two selects on one line.
	return (
		<div className="grid gap-2 sm:row-span-2 sm:grid-rows-subgrid">
			<span id={labelId} className="text-base font-medium text-kumo-default">
				{label}
			</span>
			<div className="space-y-2">
				<Select
					aria-labelledby={labelId}
					className="w-full"
					value={mode}
					onValueChange={(v) => onModeChange(v ?? "many")}
					items={{ one: oneLabel, many: manyLabel, limit: t`At most…` }}
				/>
				{mode === "limit" && (
					<Input
						type="number"
						min={2}
						label={t`Maximum`}
						value={limit}
						onChange={(e) => onLimitChange(e.target.value)}
						placeholder="5"
						required
						error={error}
						aria-invalid={error ? true : undefined}
					/>
				)}
			</div>
		</div>
	);
}
