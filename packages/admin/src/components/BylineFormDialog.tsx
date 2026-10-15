import { Button, Dialog, Input, InputArea, Select, Switch } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { flushSync } from "react-dom";

import {
	fetchByline,
	fetchUsers,
	type BylineInput,
	type BylineSummary,
	type UserListItem,
} from "../lib/api";
import { listBylineFields, type BylineFieldDefinition } from "../lib/api/byline-fields.js";
import { isSafeUrl } from "../lib/url.js";
import { BylineAvatarField } from "./BylineAvatarField.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { OptionalLabel } from "./OptionalLabel.js";

const BYLINE_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const BYLINE_SLUG_MAX_LENGTH = 80;
const COMBINING_MARK_PATTERN = /[\u0300-\u036f]/g;
const UNSAFE_SLUG_PATTERN = /[^a-z0-9]+/g;
const MULTIPLE_HYPHENS_PATTERN = /-+/g;
const EDGE_HYPHENS_PATTERN = /^-+|-+$/g;
const LEADING_LETTER_PATTERN = /^[a-z]/;
const TRAILING_HYPHENS_PATTERN = /-+$/g;

function stableHash(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(36).padStart(7, "0");
}

export function toBylineSlug(value: string): string {
	const normalized = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(COMBINING_MARK_PATTERN, "")
		.replace(UNSAFE_SLUG_PATTERN, "-")
		.replace(MULTIPLE_HYPHENS_PATTERN, "-")
		.replace(EDGE_HYPHENS_PATTERN, "");
	const withLeadingLetter = LEADING_LETTER_PATTERN.test(normalized)
		? normalized
		: normalized
			? `byline-${normalized}`
			: `byline-${stableHash(value.normalize("NFKC").toLowerCase())}`;
	return withLeadingLetter.slice(0, BYLINE_SLUG_MAX_LENGTH).replace(TRAILING_HYPHENS_PATTERN, "");
}

/** The byline fields the form edits. Callers add the locale when creating. */
export type BylineFormValues = Omit<BylineInput, "locale" | "translationOf">;

interface BylineFormState {
	slug: string;
	displayName: string;
	bio: string;
	websiteUrl: string;
	userId: string | null;
	isGuest: boolean;
	avatarMediaId: string | null;
	/**
	 * Custom-field values keyed by field slug. Always an object, `{}` when no
	 * fields are registered or the byline has no stored values.
	 */
	customFields: Record<string, unknown>;
}

interface BylineFormErrors {
	displayName?: string;
	slug?: string;
	websiteUrl?: string;
}

function toFormState(byline?: BylineSummary | null): BylineFormState {
	if (!byline) {
		return {
			slug: "",
			displayName: "",
			bio: "",
			websiteUrl: "",
			userId: null,
			isGuest: false,
			avatarMediaId: null,
			customFields: {},
		};
	}

	return {
		slug: byline.slug,
		displayName: byline.displayName,
		bio: byline.bio ?? "",
		websiteUrl: byline.websiteUrl ?? "",
		userId: byline.userId,
		isGuest: byline.isGuest,
		avatarMediaId: byline.avatarMediaId ?? null,
		customFields: byline.customFields ?? {},
	};
}

function toNewFormState(displayName: string): BylineFormState {
	return {
		...toFormState(null),
		displayName,
		slug: displayName.trim() ? toBylineSlug(displayName) : "",
	};
}

/** A cleared input and an unchecked switch show the same as a custom field with no value. */
function toComparableFieldValue(value: unknown): unknown {
	return value === undefined || value === false ? null : value;
}

/**
 * The latest copy of a byline with the fields edited since `loaded` kept. The
 * linked user and guest flag change together, so they're kept as a pair.
 */
