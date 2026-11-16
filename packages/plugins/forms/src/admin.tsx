/**
 * Forms Plugin - Admin UI
 *
 * React components for the forms admin pages and dashboard widget.
 * Communicates with the plugin's API routes via fetch.
 */

import { Badge, Button, Checkbox, Input, InputArea, Loader, Select } from "@cloudflare/kumo";
import { LinguiContext } from "@lingui/react";
import {
	Plus,
	Trash,
	Copy,
	Pause,
	Play,
	PencilSimple,
	Star as StarIcon,
	Eye,
	Export,
	Envelope,
	ListBullets,
	ArrowLeft,
} from "@phosphor-icons/react";
import type { PluginAdminExports } from "emdash";
import { apiFetch as baseFetch, getErrorMessage, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import {
	type AdminMessage,
	FORMS_LOAD_FAILED,
	SUBMISSIONS_LOAD_FAILED,
	formsLoadError,
	submissionsLoadError,
	writeError,
} from "./admin-errors.js";
import type { FieldCondition } from "./types.js";

// =============================================================================
// Constants
// =============================================================================

const API = "/_emdash/api/plugins/emdash-forms";

const NON_ALNUM_PATTERN = /[^a-z0-9]+/g;
const LEADING_TRAILING_SEP = /^-|-$/g;
const LEADING_UNDERSCORE_TRIM = /^_|_$/g;
const LEADING_DIGIT = /^(\d)/;

// =============================================================================
// API Helpers
// =============================================================================

/** POST to a forms plugin API route with CSRF header. */
function apiFetch(route: string, body?: unknown): Promise<Response> {
	return baseFetch(`${API}/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
}

/**
 * POST a write route. On a non-ok response or a thrown error, reports a message
 * through `onError` (403 becomes a permission message) and returns null.
 */
async function apiWrite(
	i18n: AdminI18n,
	route: string,
	body: unknown,
	fallback: AdminMessage,
	onError: (message: string) => void,
): Promise<Response | null> {
	onError("");
	try {
		const res = await apiFetch(route, body);
		if (res.ok) return res;
		onError(i18n._(writeError(res, fallback)));
	} catch {
		onError(i18n._(fallback));
	}
	return null;
}

// =============================================================================
// Types (mirrors plugin types, kept minimal for admin use)
// =============================================================================

interface FormItem {
	id: string;
	name: string;
	slug: string;
	status: "active" | "paused";
	submissionCount: number;
	lastSubmissionAt: string | null;
	createdAt: string;
	updatedAt: string;
	pages: FormPage[];
	settings: FormSettings;
}

interface FormPage {
	title?: string;
	fields: FormField[];
}

interface FormField {
	id: string;
	type: string;
	label: string;
	name: string;
	placeholder?: string;
	helpText?: string;
	required: boolean;
	validation?: Record<string, unknown>;
	options?: Array<{ label: string; value: string }>;
	defaultValue?: string;
	condition?: FieldCondition;
	width: "full" | "half";
}

interface EditorField extends FormField {
	conditionFieldId?: string;
}

interface FormSettings {
	confirmationMessage: string;
	redirectUrl?: string;
	notifyEmails: string[];
	digestEnabled: boolean;
	digestHour: number;
	autoresponder?: { subject: string; body: string } | null;
	webhookUrl?: string;
	retentionDays: number;
	spamProtection: "none" | "honeypot" | "turnstile";
	submitLabel: string;
}

interface SubmissionItem {
	id: string;
	formId: string;
	data: Record<string, unknown>;
	status: "new" | "read" | "archived";
	starred: boolean;
	notes?: string;
	createdAt: string;
	meta: {
		country: string | null;
	};
}

// =============================================================================
// Shared Helpers
// =============================================================================

function EmptyState({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: React.ElementType;
	title: string;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<Icon className="h-10 w-10 text-muted-foreground/50 mb-3" />
			<h3 className="font-medium text-muted-foreground">{title}</h3>
			<p className="text-sm text-muted-foreground/70 mt-1 max-w-sm">{description}</p>
			{action && <div className="mt-4">{action}</div>}
		</div>
	);
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function formatDateTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** The part of Lingui's `I18n` the admin pages use. */
interface AdminI18n {
	_(id: string): string;
	_(descriptor: AdminMessage): string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Renders the English source message when no Lingui context is available. */
const sourceI18n: AdminI18n = {
	_: (message: string | AdminMessage) => {
		if (typeof message === "string") return message;
		const values = message.values ?? {};
		return message.message.replace(PLACEHOLDER, (match, key: string) =>
			key in values ? stringifyValue(values[key]) : match,
		);
	},
};

function useEditorI18n(): AdminI18n {
	// Older hosts may load a separate Lingui context for plugin source.
	return React.useContext(LinguiContext)?.i18n ?? sourceI18n;
}

function autoName(label: string): string {
	return label
		.toLowerCase()
		.replace(NON_ALNUM_PATTERN, "_")
		.replace(LEADING_UNDERSCORE_TRIM, "")
		.replace(LEADING_DIGIT, "_$1");
}

function autoSlugify(value: string): string {
	return value.toLowerCase().replace(NON_ALNUM_PATTERN, "-").replace(LEADING_TRAILING_SEP, "");
}

function stringifyValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

// =============================================================================
// Forms List Page
// =============================================================================

function FormsListPage() {
	const i18n = useEditorI18n();
	const [forms, setForms] = React.useState<FormItem[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [actionError, setActionError] = React.useState<string | null>(null);
	const [editingForm, setEditingForm] = React.useState<FormItem | null>(null);
	const [creating, setCreating] = React.useState(false);

	const loadForms = React.useCallback(async () => {
		try {
			const res = await apiFetch("forms/list");
			if (!res.ok) {
				setError(i18n._(formsLoadError(res)));
				return;
			}
			const data = await parseApiResponse<{ items: FormItem[] }>(res);
			setForms(data.items);
		} catch {
			setError(i18n._(FORMS_LOAD_FAILED));
		} finally {
			setLoading(false);
		}
	}, [i18n]);

	React.useEffect(() => {
		void loadForms();
	}, [loadForms]);

	const handleToggleStatus = async (form: FormItem) => {
		const newStatus = form.status === "active" ? "paused" : "active";
		const res = await apiWrite(
			i18n,
			"forms/update",
			{ id: form.id, status: newStatus },
			/*i18n*/ { id: "bVfpd4", message: "Failed to update form" },
			setActionError,
		);
		if (res) await loadForms();
	};

	const handleDuplicate = async (form: FormItem) => {
		const res = await apiWrite(
			i18n,
			"forms/duplicate",
			{ id: form.id },
			/*i18n*/ { id: "GZWYuE", message: "Failed to duplicate form" },
			setActionError,
		);
		if (res) await loadForms();
	};

	const handleDelete = async (form: FormItem) => {
		const question = i18n._({
			id: "dhF9WO",
			message: 'Delete "{name}" and all its submissions?',
			values: { name: form.name },
		});
		if (!confirm(question)) return;
		const res = await apiWrite(
			i18n,
			"forms/delete",
			{ id: form.id, deleteSubmissions: true },
			/*i18n*/ { id: "AB1bxU", message: "Failed to delete form" },
			setActionError,
		);
		if (res) await loadForms();
	};

	if (editingForm || creating) {
		return (
			<FormEditor
				form={editingForm}
				onSave={async () => {
					setEditingForm(null);
					setCreating(false);
					await loadForms();
				}}
				onCancel={() => {
					setEditingForm(null);
					setCreating(false);
				}}
			/>
		);
	}

	if (loading) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
				{error}
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold">{i18n._({ id: "CiIFml", message: "Forms" })}</h1>
					<p className="text-muted-foreground mt-1">
						{i18n._({ id: "4UngCy", message: "Create and manage forms" })}
					</p>
				</div>
				<Button icon={<Plus />} onClick={() => setCreating(true)}>
					{i18n._({ id: "u+L9YJ", message: "New Form" })}
				</Button>
			</div>

			{actionError && (
				<div
					role="alert"
					className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive"
				>
					{actionError}
				</div>
			)}

			{forms.length === 0 ? (
				<EmptyState
					icon={ListBullets}
					title={i18n._({ id: "5gwDCX", message: "No forms yet" })}
					description={i18n._({
						id: "cFnka8",
						message: "Create your first form to start collecting submissions.",
					})}
					action={
						<Button icon={<Plus />} onClick={() => setCreating(true)}>
							{i18n._({ id: "SKIBv0", message: "Create Form" })}
						</Button>
					}
				/>
			) : (
				<div className="border rounded-lg overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b bg-muted/50">
								<th className="text-start p-3 font-medium">
									{i18n._({ id: "6YtxFj", message: "Name" })}
								</th>
								<th className="text-start p-3 font-medium">
									{i18n._({ id: "L85WcV", message: "Slug" })}
								</th>
								<th className="text-start p-3 font-medium">
									{i18n._({ id: "uAQUqI", message: "Status" })}
								</th>
								<th className="text-end p-3 font-medium">
									{i18n._({ id: "LdA9gy", message: "Submissions" })}
								</th>
								<th className="text-start p-3 font-medium">
									{i18n._({ id: "c/ECAC", message: "Last Submission" })}
								</th>
								<th className="text-end p-3 font-medium">
									{i18n._({ id: "7L01XJ", message: "Actions" })}
								</th>
							</tr>
						</thead>
						<tbody>
							{forms.map((form) => (
								<tr key={form.id} className="border-b last:border-0 hover:bg-muted/30">
									<td className="p-3 font-medium">{form.name}</td>
									<td className="p-3 text-muted-foreground font-mono text-xs">{form.slug}</td>
									<td className="p-3">
										<Badge variant={form.status === "active" ? "success" : "warning"}>
											{statusLabel(i18n, FORM_STATUS_LABELS, form.status)}
										</Badge>
									</td>
									<td className="p-3 text-end tabular-nums">{form.submissionCount}</td>
									<td className="p-3 text-muted-foreground">
										{form.lastSubmissionAt
											? formatDate(form.lastSubmissionAt)
											: i18n._({ id: "qqeAJM", message: "Never" })}
									</td>
									<td className="p-3">
										<div className="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												shape="square"
												onClick={() => setEditingForm(form)}
												aria-label={i18n._({ id: "ePK91l", message: "Edit" })}
											>
												<PencilSimple className="h-4 w-4" />
											</Button>
											<Button
												variant="ghost"
												shape="square"
												onClick={() => void handleToggleStatus(form)}
												aria-label={
													form.status === "active"
														? i18n._({ id: "IgrLD/", message: "Pause" })
														: i18n._({ id: "v39wLo", message: "Resume" })
												}
											>
												{form.status === "active" ? (
													<Pause className="h-4 w-4" />
												) : (
													<Play className="h-4 w-4" />
												)}
											</Button>
											<Button
												variant="ghost"
												shape="square"
												onClick={() => void handleDuplicate(form)}
												aria-label={i18n._({ id: "euc6Ns", message: "Duplicate" })}
											>
												<Copy className="h-4 w-4" />
											</Button>
											<Button
												variant="ghost"
												shape="square"
												onClick={() => void handleDelete(form)}
												aria-label={i18n._({ id: "cnGeoo", message: "Delete" })}
												className="text-destructive"
											>
												<Trash className="h-4 w-4" />
											</Button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Form Editor (used for both create and edit)
// =============================================================================

const FIELD_TYPES = [
	"text",
	"email",
	"textarea",
	"number",
	"tel",
	"url",
	"date",
	"select",
	"radio",
	"checkbox",
	"checkbox-group",
	"file",
	"hidden",
] as const;

const FIELD_TYPE_LABELS: Record<(typeof FIELD_TYPES)[number], AdminMessage> = {
	text: /*i18n*/ { id: "xeiujy", message: "Text" },
	email: /*i18n*/ { id: "O3oNi5", message: "Email" },
	textarea: /*i18n*/ { id: "g+zzQs", message: "Long text" },
	number: /*i18n*/ { id: "HptUxX", message: "Number" },
	tel: /*i18n*/ { id: "zmwvG2", message: "Phone" },
	url: /*i18n*/ { id: "IagCbF", message: "URL" },
	date: /*i18n*/ { id: "mYGY3B", message: "Date" },
	select: /*i18n*/ { id: "rG3WVm", message: "Select" },
	radio: /*i18n*/ { id: "V+cKHO", message: "Radio buttons" },
	checkbox: /*i18n*/ { id: "G1XxbZ", message: "Checkbox" },
	"checkbox-group": /*i18n*/ { id: "nf0K9R", message: "Checkbox group" },
	file: /*i18n*/ { id: "J2eKUI", message: "File" },
	hidden: /*i18n*/ { id: "D+zLDD", message: "Hidden" },
};

// Honeypot and Turnstile are product names, so only "None" is translated.
const SPAM_ITEMS: Array<{ label: string | AdminMessage; value: string }> = [
	{ label: /*i18n*/ { id: "EdQY6l", message: "None" }, value: "none" },
	{ label: "Honeypot", value: "honeypot" },
	{ label: "Turnstile", value: "turnstile" },
];

const WIDTH_ITEMS: Array<{ label: AdminMessage; value: FormField["width"] }> = [
	{ label: /*i18n*/ { id: "g2Tj8R", message: "Full" }, value: "full" },
	{ label: /*i18n*/ { id: "sWlMe7", message: "Half" }, value: "half" },
];

const FORM_STATUS_LABELS: Record<FormItem["status"], AdminMessage> = {
	active: /*i18n*/ { id: "F6pfE9", message: "Active" },
	paused: /*i18n*/ { id: "URAE3q", message: "Paused" },
};

const SUBMISSION_STATUS_LABELS: Record<SubmissionItem["status"], AdminMessage> = {
	new: /*i18n*/ { id: "isRobC", message: "New" },
	read: /*i18n*/ { id: "cQlPDN", message: "Read" },
	archived: /*i18n*/ { id: "TdfEV7", message: "Archived" },
};

/** Label for a stored status, falling back to the raw value for unknown statuses. */
function statusLabel<S extends string>(
	i18n: AdminI18n,
	labels: Record<S, AdminMessage>,
	status: S,
): string {
	const label: AdminMessage | undefined = labels[status];
	return label ? i18n._(label) : status;
}

function FormEditor({
	form,
	onSave,
	onCancel,
}: {
	form: FormItem | null;
	onSave: () => void;
	onCancel: () => void;
}) {
	const i18n = useEditorI18n();
	const [name, setName] = React.useState(form?.name ?? "");
	const [slug, setSlug] = React.useState(form?.slug ?? "");
	const [fields, setFields] = React.useState<EditorField[]>(() => {
		const initialFields = form?.pages[0]?.fields ?? [];
		return initialFields.map((field) => ({
			...field,
			conditionFieldId: field.condition
				? initialFields.find((controller) => controller.name === field.condition?.field)?.id
				: undefined,
		}));
	});
	const [settings, setSettings] = React.useState<Partial<FormSettings>>(form?.settings ?? {});
	const [autoresponderEnabled, setAutoresponderEnabled] = React.useState(
		form?.settings.autoresponder != null,
	);
	const [autoresponderDraft, setAutoresponderDraft] = React.useState(
		form?.settings.autoresponder ?? { subject: "", body: "" },
	);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [turnstileStatus, setTurnstileStatus] = React.useState<{
		hasSiteKey: boolean;
		hasSecretKey: boolean;
	} | null>(null);

	const spamProtection = settings.spamProtection ?? "honeypot";

	React.useEffect(() => {
		if (spamProtection !== "turnstile") return;
		void (async () => {
			try {
				const res = await apiFetch("settings/turnstile-status");
				if (res.ok) {
					setTurnstileStatus(await parseApiResponse(res));
				}
			} catch {
				// ignore — warning just won't show
			}
		})();
	}, [spamProtection]);

	const isNew = !form;

	const handleNameChange = (value: string) => {
		setName(value);
		if (isNew) {
			setSlug(autoSlugify(value));
		}
	};

	const addField = () => {
		setFields((prev) => [
			...prev,
			{
				id: crypto.randomUUID(),
				type: "text",
				label: "",
				name: "",
				required: false,
				width: "full" as const,
			},
		]);
	};

	const updateField = (index: number, updates: Partial<EditorField>) => {
		setFields((prev) =>
			prev.map((field, i) => {
				const updated = i === index ? { ...field, ...updates } : field;
				if (
					updates.name !== undefined &&
					updated.condition &&
					updated.conditionFieldId === prev[index]?.id
				) {
					return { ...updated, condition: { ...updated.condition, field: updates.name } };
				}
				return updated;
			}),
		);
	};

	const removeField = (index: number) => {
		setFields((prev) =>
			prev
				.filter((_, i) => i !== index)
				.map((field) =>
					field.conditionFieldId === prev[index]?.id
						? { ...field, condition: undefined, conditionFieldId: undefined }
						: field,
				),
		);
	};

	const moveField = (index: number, direction: -1 | 1) => {
		const target = index + direction;
		if (target < 0 || target >= fields.length) return;
		setFields((prev) => {
			const next = [...prev];
			[next[index], next[target]] = [next[target]!, next[index]!];
			return next;
		});
	};

	const handleSave = async () => {
		if (!name.trim() || !slug.trim()) {
			setError(i18n._({ id: "K1atiw", message: "Name and slug are required" }));
			return;
		}
		if (fields.length === 0) {
			setError(i18n._({ id: "rWAciq", message: "At least one field is required" }));
			return;
		}
		for (const f of fields) {
			if (!f.label.trim() || !f.name.trim()) {
				setError(i18n._({ id: "PhJs/l", message: "All fields must have a label and name" }));
				return;
			}
		}

		if (
			autoresponderEnabled &&
			(!autoresponderDraft.subject.trim() || !autoresponderDraft.body.trim())
		) {
			setError(i18n._("Autoresponder subject and body are required"));
			return;
		}

		setSaving(true);
		setError(null);

		const savedSettings = {
			...settings,
			autoresponder: autoresponderEnabled ? autoresponderDraft : form ? null : undefined,
		};
		const savedFields = fields.map(({ conditionFieldId: _controllerId, ...field }) => field);
		const payload = form
			? {
					id: form.id,
					name,
					slug,
					pages: [{ fields: savedFields }],
					settings: savedSettings,
				}
			: {
					name,
					slug,
					pages: [{ fields: savedFields }],
					settings: {
						confirmationMessage: "Thank you for your submission.",
						notifyEmails: [],
						digestEnabled: false,
						digestHour: 9,
						retentionDays: 0,
						spamProtection: "honeypot",
						submitLabel: "Submit",
						...savedSettings,
					},
				};

		try {
			const route = form ? "forms/update" : "forms/create";
			const res = await apiFetch(route, payload);
			if (!res.ok) {
				setError(
					await getErrorMessage(res, i18n._({ id: "ckCX7Q", message: "Failed to save form" })),
				);
				return;
			}
			onSave();
		} catch {
			setError(i18n._({ id: "ckCX7Q", message: "Failed to save form" }));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<Button
					variant="ghost"
					shape="square"
					onClick={onCancel}
					aria-label={i18n._({ id: "iH8pgl", message: "Back" })}
				>
					<ArrowLeft className="h-5 w-5 rtl:-scale-x-100" />
				</Button>
				<div>
					<h1 className="text-3xl font-bold">
						{form
							? i18n._({ id: "dVuW4v", message: "Edit Form" })
							: i18n._({ id: "u+L9YJ", message: "New Form" })}
					</h1>
					{form && (
						<p className="text-muted-foreground mt-0.5 text-sm">
							{i18n._({ id: "7kzmXB", message: "Editing: {name}", values: { name: form.name } })}
						</p>
					)}
				</div>
			</div>

			{error && (
				<div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
					{error}
				</div>
			)}

			{/* Name & Slug */}
			<div className="grid grid-cols-2 gap-4">
				<Input
					label={i18n._({ id: "6YtxFj", message: "Name" })}
					value={name}
					onChange={(e) => handleNameChange(e.target.value)}
					placeholder={i18n._({ id: "yIV1sM", message: "Contact Form" })}
				/>
				<Input
					label={i18n._({ id: "L85WcV", message: "Slug" })}
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
					placeholder="contact-form"
				/>
			</div>

			{/* Fields */}
			<div>
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-lg font-semibold">{i18n._({ id: "vF68cg", message: "Fields" })}</h2>
					<Button variant="outline" icon={<Plus />} onClick={addField}>
						{i18n._({ id: "DpV70M", message: "Add Field" })}
					</Button>
				</div>

				{fields.length === 0 ? (
					<div className="border border-dashed rounded-lg p-8 text-center text-sm text-muted-foreground">
						{i18n._({ id: "xfRhsl", message: 'No fields yet. Click "Add Field" to get started.' })}
					</div>
				) : (
					<div className="space-y-3">
						{fields.map((field, index) => (
							<FieldRow
								key={field.id}
								field={field}
								fields={fields}
								index={index}
								total={fields.length}
								onChange={(updates) => updateField(index, updates)}
								onRemove={() => removeField(index)}
								onMove={(dir) => moveField(index, dir)}
							/>
						))}
					</div>
				)}
			</div>

			{/* Settings */}
			<div>
				<h2 className="text-lg font-semibold mb-3">
					{i18n._({ id: "Tz0i8g", message: "Settings" })}
				</h2>
				<div className="grid grid-cols-2 gap-4">
					<Input
						label={i18n._({ id: "mg3VPY", message: "Confirmation Message" })}
						value={settings.confirmationMessage ?? "Thank you for your submission."}
						onChange={(e) =>
							setSettings((s) => ({
								...s,
								confirmationMessage: e.target.value,
							}))
						}
					/>
					<Input
						label={i18n._({ id: "2qW+kp", message: "Submit Button Label" })}
						value={settings.submitLabel ?? "Submit"}
						onChange={(e) => setSettings((s) => ({ ...s, submitLabel: e.target.value }))}
					/>
					<div>
						<Select
							label={i18n._({ id: "RF16o7", message: "Spam Protection" })}
							hideLabel={false}
							value={spamProtection}
							onValueChange={(v) =>
								setSettings((s) => ({
									...s,
									spamProtection: (v ?? "honeypot") as FormSettings["spamProtection"],
								}))
							}
							items={SPAM_ITEMS.map((item) => ({
								label: typeof item.label === "string" ? item.label : i18n._(item.label),
								value: item.value,
							}))}
						/>
					</div>
					{spamProtection === "turnstile" &&
						turnstileStatus &&
						(!turnstileStatus.hasSiteKey || !turnstileStatus.hasSecretKey) && (
							<div className="col-span-2 rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-3 text-sm text-yellow-200">
								{!turnstileStatus.hasSiteKey && !turnstileStatus.hasSecretKey
									? i18n._({
											id: "tRMIEC",
											message:
												"Turnstile requires a site key and secret key. Neither is configured. Set them in the plugin settings.",
										})
									: !turnstileStatus.hasSiteKey
										? i18n._({
												id: "JRm2sB",
												message:
													"Turnstile requires a site key and secret key. Site key is missing. Set them in the plugin settings.",
											})
										: i18n._({
												id: "+JAyHS",
												message:
													"Turnstile requires a site key and secret key. Secret key is missing. Set them in the plugin settings.",
											})}
							</div>
						)}
					<Input
						label={i18n._({ id: "yOTVVa", message: "Retention (days, 0 = forever)" })}
						type="number"
						value={String(settings.retentionDays ?? 0)}
						onChange={(e) =>
							setSettings((s) => ({
								...s,
								retentionDays: parseInt(e.target.value) || 0,
							}))
						}
					/>
					<Checkbox
						label={i18n._("Daily digest")}
						checked={settings.digestEnabled ?? false}
						onCheckedChange={(checked) => setSettings((s) => ({ ...s, digestEnabled: checked }))}
					/>
					{settings.digestEnabled && (
						<Select
							label={i18n._("Digest hour (UTC)")}
							hideLabel={false}
							value={String(settings.digestHour ?? 9)}
							onValueChange={(v) => setSettings((s) => ({ ...s, digestHour: Number(v ?? 9) }))}
							items={Array.from({ length: 24 }, (_, hour) => ({
								label: `${String(hour).padStart(2, "0")}:00`,
								value: String(hour),
							}))}
						/>
					)}
					<p className="col-span-2 text-sm text-kumo-subtle">
						{i18n._(
							"Send a daily summary to the notification recipients instead of an email for each submission. Email must be configured.",
						)}
					</p>
					<div className="col-span-2 space-y-3">
						<Checkbox
							label={i18n._("Send an autoresponder")}
							checked={autoresponderEnabled}
							onCheckedChange={setAutoresponderEnabled}
						/>
						<p className="text-sm text-kumo-subtle">
							{i18n._(
								"Send a reply to the first email field in the form. Email must be configured.",
							)}
						</p>
						{autoresponderEnabled && (
							<>
								<Input
									label={i18n._("Autoresponder subject")}
									value={autoresponderDraft.subject}
									onChange={(e) =>
										setAutoresponderDraft((draft) => ({ ...draft, subject: e.target.value }))
									}
								/>
								<InputArea
									label={i18n._("Autoresponder body")}
									value={autoresponderDraft.body}
									onChange={(e) =>
										setAutoresponderDraft((draft) => ({ ...draft, body: e.target.value }))
									}
								/>
							</>
						)}
					</div>
					<div className="col-span-2">
						<Input
							label={i18n._("Webhook URL (optional)")}
							type="url"
							value={settings.webhookUrl ?? ""}
							onChange={(e) => setSettings((s) => ({ ...s, webhookUrl: e.target.value }))}
						/>
					</div>
					<div className="col-span-2">
						<Input
							label={i18n._({ id: "hHrp76", message: "Redirect URL (optional)" })}
							type="url"
							value={settings.redirectUrl ?? ""}
							onChange={(e) => setSettings((s) => ({ ...s, redirectUrl: e.target.value }))}
							placeholder="https://example.com/thank-you"
						/>
					</div>
				</div>
			</div>

			{/* Actions */}
			<div className="flex items-center gap-3 pt-4 border-t">
				<Button onClick={() => void handleSave()} disabled={saving}>
					{saving && <Loader />}
					{form
						? i18n._({ id: "IUwGEM", message: "Save Changes" })
						: i18n._({ id: "SKIBv0", message: "Create Form" })}
				</Button>
				<Button variant="outline" onClick={onCancel}>
					{i18n._({ id: "dEgA5A", message: "Cancel" })}
				</Button>
			</div>
		</div>
	);
}

// =============================================================================
// Field Row (inline field editor within FormEditor)
// =============================================================================

function FieldRow({
	field,
	fields,
	index,
	total,
	onChange,
	onRemove,
	onMove,
}: {
	field: EditorField;
	fields: EditorField[];
	index: number;
	total: number;
	onChange: (updates: Partial<EditorField>) => void;
	onRemove: () => void;
	onMove: (direction: -1 | 1) => void;
}) {
	const i18n = useEditorI18n();
	const conditionFields = fields.filter(
		(f) =>
			f.id !== field.id &&
			((f.name && !["checkbox-group", "file"].includes(f.type)) || f.id === field.conditionFieldId),
	);
	const conditionItems = [
		{ label: i18n._("Always visible"), value: "" },
		...conditionFields.map((f) => ({
			label: f.name ? `${f.label} (${f.name})` : f.label || i18n._("Unnamed field"),
			value: `id:${f.id}`,
		})),
	];
	const conditionValue = field.conditionFieldId
		? `id:${field.conditionFieldId}`
		: field.condition
			? `name:${field.condition.field}`
			: "";
	if (field.condition && !conditionItems.some((item) => item.value === conditionValue)) {
		conditionItems.push({ label: field.condition.field, value: conditionValue });
	}
	const needsOptions = ["select", "radio", "checkbox-group"].includes(field.type);

	const handleLabelChange = (label: string) => {
		const updates: Partial<FormField> = { label };
		if (!field.name || field.name === autoName(field.label)) {
			updates.name = autoName(label);
		}
		onChange(updates);
	};

	return (
		<div className="border rounded-lg p-3 space-y-3">
			<div className="flex items-start gap-2">
				<span className="text-xs text-muted-foreground font-mono w-6 text-center pt-8">
					{index + 1}
				</span>
				<div className="flex-1 space-y-2">
					<div className="grid grid-cols-2 gap-2">
						<Input
							label={i18n._({ id: "87a/t/", message: "Label" })}
							value={field.label}
							onChange={(e) => handleLabelChange(e.target.value)}
						/>
						<Input
							label={i18n._({ id: "6YtxFj", message: "Name" })}
							value={field.name}
							onChange={(e) => onChange({ name: e.target.value })}
						/>
					</div>
					<div className="flex items-end gap-4">
						<Select
							label={i18n._({ id: "+zy2Nq", message: "Type" })}
							hideLabel={false}
							value={field.type}
							onValueChange={(v) => onChange({ type: v ?? "text" })}
							items={FIELD_TYPES.map((type) => ({
								label: i18n._(FIELD_TYPE_LABELS[type]),
								value: type,
							}))}
						/>
						<Select
							label={i18n._({ id: "aFWU1n", message: "Width" })}
							hideLabel={false}
							value={field.width}
							onValueChange={(v) => onChange({ width: v ?? "full" })}
							items={WIDTH_ITEMS.map((item) => ({ label: i18n._(item.label), value: item.value }))}
						/>
						<div className="flex h-9 items-center">
							<Checkbox
								label={i18n._({ id: "TMLAx2", message: "Required" })}
								checked={field.required}
								onCheckedChange={(checked) => onChange({ required: checked })}
							/>
						</div>
					</div>
				</div>
				<div className="flex items-center gap-0.5 pt-6">
					<Button
						variant="ghost"
						shape="square"
						onClick={() => onMove(-1)}
						disabled={index === 0}
						aria-label={i18n._({ id: "QyioBP", message: "Move up" })}
					>
						&#9650;
					</Button>
					<Button
						variant="ghost"
						shape="square"
						onClick={() => onMove(1)}
						disabled={index === total - 1}
						aria-label={i18n._({ id: "3Ib6FN", message: "Move down" })}
					>
						&#9660;
					</Button>
					<Button
						variant="ghost"
						shape="square"
						onClick={onRemove}
						aria-label={i18n._({ id: "t/YqKh", message: "Remove" })}
						className="text-destructive"
					>
						<Trash className="h-3.5 w-3.5" />
					</Button>
				</div>
			</div>

			<div className="ms-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
				{(["text", "email", "textarea", "number", "tel", "url"].includes(field.type) ||
					(field.type === "select" && field.required)) && (
					<Input
						label={i18n._("Placeholder")}
						value={field.placeholder ?? ""}
						onChange={(e) => onChange({ placeholder: e.target.value })}
					/>
				)}
				{field.type !== "hidden" && (
					<Input
						label={i18n._("Help text")}
						value={field.helpText ?? ""}
						onChange={(e) => onChange({ helpText: e.target.value })}
					/>
				)}
				{!["checkbox", "checkbox-group", "file"].includes(field.type) && (
					<Input
						label={i18n._("Default value")}
						value={field.defaultValue ?? ""}
						onChange={(e) => onChange({ defaultValue: e.target.value })}
					/>
				)}
			</div>
			<div className="ms-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
				<Select
					label={i18n._("Show when field")}
					hideLabel={false}
					value={conditionValue}
					items={conditionItems}
					onValueChange={(value) => {
						if (!value) {
							onChange({ condition: undefined, conditionFieldId: undefined });
							return;
						}
						const controller = conditionFields.find((f) => `id:${f.id}` === value);
						if (!controller) return;
						onChange({
							conditionFieldId: controller.id,
							condition: {
								field: controller.name,
								op: field.condition?.op ?? "filled",
								value: field.condition?.value ?? "",
							},
						});
					}}
				/>
				{field.condition && (
					<>
						<Select
							label={i18n._("Condition operator")}
							hideLabel={false}
							value={field.condition.op}
							items={[
								{ label: i18n._("Equals"), value: "eq" },
								{ label: i18n._("Does not equal"), value: "neq" },
								{ label: i18n._("Is filled"), value: "filled" },
								{ label: i18n._("Is empty"), value: "empty" },
							]}
							onValueChange={(op) =>
								onChange({
									condition: { ...field.condition!, op: (op ?? "eq") as FieldCondition["op"] },
								})
							}
						/>
						{["eq", "neq"].includes(field.condition.op) && (
							<Input
								label={i18n._("Condition value")}
								value={field.condition.value ?? ""}
								onChange={(e) =>
									onChange({ condition: { ...field.condition!, value: e.target.value } })
								}
							/>
						)}
					</>
				)}
			</div>

			{needsOptions && (
				<OptionsEditor
					options={field.options ?? []}
					onChange={(options) => onChange({ options })}
				/>
			)}
		</div>
	);
}

function OptionsEditor({
	options,
	onChange,
}: {
	options: Array<{ label: string; value: string }>;
	onChange: (options: Array<{ label: string; value: string }>) => void;
}) {
	const i18n = useEditorI18n();
	const addOption = () => onChange([...options, { label: "", value: "" }]);
	const updateOption = (index: number, updates: Partial<{ label: string; value: string }>) => {
		const next = options.map((o, i) => {
			if (i !== index) return o;
			const updated = { ...o, ...updates };
			if (updates.label && (!o.value || o.value === autoName(o.label))) {
				updated.value = autoName(updates.label);
			}
			return updated;
		});
		onChange(next);
	};
	const removeOption = (index: number) => onChange(options.filter((_, i) => i !== index));

	return (
		<div className="ms-8 space-y-1">
			<span className="text-xs text-muted-foreground">
				{i18n._({ id: "AmPPq5", message: "Options:" })}
			</span>
			{options.map((opt, i) => (
				<div key={i} className="flex items-center gap-2">
					<Input
						value={opt.label}
						onChange={(e) => updateOption(i, { label: e.target.value })}
						placeholder={i18n._({ id: "87a/t/", message: "Label" })}
					/>
					<Input
						value={opt.value}
						onChange={(e) => updateOption(i, { value: e.target.value })}
						placeholder={i18n._({ id: "50QwC8", message: "value" })}
					/>
					<Button
						variant="ghost"
						shape="square"
						onClick={() => removeOption(i)}
						className="text-destructive"
						aria-label={i18n._({ id: "00Lxnh", message: "Remove option" })}
					>
						<Trash className="h-3 w-3" />
					</Button>
				</div>
			))}
			<button
				type="button"
				onClick={addOption}
				className="text-xs text-muted-foreground hover:text-foreground"
			>
				{i18n._({ id: "n5QwOT", message: "+ Add option" })}
			</button>
		</div>
	);
}

// =============================================================================
// Submissions Page
// =============================================================================

function latestSubmittedForm(forms: FormItem[]): FormItem | undefined {
	let latest: FormItem | undefined;
	for (const form of forms) {
		if (form.submissionCount === 0) continue;
		if (!latest || (form.lastSubmissionAt ?? "") > (latest.lastSubmissionAt ?? "")) {
			latest = form;
		}
	}
	return latest ?? forms[0];
}

function SubmissionsPage() {
	const i18n = useEditorI18n();
	const [forms, setForms] = React.useState<FormItem[]>([]);
	const [selectedFormId, setSelectedFormId] = React.useState<string>("");
	const [submissions, setSubmissions] = React.useState<SubmissionItem[]>([]);
	const [canManage, setCanManage] = React.useState(false);
	const [statusFilter, setStatusFilter] = React.useState<string>("");
	const [loading, setLoading] = React.useState(true);
	const [subsLoading, setSubsLoading] = React.useState(false);
	const [selectedSub, setSelectedSub] = React.useState<SubmissionItem | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [subsError, setSubsError] = React.useState<string | null>(null);
	const [actionError, setActionError] = React.useState<string | null>(null);

	React.useEffect(() => {
		void (async () => {
			try {
				const res = await apiFetch("forms/list");
				if (!res.ok) {
					setError(i18n._(formsLoadError(res)));
					return;
				}
				const data = await parseApiResponse<{ items: FormItem[] }>(res);
				setForms(data.items);
				const initialForm = latestSubmittedForm(data.items);
				if (initialForm) {
					setSelectedFormId(initialForm.id);
				}
			} catch {
				setError(i18n._(FORMS_LOAD_FAILED));
			} finally {
				setLoading(false);
			}
		})();
	}, [i18n]);

	React.useEffect(() => {
		if (!selectedFormId) return;
		let stale = false;
		setSubsLoading(true);
		setCanManage(false);
		setSubsError(null);
		setActionError(null);
		setSelectedSub(null);
		void (async () => {
			try {
				const body: Record<string, unknown> = {
					formId: selectedFormId,
					limit: 50,
				};
				if (statusFilter) body.status = statusFilter;
				const res = await apiFetch("submissions/list", body);
				if (stale) return;
				if (!res.ok) {
					setSubmissions([]);
					setSubsError(i18n._(submissionsLoadError(res)));
					return;
				}
				const data = await parseApiResponse<{
					items: SubmissionItem[];
					canManage?: boolean;
				}>(res);
				if (stale) return;
				setSubmissions(data.items);
				setCanManage(data.canManage === true);
			} catch {
				if (stale) return;
				setSubmissions([]);
				setSubsError(i18n._(SUBMISSIONS_LOAD_FAILED));
			} finally {
				if (!stale) setSubsLoading(false);
			}
		})();
		return () => {
			stale = true;
		};
	}, [i18n, selectedFormId, statusFilter]);

	const handleToggleStar = async (sub: SubmissionItem) => {
		const res = await apiWrite(
			i18n,
			"submissions/update",
			{ id: sub.id, starred: !sub.starred },
			/*i18n*/ { id: "sH3BT9", message: "Failed to update submission" },
			setActionError,
		);
		if (res) {
			setSubmissions((prev) =>
				prev.map((s) => (s.id === sub.id ? { ...s, starred: !s.starred } : s)),
			);
			if (selectedSub?.id === sub.id) setSelectedSub({ ...selectedSub, starred: !sub.starred });
		}
	};

	const handleMarkRead = async (sub: SubmissionItem) => {
		const newStatus = sub.status === "new" ? "read" : sub.status === "read" ? "archived" : "new";
		const res = await apiWrite(
			i18n,
			"submissions/update",
			{ id: sub.id, status: newStatus },
			/*i18n*/ { id: "sH3BT9", message: "Failed to update submission" },
			setActionError,
		);
		if (res) {
			setSubmissions((prev) =>
				prev.map((s) => (s.id === sub.id ? { ...s, status: newStatus } : s)),
			);
			if (selectedSub?.id === sub.id) setSelectedSub({ ...selectedSub, status: newStatus });
		}
	};

	const handleDelete = async (sub: SubmissionItem) => {
		if (!confirm(i18n._({ id: "QkTGAA", message: "Delete this submission?" }))) return;
		const res = await apiWrite(
			i18n,
			"submissions/delete",
			{ id: sub.id },
			/*i18n*/ { id: "6XEmGy", message: "Failed to delete submission" },
			setActionError,
		);
		if (res) {
			setSubmissions((prev) => prev.filter((s) => s.id !== sub.id));
			if (selectedSub?.id === sub.id) setSelectedSub(null);
		}
	};

	const handleExport = async (format: "csv" | "json") => {
		if (!selectedFormId) return;
		const res = await apiWrite(
			i18n,
			"submissions/export",
			{ formId: selectedFormId, format },
			/*i18n*/ { id: "zfOJix", message: "Failed to export submissions" },
			setActionError,
		);
		if (!res) return;
		try {
			const data = await parseApiResponse<{ data: string; filename?: string }>(res);
			const blob = new Blob([format === "csv" ? data.data : JSON.stringify(data.data, null, 2)], {
				type: format === "csv" ? "text/csv" : "application/json",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = data.filename ?? `submissions.${format}`;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			setActionError(i18n._({ id: "zfOJix", message: "Failed to export submissions" }));
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<h1 className="text-3xl font-bold">{i18n._({ id: "LdA9gy", message: "Submissions" })}</h1>
				<div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
					{error}
				</div>
			</div>
		);
	}

	if (forms.length === 0) {
		return (
			<div className="space-y-6">
				<h1 className="text-3xl font-bold">{i18n._({ id: "LdA9gy", message: "Submissions" })}</h1>
				<EmptyState
					icon={Envelope}
					title={i18n._({ id: "5gwDCX", message: "No forms yet" })}
					description={i18n._({
						id: "Huq8wG",
						message: "Create a form first, then submissions will appear here.",
					})}
				/>
			</div>
		);
	}

	const selectedForm = forms.find((f) => f.id === selectedFormId);
	const formItems = forms.map((f) => ({ label: f.name, value: f.id }));
	const statusItems = [
		{ label: i18n._({ id: "qwHj/3", message: "All Status" }), value: "" },
		{ label: i18n._(SUBMISSION_STATUS_LABELS.new), value: "new" },
		{ label: i18n._(SUBMISSION_STATUS_LABELS.read), value: "read" },
		{ label: i18n._(SUBMISSION_STATUS_LABELS.archived), value: "archived" },
	];

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-3xl font-bold">{i18n._({ id: "LdA9gy", message: "Submissions" })}</h1>
				{canManage && (
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							icon={<Export />}
							onClick={() => void handleExport("csv")}
							disabled={submissions.length === 0}
						>
							CSV
						</Button>
						<Button
							variant="outline"
							icon={<Export />}
							onClick={() => void handleExport("json")}
							disabled={submissions.length === 0}
						>
							JSON
						</Button>
					</div>
				)}
			</div>

			{actionError && (
				<div
					role="alert"
					className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive"
				>
					{actionError}
				</div>
			)}

			{/* Filters */}
			<div className="flex items-center gap-3">
				<div className="w-56">
					<Select
						value={selectedFormId}
						onValueChange={(v) => setSelectedFormId(v ?? "")}
						items={formItems}
						aria-label={i18n._({ id: "+swMb1", message: "Select form" })}
					/>
				</div>
				<div className="w-40">
					<Select
						value={statusFilter}
						onValueChange={(v) => setStatusFilter(v ?? "")}
						items={statusItems}
						aria-label={i18n._({ id: "KwybLi", message: "Filter by status" })}
					/>
				</div>
				{selectedForm && (
					<span className="text-sm text-muted-foreground">
						{i18n._({
							id: "PYD5ka",
							message: "{count} total",
							values: { count: selectedForm.submissionCount },
						})}
					</span>
				)}
			</div>

			<div className="flex gap-6">
				{/* Submissions table */}
				<div className="flex-1 min-w-0">
					{subsLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader />
						</div>
					) : subsError ? (
						<div
							role="alert"
							className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive"
						>
							{subsError}
						</div>
					) : submissions.length === 0 ? (
						<EmptyState
							icon={Envelope}
							title={i18n._({ id: "uNRdQ+", message: "No submissions" })}
							description={
								statusFilter
									? i18n._({ id: "A1nBzx", message: "No submissions match the current filter." })
									: i18n._({
											id: "zGSzIi",
											message: "This form hasn't received any submissions yet.",
										})
							}
						/>
					) : (
						<div className="border rounded-lg overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b bg-muted/50">
										<th className="w-8 p-3" />
										<th className="text-start p-3 font-medium">
											{i18n._({ id: "mYGY3B", message: "Date" })}
										</th>
										<th className="text-start p-3 font-medium">
											{i18n._({ id: "rdUucN", message: "Preview" })}
										</th>
										<th className="text-start p-3 font-medium">
											{i18n._({ id: "uAQUqI", message: "Status" })}
										</th>
										{canManage && (
											<th className="text-end p-3 font-medium">
												{i18n._({ id: "7L01XJ", message: "Actions" })}
											</th>
										)}
									</tr>
								</thead>
								<tbody>
									{submissions.map((sub) => {
										const previewValues = Object.entries(sub.data)
											.filter(([, v]) => typeof v === "string" && v.length > 0)
											.slice(0, 2)
											.map(([, v]) => String(v))
											.join(" / ");

										return (
											<tr
												key={sub.id}
												className={`border-b last:border-0 hover:bg-muted/30 cursor-pointer ${
													selectedSub?.id === sub.id ? "bg-muted/50" : ""
												}`}
												onClick={() => setSelectedSub(sub)}
											>
												<td className="p-3">
													{canManage ? (
														<button
															type="button"
															onClick={(e) => {
																e.stopPropagation();
																void handleToggleStar(sub);
															}}
															className="text-yellow-500 hover:text-yellow-600"
														>
															{sub.starred ? (
																<StarIcon className="h-4 w-4" weight="fill" />
															) : (
																<StarIcon className="h-4 w-4" />
															)}
														</button>
													) : (
														<span className="text-yellow-500" aria-hidden="true">
															<StarIcon
																className="h-4 w-4"
																weight={sub.starred ? "fill" : "regular"}
															/>
														</span>
													)}
												</td>
												<td className="p-3 text-muted-foreground whitespace-nowrap">
													{formatDate(sub.createdAt)}
												</td>
												<td className="p-3 truncate max-w-xs">
													{previewValues || (
														<span className="text-muted-foreground italic">
															{i18n._({ id: "N2S1rs", message: "Empty" })}
														</span>
													)}
												</td>
												<td className="p-3">
													<Badge
														variant={
															sub.status === "new"
																? "success"
																: sub.status === "archived"
																	? "default"
																	: "warning"
														}
													>
														{statusLabel(i18n, SUBMISSION_STATUS_LABELS, sub.status)}
													</Badge>
												</td>
												{canManage && (
													<td className="p-3 text-end">
														<div className="flex items-center justify-end gap-1">
															<Button
																variant="ghost"
																shape="square"
																onClick={(e: React.MouseEvent) => {
																	e.stopPropagation();
																	void handleMarkRead(sub);
																}}
																aria-label={i18n._({ id: "kkk4nT", message: "Toggle status" })}
															>
																<Eye className="h-4 w-4" />
															</Button>
															<Button
																variant="ghost"
																shape="square"
																className="text-destructive"
																onClick={(e: React.MouseEvent) => {
																	e.stopPropagation();
																	void handleDelete(sub);
																}}
																aria-label={i18n._({ id: "cnGeoo", message: "Delete" })}
															>
																<Trash className="h-4 w-4" />
															</Button>
														</div>
													</td>
												)}
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					)}
				</div>

				{/* Detail panel */}
				{selectedSub && (
					<div className="w-80 shrink-0 border rounded-lg p-4 space-y-4 self-start sticky top-4">
						<div className="flex items-center justify-between">
							<h3 className="font-semibold">
								{i18n._({ id: "WcVAO+", message: "Submission Detail" })}
							</h3>
							<Badge
								variant={
									selectedSub.status === "new"
										? "success"
										: selectedSub.status === "archived"
											? "default"
											: "warning"
								}
							>
								{statusLabel(i18n, SUBMISSION_STATUS_LABELS, selectedSub.status)}
							</Badge>
						</div>
						<p className="text-xs text-muted-foreground">{formatDateTime(selectedSub.createdAt)}</p>

						<dl className="space-y-2">
							{Object.entries(selectedSub.data).map(([key, value]) => (
								<div key={key}>
									<dt className="text-xs font-medium text-muted-foreground">{key}</dt>
									<dd className="text-sm mt-0.5 break-words">{stringifyValue(value)}</dd>
								</div>
							))}
						</dl>

						{selectedSub.meta.country && (
							<p className="text-xs text-muted-foreground">
								{i18n._({
									id: "yAB3Mn",
									message: "Country: {country}",
									values: { country: selectedSub.meta.country },
								})}
							</p>
						)}

						{selectedSub.notes && (
							<div>
								<dt className="text-xs font-medium text-muted-foreground">
									{i18n._({ id: "1DBGsz", message: "Notes" })}
								</dt>
								<dd className="text-sm mt-0.5">{selectedSub.notes}</dd>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// =============================================================================
// Dashboard Widget
// =============================================================================

function RecentSubmissionsWidget() {
	const i18n = useEditorI18n();
	const [forms, setForms] = React.useState<FormItem[]>([]);
	const [submissions, setSubmissions] = React.useState<SubmissionItem[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		void (async () => {
			let failure = FORMS_LOAD_FAILED;
			try {
				const formsRes = await apiFetch("forms/list");
				if (!formsRes.ok) {
					setError(i18n._(formsLoadError(formsRes)));
					return;
				}
				const formsData = await parseApiResponse<{ items: FormItem[] }>(formsRes);
				setForms(formsData.items);

				const latestForm = latestSubmittedForm(formsData.items);
				if (latestForm) {
					failure = SUBMISSIONS_LOAD_FAILED;
					const subsRes = await apiFetch("submissions/list", {
						formId: latestForm.id,
						limit: 5,
					});
					if (!subsRes.ok) {
						setError(i18n._(submissionsLoadError(subsRes)));
						return;
					}
					const subsData = await parseApiResponse<{
						items: SubmissionItem[];
					}>(subsRes);
					setSubmissions(subsData.items);
				}
			} catch {
				setError(i18n._(failure));
			} finally {
				setLoading(false);
			}
		})();
	}, [i18n]);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-4">
				<Loader />
			</div>
		);
	}

	if (error) {
		return <div className="text-center text-sm text-muted-foreground py-4">{error}</div>;
	}

	if (forms.length === 0) {
		return (
			<div className="text-center text-sm text-muted-foreground py-4">
				{i18n._({ id: "ummmI9", message: "No forms configured" })}
			</div>
		);
	}

	if (submissions.length === 0) {
		return (
			<div className="text-center text-sm text-muted-foreground py-4">
				{i18n._({ id: "uw7EDw", message: "No submissions yet" })}
			</div>
		);
	}

	const formMap = new Map(forms.map((f) => [f.id, f.name]));

	return (
		<div className="space-y-2">
			{submissions.map((sub) => {
				const preview = Object.values(sub.data)
					.filter((v) => typeof v === "string" && v.length > 0)
					.slice(0, 1)
					.map(String)
					.join("");

				return (
					<div key={sub.id} className="flex items-center justify-between text-xs">
						<div className="flex items-center gap-2 min-w-0">
							<Badge variant={sub.status === "new" ? "success" : "default"}>
								{statusLabel(i18n, SUBMISSION_STATUS_LABELS, sub.status)}
							</Badge>
							<span className="truncate">
								{preview ||
									formMap.get(sub.formId) ||
									i18n._({ id: "be6D0D", message: "Submission" })}
							</span>
						</div>
						<span className="text-muted-foreground whitespace-nowrap ms-2">
							{formatDate(sub.createdAt)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

// =============================================================================
// Exports
// =============================================================================

export const pages: PluginAdminExports["pages"] = {
	"/": FormsListPage,
	"/submissions": SubmissionsPage,
};

export const widgets: PluginAdminExports["widgets"] = {
	"recent-submissions": RecentSubmissionsWidget,
};
