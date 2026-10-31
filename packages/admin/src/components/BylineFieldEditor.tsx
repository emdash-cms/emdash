/**
 * BylineFieldEditor (Phase 5 of Discussion #1174).
 *
 * Purpose-built create/edit dialog for byline custom-field definitions.
 * Constrains the type select to the five v1 types declared by the
 * `BylineFieldType` union — narrower than the content-field universe —
 * and exposes the `translatable` toggle (the storage-split flag) that
 * the content `FieldEditor` doesn't have.
 *
 * Single-step form (not the type-picker → config flow used by
 * `FieldEditor`): with only five types a `<Select>` is faster than a
 * grid of cards and the dialog stays under ~200 LOC.
 *
 * The `translatable` toggle is locked when editing a field that already
 * has stored values — the server returns `TRANSLATABLE_LOCKED` (409) for
 * the flip, but disabling the input + showing a help message saves a
 * round-trip and is friendlier than a toast. Usage is passed in by the
 * parent (which fetches `getBylineFieldUsage` on edit-open) so this
 * component stays a pure controlled form.
 */

import { Input, InputArea, LayerDialog, Select, Switch } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type {
	BylineFieldDefinition,
	BylineFieldType,
	BylineFieldValidation,
	CreateBylineFieldInput,
	UpdateBylineFieldInput,
} from "../lib/api/byline-fields.js";
import { ApiResponseError } from "../lib/api/client.js";
import {
	focusFirstInvalid,
	guardUnsavedInput,
	revealErrors,
	useSingleFlight,
	useValueAtFailure,
} from "../lib/dialog-form.js";
import { slugifyIdentifier } from "../lib/utils";
import { DialogError, getMutationError } from "./DialogError.js";
import { HelpLabel } from "./FieldHelpLabel.js";

/**
 * The five v1 byline field types. Kept in lock-step with the server-side
 * `BYLINE_FIELD_TYPES` constant (`packages/core/src/schema/types.ts`).
 *
 * `MessageDescriptor`s are resolved with `t(descriptor)` inside the
 * component so the strings extract correctly to the Lingui catalog.
 */
const TYPE_OPTIONS: { value: BylineFieldType; label: MessageDescriptor }[] = [
	{ value: "string", label: msg`Short text` },
	{ value: "text", label: msg`Long text` },
	{ value: "url", label: msg`URL` },
	{ value: "boolean", label: msg`Boolean` },
	{ value: "select", label: msg`Select` },
];

export interface BylineFieldEditorProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Existing field to edit. When absent, the dialog opens in create mode.
	 * `slug` and `type` are immutable in edit mode (the inputs render
	 * disabled) — see the registry's create-only invariant.
	 */
	field?: BylineFieldDefinition | null;
	/**
	 * Total stored values referencing this field. When > 0 the
	 * `translatable` toggle is locked because the server rejects the
	 * flip with `TRANSLATABLE_LOCKED`. Pass `0` (or omit) in create mode.
	 */
	usageTotal?: number;
	/** Return the save's promise so a second submit waits for it. */
	onSave: (input: CreateBylineFieldInput | UpdateBylineFieldInput) => void | Promise<unknown>;
	isSaving?: boolean;
	/** Mutation error to render inline. Pass the mutation's `error` directly. */
	error?: unknown;
}

interface FormState {
	slug: string;
	label: string;
	type: BylineFieldType;
	required: boolean;
	translatable: boolean;
	/** Newline-separated options for `select`-type fields. */
	options: string;
}

// The server's limits, from `packages/core/src/api/schemas/byline-fields.ts`.
const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_SLUG_LENGTH = 63;
const MAX_LABEL_LENGTH = 200;
const MAX_SELECT_OPTIONS = 200;

const FORM_INPUTS = ["label", "slug", "options"] as const;

type FormInput = (typeof FORM_INPUTS)[number];

/** The options a select offers: one per non-empty line, trimmed. */
function parseOptions(options: string): string[] {
	return options
		.split("\n")
		.map((o) => o.trim())
		.filter(Boolean);
}

/** What keeps the form from saving, matching what the server would reject. */
function formProblems(
	state: FormState,
	isEdit: boolean,
): Partial<Record<FormInput, MessageDescriptor>> {
	const problems: Partial<Record<FormInput, MessageDescriptor>> = {};
	const label = state.label.trim();
	if (!label) problems.label = msg`Enter a label.`;
	else if (state.label.length > MAX_LABEL_LENGTH)
		problems.label = msg`Use 200 characters or fewer.`;
	if (!isEdit) {
		if (!state.slug) {
			// An empty slug with no label follows the label, which already carries the error.
			if (label) {
				problems.slug = slugifyIdentifier(state.label)
					? msg`Enter a slug.`
					: msg`A slug cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.`;
			}
		} else if (!SLUG_PATTERN.test(state.slug)) {
			problems.slug = msg`Use lowercase letters, numbers, and underscores, starting with a letter.`;
		} else if (state.slug.length > MAX_SLUG_LENGTH) {
			problems.slug = msg`Use 63 characters or fewer.`;
		}
	}
	if (state.type === "select") {
		const options = parseOptions(state.options);
		if (options.length === 0) problems.options = msg`Add at least one option.`;
		else if (options.length > MAX_SELECT_OPTIONS) problems.options = msg`Use 200 options or fewer.`;
		else if (new Set(options).size !== options.length) {
			problems.options = msg`List each option only once.`;
		}
	}
	return problems;
}