function rebaseFormState(
	form: BylineFormState,
	loaded: BylineFormState,
	latest: BylineFormState,
): BylineFormState {
	const pick = <K extends keyof BylineFormState>(key: K): BylineFormState[K] =>
		form[key] === loaded[key] ? latest[key] : form[key];
	const attributionEdited = form.userId !== loaded.userId || form.isGuest !== loaded.isGuest;
	const customFields = { ...latest.customFields };
	for (const [slug, value] of Object.entries(form.customFields)) {
		if (toComparableFieldValue(value) !== toComparableFieldValue(loaded.customFields[slug])) {
			customFields[slug] = value;
		}
	}
	return {
		slug: pick("slug"),
		displayName: pick("displayName"),
		bio: pick("bio"),
		websiteUrl: pick("websiteUrl"),
		userId: attributionEdited ? form.userId : latest.userId,
		isGuest: attributionEdited ? form.isGuest : latest.isGuest,
		avatarMediaId: pick("avatarMediaId"),
		customFields,
	};
}

function isHttpUrl(value: string): boolean {
	return isSafeUrl(value) && URL.canParse(value);
}

function getUserLabel(user: UserListItem): string {
	if (user.name) return `${user.name} (${user.email})`;
	return user.email;
}

export interface BylineFormDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onOpenChangeComplete?: (open: boolean) => void;
	/** The byline to edit, or null to create one. */
	bylineId: string | null;
	/** The caller's copy of the byline being edited, shown until the latest copy loads. */
	byline?: BylineSummary | null;
	/** Fills in a new byline's display name, and its slug from it. */
	initialDisplayName?: string;
	onSubmit: (values: BylineFormValues) => Promise<BylineSummary>;
	onSaved: (byline: BylineSummary) => void;
	createLabel?: string;
	editDescription?: string;
	/** An error from an action outside the form, such as creating a translation. */
	error?: unknown;
	/** Adds a Delete button for an existing byline. */
	onDelete?: (byline: BylineSummary) => void;
	/** Content shown below an existing byline's fields. */
	renderExtra?: (byline: BylineSummary) => React.ReactNode;
}

/**
 * Create and edit form for a byline profile. The form starts over each time
 * the dialog opens, and switches bylines while open when `bylineId` changes.
 */
export function BylineFormDialog({
	open,
	onOpenChange,
	onOpenChangeComplete,
	bylineId,
	byline = null,
	initialDisplayName = "",
	onSubmit,
	onSaved,
	createLabel,
	editDescription,
	error,
	onDelete,
	renderExtra,
}: BylineFormDialogProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [wasOpen, setWasOpen] = React.useState(false);
	// While the dialog closes, keep showing the byline it was opened for.
	const [shownBylineId, setShownBylineId] = React.useState(bylineId);
	const [form, setForm] = React.useState<BylineFormState>(() => toFormState(null));
	// The byline record the form was last populated from. Newer data for the
	// same byline only replaces the fields edited since: the by-id query can
	// resolve after typing starts, and the caller's copy can be stale.
	const [formSource, setFormSource] = React.useState<BylineSummary | null>(null);
	const [formErrors, setFormErrors] = React.useState<BylineFormErrors>({});
	// A new byline's slug follows its display name until the slug is edited.
	const [slugEdited, setSlugEdited] = React.useState(false);
	const displayNameRef = React.useRef<HTMLInputElement>(null);
	const slugRef = React.useRef<HTMLInputElement>(null);
	const websiteUrlRef = React.useRef<HTMLInputElement>(null);

	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setShownBylineId(bylineId);
			setForm(byline ? toFormState(byline) : toNewFormState(initialDisplayName));
			setFormSource(byline);
			setFormErrors({});
			setSlugEdited(false);
		}
	} else if (open && bylineId !== shownBylineId) {
		setShownBylineId(bylineId);
		setFormErrors({});
	}

	const { data: latest } = useQuery({
		queryKey: ["byline", shownBylineId],
		queryFn: () => (shownBylineId ? fetchByline(shownBylineId) : Promise.resolve(null)),
		enabled: open && !!shownBylineId,
	});
	const source = latest ?? byline;

	const { data: usersData } = useQuery({
		queryKey: ["users", "byline-linking"],
		queryFn: () => fetchUsers({ limit: 100 }),
		enabled: open,
	});
	const users = usersData?.items ?? [];

	const { data: customFieldsList, error: customFieldsError } = useQuery({
		queryKey: ["byline-fields"],
		queryFn: listBylineFields,
		staleTime: 60 * 1000,
		enabled: open,
	});
	const customFieldDefs = customFieldsList?.items ?? [];

	const saveMutation = useMutation({
		mutationFn: (values: BylineFormValues) => onSubmit(values),
		onSuccess: (saved) => {
			queryClient.setQueryData(["byline", saved.id], saved);
		},
	});
	const resetSave = saveMutation.reset;
	React.useLayoutEffect(() => {
		if (open) resetSave();
	}, [open, resetSave]);
	const isSaving = saveMutation.isPending;

	React.useEffect(() => {
		if (!open || !source || source === formSource) return;
		if (formSource?.id !== source.id) {
			setForm(toFormState(source));
		} else if (source.updatedAt < formSource.updatedAt) {
			// A cached copy from an earlier visit can be older than the caller's copy.
			return;
		} else {
			const loaded = toFormState(formSource);
			const newer = toFormState(source);
			setForm((prev) => rebaseFormState(prev, loaded, newer));
		}
		setFormSource(source);
	}, [open, source, formSource]);
	const formLoaded = shownBylineId === null || formSource?.id === shownBylineId;

	const validateForm = (): BylineFormErrors => {
		const errors: BylineFormErrors = {};
		if (!form.displayName.trim()) errors.displayName = t`Enter a display name.`;
		if (!form.slug) {
			errors.slug = t`Enter a slug.`;
		} else if (!BYLINE_SLUG_PATTERN.test(form.slug)) {
			errors.slug = t`Use lowercase letters, numbers, and hyphens, starting with a letter.`;
		}
		if (form.websiteUrl && !isHttpUrl(form.websiteUrl)) {
			errors.websiteUrl = t`Enter a full URL that starts with https:// or http://.`;
		}
		return errors;
	};
	const submitForm = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		// React bubbles events out of the dialog's portal to the components
		// that render it, so this submit would also reach the post editor's form.
		event.stopPropagation();
		if (isSaving || !formLoaded) return;
		const formElement = event.currentTarget;
		const errors = validateForm();
		// Render the errors before focusing so the field is announced as invalid.
		flushSync(() => setFormErrors(errors));
		const firstInvalid = errors.displayName
			? displayNameRef
			: errors.slug
				? slugRef
				: errors.websiteUrl
					? websiteUrlRef
					: null;
		if (firstInvalid) {
			firstInvalid.current?.focus();
			return;
		}
		// The form is noValidate, so custom URL fields need the browser's check run here.
		if (!formElement.reportValidity()) return;
		const values: BylineFormValues = {
			slug: form.slug,
			displayName: form.displayName,
			bio: form.bio || null,
			websiteUrl: form.websiteUrl || null,
			userId: form.userId,
			isGuest: form.isGuest,
			avatarMediaId: form.avatarMediaId,
		};
		// Without field definitions the custom-field inputs aren't shown, so
		// leave stored values untouched rather than echoing them back. A new
		// byline only sends custom fields that were filled in.
		if (
			!customFieldsError &&
			(shownBylineId !== null || Object.keys(form.customFields).length > 0)
		) {
			values.customFields = form.customFields;
		}
		saveMutation.mutate(values, { onSuccess: onSaved });
	};

	const description = source
		? (editDescription ?? t`Update the profile for ${source.displayName}.`)
		: shownBylineId
			? null
			: t`Add a person or team to credit on your content.`;

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next && isSaving) return;
				onOpenChange(next);
			}}
			onOpenChangeComplete={onOpenChangeComplete}
			disablePointerDismissal
		>
			<Dialog
				className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col overflow-hidden p-0 sm:w-[36rem]"
				size="lg"
			>
				<form noValidate onSubmit={submitForm} className="flex min-h-0 flex-1 flex-col">
					<div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-6 py-5">
						<div className="min-w-0">
							<Dialog.Title className="text-lg font-semibold">
								{shownBylineId ? t`Edit byline` : t`New byline`}
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
								{description}
							</Dialog.Description>
						</div>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button
									{...props}
									type="button"
									variant="ghost"
									shape="square"
									icon={<X className="size-4" aria-hidden="true" />}
									aria-label={t`Close`}
									disabled={isSaving}
								/>
							)}
						/>
					</div>

					<div className="emdash-auto-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-6">
						<fieldset disabled={!formLoaded} className="min-w-0 space-y-5">
							<Input
								ref={displayNameRef}
								label={t`Display name`}
								value={form.displayName}
								onChange={(e) => {
									const displayName = e.target.value;
									const followName = !shownBylineId && !slugEdited;
									const nameSlug = displayName.trim() ? toBylineSlug(displayName) : "";
									setForm((prev) => ({
										...prev,
										displayName,
										slug: followName ? nameSlug : prev.slug,
									}));
									setFormErrors((prev) => ({
										...prev,
										displayName: undefined,
										slug: followName ? undefined : prev.slug,
									}));
								}}
								error={formErrors.displayName}
								aria-invalid={!!formErrors.displayName || undefined}
								required
							/>
							<Input
								ref={slugRef}
								label={t`Slug`}
								dir="ltr"
								value={form.slug}
								onChange={(e) => {
									const slug = e.target.value;
									setSlugEdited(slug !== "");
									setForm((prev) => ({ ...prev, slug }));
									setFormErrors((prev) => ({ ...prev, slug: undefined }));
								}}
								description={
									!shownBylineId && !slugEdited
										? t`Filled in from the display name. Use lowercase letters, numbers, and hyphens.`
										: t`Use lowercase letters, numbers, and hyphens.`
								}
								error={formErrors.slug}
								aria-invalid={!!formErrors.slug || undefined}
								required
							/>
							<Input
								ref={websiteUrlRef}
								type="url"
								label={<OptionalLabel>{t`Website URL`}</OptionalLabel>}
								dir="ltr"
								placeholder={t`https://example.com`}
								value={form.websiteUrl}
								onChange={(e) => {
									const websiteUrl = e.target.value;
									setForm((prev) => ({ ...prev, websiteUrl }));
									setFormErrors((prev) => ({ ...prev, websiteUrl: undefined }));
								}}
								error={formErrors.websiteUrl}
								aria-invalid={!!formErrors.websiteUrl || undefined}
							/>
							<InputArea
								label={<OptionalLabel>{t`Bio`}</OptionalLabel>}
								value={form.bio}
								onChange={(e) => setForm((prev) => ({ ...prev, bio: e.target.value }))}
								rows={5}
							/>
							<BylineAvatarField
								value={form.avatarMediaId}
								onChange={(mediaId) => setForm((prev) => ({ ...prev, avatarMediaId: mediaId }))}
							/>
							<div className="space-y-4 border-t border-kumo-line pt-5">
								<div className="space-y-1">
									<h3 className="text-sm font-semibold">{t`Attribution`}</h3>
									<p className="text-sm text-kumo-subtle">
										{t`Link this byline to a user or mark it as a guest profile.`}
									</p>
								</div>
								<Select
									label={<OptionalLabel>{t`Linked user`}</OptionalLabel>}
									aria-label={t`Linked user`}
									value={form.userId ?? ""}
									onValueChange={(value) => {
										const userId = (value as string) || null;
										setForm((prev) => ({
											...prev,
											userId,
											isGuest: userId ? false : prev.isGuest,
										}));
									}}
									items={{
										"": t`No linked user`,
										...Object.fromEntries(users.map((user) => [user.id, getUserLabel(user)])),
									}}
									className="w-full"
								/>
								<Switch
									label={t`Guest byline`}
									checked={form.isGuest}
									onCheckedChange={(checked) =>
										setForm((prev) => ({
											...prev,
											isGuest: checked,
											userId: checked ? null : prev.userId,
										}))
									}
								/>
							</div>

							{customFieldDefs.length > 0 && (
								<div className="space-y-4 border-t border-kumo-line pt-5">
									<h3 className="text-sm font-semibold">{t`Additional details`}</h3>
									{customFieldDefs.map((field) => (
										<CustomFieldInput
											key={field.id}
											field={field}
											value={form.customFields[field.slug]}
											onChange={(next) =>
												setForm((prev) => ({
													...prev,
													customFields: {
														...prev.customFields,
														[field.slug]: next,
													},
												}))
											}
										/>
									))}
								</div>
							)}
							{customFieldsError && (
								<div className="rounded-md border border-kumo-danger/40 bg-kumo-danger/5 p-3 text-sm">
									<p className="font-medium text-kumo-danger">{t`Couldn't load custom fields.`}</p>
									<p className="mt-1 text-xs text-kumo-subtle">
										{t`You can still edit the fixed fields above. Saving will not touch any stored custom-field values.`}
									</p>
								</div>
							)}

							{source && renderExtra ? renderExtra(source) : null}
						</fieldset>
					</div>
					<DialogError
						message={getMutationError(saveMutation.error ?? error)}
						className="mx-6 mt-3"
					/>

					<div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-kumo-line px-6 py-4">
						{source && onDelete && (
							<Button
								type="button"
								variant="secondary-destructive"
								onClick={() => onDelete(source)}
								disabled={isSaving}
							>
								{t`Delete`}
							</Button>
						)}
						<div className="ms-auto flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								onClick={() => onOpenChange(false)}
								disabled={isSaving}
							>
								{t`Cancel`}
							</Button>
							<Button type="submit" variant="primary" disabled={!formLoaded || isSaving}>
								{isSaving ? t`Saving...` : shownBylineId ? t`Save` : (createLabel ?? t`Create`)}
							</Button>
						</div>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