/** The message for a slug the server turned down, when that was the reason. */
function slugRejection(error: unknown): MessageDescriptor | undefined {
	if (!(error instanceof ApiResponseError)) return undefined;
	if (error.code === "FIELD_EXISTS") {
		return msg`Another field already uses this slug. Enter a different one.`;
	}
	// The form checks the slug's format and length itself, which leaves being
	// reserved as the server's one remaining reason to reject it.
	const issues = error.details?.issues;
	if (
		error.code === "VALIDATION_ERROR" &&
		Array.isArray(issues) &&
		issues.some((issue) => typeof issue === "object" && issue !== null && issue.path === "slug")
	) {
		return msg`This slug is reserved. Enter a different one.`;
	}
	return undefined;
}

function initialFormState(field?: BylineFieldDefinition | null): FormState {
	if (!field) {
		return {
			slug: "",
			label: "",
			type: "string",
			required: false,
			translatable: true,
			options: "",
		};
	}
	return {
		slug: field.slug,
		label: field.label,
		type: field.type,
		required: field.required,
		translatable: field.translatable,
		options: field.validation?.options?.join("\n") ?? "",
	};
}

export function BylineFieldEditor({
	open,
	onOpenChange,
	field,
	usageTotal = 0,
	onSave,
	isSaving,
	error,
}: BylineFieldEditorProps) {
	const { t } = useLingui();
	const isEdit = !!field;
	const [state, setState] = React.useState<FormState>(() => initialFormState(field));
	const formId = React.useId();
	const formRef = React.useRef<HTMLFormElement>(null);
	const [submitted, setSubmitted] = React.useState(false);
	// The form as last sent, which a rejection of that save is about.
	const [sent, setSent] = React.useState<FormState | null>(null);

	// Reset state when the dialog opens or the target field changes.
	// Without this, re-opening the dialog on a different field would show
	// the previous field's form values.
	React.useEffect(() => {
		if (open) {
			setState(initialFormState(field));
			setSubmitted(false);
			setSent(null);
		}
	}, [open, field]);

	const translatableLocked = isEdit && usageTotal > 0;
	// A flip made before the usage count arrived can no longer be sent or undone.
	const translatable = translatableLocked && field ? field.translatable : state.translatable;

	const initial = React.useMemo(() => initialFormState(field), [field]);
	const unsaved =
		state.slug !== initial.slug ||
		state.label !== initial.label ||
		state.type !== initial.type ||
		state.required !== initial.required ||
		translatable !== initial.translatable ||
		state.options !== initial.options;

	const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setState((prev) => ({ ...prev, [key]: value }));

	const handleLabelChange = (value: string) => {
		setField("label", value);
		// Auto-fill slug from label, but only in create mode. Editing the
		// slug post-create is rejected by the registry; preserving the
		// stored slug on edit avoids confusing the editor.
		if (!isEdit) {
			setField("slug", slugifyIdentifier(value));
		}
	};

	const problems = formProblems(state, isEdit);
	// The form as it stood when the failed save came back.
	const failedState = useValueAtFailure(error, state);
	// A slug edited while the save ran isn't the one refused, so its refusal stays in the banner.
	const slugRefusal =
		sent && failedState?.slug === sent.slug && !isEdit ? slugRejection(error) : undefined;
	if (slugRefusal && state.slug === sent?.slug) problems.slug = slugRefusal;
	const hasProblems = Object.keys(problems).length > 0;

	const errors: Partial<Record<FormInput, string>> = {};
	if (submitted) {
		for (const key of FORM_INPUTS) {
			const message = problems[key];
			if (message) errors[key] = t(message);
		}
	}

	// Any change after a failed save came back may be the fix, so its message stops applying.
	const bannerError =
		slugRefusal || (failedState && state !== failedState)
			? null
			: error instanceof ApiResponseError && error.code === "TRANSLATABLE_LOCKED"
				? t`Locked because this field has stored values. Delete the values (or the field) to change this.`
				: getMutationError(error);

	// The action that started the save was disabled while it ran, so focus has
	// to be put back on the field the server turned down.
	React.useEffect(() => {
		if (!isEdit && slugRejection(error)) focusFirstInvalid(formRef.current);
	}, [error, isEdit]);

	const submitSave = useSingleFlight((input: CreateBylineFieldInput | UpdateBylineFieldInput) =>
		Promise.resolve(onSave(input)),
	);

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSaving) return;
		if (hasProblems) {
			const form = event.currentTarget;
			revealErrors(form, () => setSubmitted(true));
			return;
		}
		setSubmitted(true);
		setSent(state);

		const validation: BylineFieldValidation | null =
			state.type === "select" ? { options: parseOptions(state.options) } : null;

		if (isEdit) {
			const updateInput: UpdateBylineFieldInput = {
				label: state.label,
				required: state.required,
				// Only send `translatable` when it actually changed. Sending
				// the existing value triggers the server's locked-flip check
				// unnecessarily; sending `undefined` makes it a no-op for
				// that key.
				translatable: field && translatable !== field.translatable ? translatable : undefined,
				validation,
			};
			submitSave(updateInput);
		} else {
			const createInput: CreateBylineFieldInput = {
				slug: state.slug,
				label: state.label,
				type: state.type,
				required: state.required,
				translatable: state.translatable,
				validation,
			};
			submitSave(createInput);
		}
	};

	const slugUnderivable =
		!isEdit && !state.slug && state.label.trim().length > 0 && !slugifyIdentifier(state.label);

	return (
		<LayerDialog.Root
			open={open}
			{...guardUnsavedInput(unsaved, onOpenChange)}
			dismissDisabled={isSaving}
		>
			<LayerDialog.Content>
				<LayerDialog.Title>{isEdit ? t`Edit byline field` : t`New byline field`}</LayerDialog.Title>
				<LayerDialog.Body>
					<form id={formId} ref={formRef} noValidate onSubmit={handleSubmit} className="grid gap-5">
						{/* Label + slug */}
						<div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 sm:gap-4">
							<Input
								label={t`Label`}
								value={state.label}
								onChange={(e) => handleLabelChange(e.target.value)}
								placeholder={t`Job title`}
								required
								error={errors.label}
								aria-invalid={errors.label ? true : undefined}
							/>
							<Input
								dir="ltr"
								label={
									isEdit ? (
										<HelpLabel help={t`Slugs cannot be changed after the field is created.`}>
											{t`Slug`}
										</HelpLabel>
									) : (
										t`Slug`
									)
								}
								aria-label={t`Slug`}
								value={state.slug}
								onChange={(e) => setField("slug", e.target.value)}
								// The literal slug is an example identifier, not natural-language
								// copy — translators will typically leave it as-is, but the
								// AGENTS.md "every user-facing string via Lingui" rule applies
								// uniformly, so the catalog extractor sees it.
								placeholder={t`job_title`}
								disabled={isEdit}
								required={!isEdit || undefined}
								description={
									slugUnderivable
										? t`A slug cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.`
										: undefined
								}
								error={errors.slug}
								aria-invalid={errors.slug ? true : undefined}
							/>
						</div>

						{/* Type — disabled on edit because the storage column depends on it */}
						<Select
							label={
								isEdit ? (
									<HelpLabel help={t`Field type cannot be changed after creation.`}>
										{t`Type`}
									</HelpLabel>
								) : (
									t`Type`
								)
							}
							aria-label={t`Type`}
							className="w-full"
							value={state.type}
							onValueChange={(v) => setField("type", v ?? "string")}
							items={Object.fromEntries(TYPE_OPTIONS.map(({ value, label }) => [value, t(label)]))}
							disabled={isEdit}
						/>

						{/* Toggles */}
						<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
							{/* TODO: enforce `required` on the write path — currently
							 * descriptive only, see `BylineRepository.coerceFieldValue`. */}
							<Switch
								checked={state.required}
								onCheckedChange={(checked) => setField("required", checked)}
								label={t`Required`}
							/>
							<Switch
								checked={translatable}
								onCheckedChange={(checked) => setField("translatable", checked)}
								disabled={translatableLocked}
								label={
									<HelpLabel
										help={
											translatableLocked
												? t`Locked because this field has stored values. Delete the values (or the field) to change this.`
												: translatable
													? t`Stored per locale — each translation of a byline gets its own value.`
													: t`Shared across all translations of the same byline.`
										}
									>
										{t`Translatable`}
									</HelpLabel>
								}
								aria-label={t`Translatable`}
							/>
						</div>

						{/* Select-type validation: options list */}
						{state.type === "select" && (
							<InputArea
								label={t`Options (one per line)`}
								value={state.options}
								onChange={(e) => setField("options", e.target.value)}
								placeholder={t`Editor\nReporter\nPhotographer`}
								rows={5}
								required
								error={errors.options}
								aria-invalid={errors.options ? true : undefined}
							/>
						)}

						<DialogError message={bannerError} />
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId} disabled={isSaving}>
						{isSaving ? t`Saving…` : isEdit ? t`Save changes` : t`Create field`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}