/**
 * Renders a single registered byline custom field as the Kumo input for its
 * type. Empty string inputs become `null` on save, which clears the stored
 * value instead of storing an empty string.
 *
 * Fields that aren't `required` get an "(optional)" label marker. The
 * registry's `required` flag is descriptive rather than enforced in the
 * write path today, so required fields aren't blocked client-side.
 */
function CustomFieldInput({
	field,
	value,
	onChange,
}: {
	field: BylineFieldDefinition;
	value: unknown;
	onChange: (next: unknown) => void;
}) {
	const { t } = useLingui();
	const label = field.required ? field.label : <OptionalLabel>{field.label}</OptionalLabel>;
	const stringValue = typeof value === "string" ? value : "";

	switch (field.type) {
		case "string":
			return (
				<Input
					label={label}
					value={stringValue}
					onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
				/>
			);
		case "text":
			return (
				<InputArea
					label={label}
					value={stringValue}
					onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
					rows={3}
				/>
			);
		case "url":
			return (
				<Input
					type="url"
					label={label}
					value={stringValue}
					onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
				/>
			);
		case "boolean":
			// A registered boolean is always definite: no stored row means
			// `false`, and the Switch sends a real boolean that is persisted as is.
			return (
				<Switch
					label={field.label}
					checked={value === true}
					onCheckedChange={(checked) => onChange(checked)}
				/>
			);
		case "select": {
			const options = field.validation?.options ?? [];
			// Null-prototype object so options that collide with
			// `Object.prototype` keys (`__proto__`, `toString`) survive.
			const items: Record<string, string> = Object.create(null);
			items[""] = t`-- Select --`;
			for (const opt of options) items[opt] = opt;
			return (
				<Select
					label={label}
					aria-label={field.label}
					value={stringValue}
					onValueChange={(v) => onChange(!v ? null : v)}
					items={items}
					className="w-full"
				/>
			);
		}
	}
}
