/**
 * Forms Plugin - Admin UI
 *
 * React components for the forms admin pages and dashboard widget.
 * Communicates with the plugin's API routes via fetch.
 */

import { Badge, Button, Checkbox, Input, Loader, Select } from "@cloudflare/kumo";
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
	width: "full" | "half";
}

interface FormSettings {
	confirmationMessage: string;
	redirectUrl?: string;
	notifyEmails: string[];
	digestEnabled: boolean;
	digestHour: number;
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
		ip: string | null;
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
	const [forms, setForms] = React.useState<FormItem[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [editingForm, setEditingForm] = React.useState<FormItem | null>(null);
	const [creating, setCreating] = React.useState(false);

	const loadForms = React.useCallback(async () => {
		try {
			const res = await apiFetch("forms/list");
			if (!res.ok) {
				setError("Failed to load forms");
				return;
			}
			const data = await parseApiResponse<{ items: FormItem[] }>(res);
			setForms(data.items);
		} catch {
			setError("Failed to load forms");
		} finally {
			setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		void loadForms();
	}, [loadForms]);

	const handleToggleStatus = async (form: FormItem) => {
		const newStatus = form.status === "active" ? "paused" : "active";
		const res = await apiFetch("forms/update", {
			id: form.id,
			status: newStatus,
		});
		if (res.ok) await loadForms();
	};

	const handleDuplicate = async (form: FormItem) => {
		const res = await apiFetch("forms/duplicate", { id: form.id });
		if (res.ok) await loadForms();
	};

	const handleDelete = async (form: FormItem) => {
		if (!confirm(`Delete "${form.name}" and all its submissions?`)) return;
		const res = await apiFetch("forms/delete", {
			id: form.id,
			deleteSubmissions: true,
		});
		if (res.ok) await loadForms();
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
					<h1 className="text-3xl font-bold">Forms</h1>
					<p className="text-muted-foreground mt-1">Create and manage forms</p>
				</div>
				<Button icon={<Plus />} onClick={() => setCreating(true)}>
					New Form
				</Button>
			</div>

			{forms.length === 0 ? (
				<EmptyState
					icon={ListBullets}
					title="No forms yet"
					description="Create your first form to start collecting submissions."
					action={
						<Button icon={<Plus />} onClick={() => setCreating(true)}>
							Create Form
						</Button>
					}
				/>
			) : (
				<div className="border rounded-lg overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b bg-muted/50">
								<th className="text-start p-3 font-medium">Name</th>
								<th className="text-start p-3 font-medium">Slug</th>
								<th className="text-start p-3 font-medium">Status</th>
								<th className="text-end p-3 font-medium">Submissions</th>
								<th className="text-start p-3 font-medium">Last Submission</th>
								<th className="text-end p-3 font-medium">Actions</th>
							</tr>
						</thead>
						<tbody>
							{forms.map((form) => (
								<tr key={form.id} className="border-b last:border-0 hover:bg-muted/30">
									<td className="p-3 font-medium">{form.name}</td>
									<td className="p-3 text-muted-foreground font-mono text-xs">{form.slug}</td>
									<td className="p-3">
										<Badge variant={form.status === "active" ? "success" : "warning"}>
											{form.status}
										</Badge>
									</td>
									<td className="p-3 text-end tabular-nums">{form.submissionCount}</td>
									<td className="p-3 text-muted-foreground">
										{form.lastSubmissionAt ? formatDate(form.lastSubmissionAt) : "Never"}
									</td>
									<td className="p-3">
										<div className="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												shape="square"
												onClick={() => setEditingForm(form)}
												aria-label="Edit"
											>
												<PencilSimple className="h-4 w-4" />
											</Button>
											<Button
												variant="ghost"
												shape="square"
												onClick={() => void handleToggleStatus(form)}
												aria-label={form.status === "active" ? "Pause" : "Resume"}
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
												aria-label="Duplicate"
											>
												<Copy className="h-4 w-4" />
											</Button>
											<Button
												variant="ghost"
												shape="square"
												onClick={() => void handleDelete(form)}
												aria-label="Delete"
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

const FIELD_TYPE_ITEMS = FIELD_TYPES.map((t) => ({ label: t, value: t }));

const SPAM_ITEMS = [
	{ label: "None", value: "none" },
	{ label: "Honeypot", value: "honeypot" },
	{ label: "Turnstile", value: "turnstile" },
];

const WIDTH_ITEMS = [
	{ label: "Full", value: "full" },
	{ label: "Half", value: "half" },
];

function FormEditor({
	form,
	onSave,
	onCancel,
}: {
	form: FormItem | null;
	onSave: () => void;
	onCancel: () => void;
}) {
	const [name, setName] = React.useState(form?.name ?? "");
	const [slug, setSlug] = React.useState(form?.slug ?? "");
	const [fields, setFields] = React.useState<FormField[]>(form?.pages[0]?.fields ?? []);
	const [settings, setSettings] = React.useState<Partial<FormSettings>>(form?.settings ?? {});
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

	const updateField = (index: number, updates: Partial<FormField>) => {
		setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...updates } : f)));
	};

	const removeField = (index: number) => {
		setFields((prev) => prev.filter((_, i) => i !== index));
	};

	const moveField = (index: number, direction: -1 | 1) => {
		const target = index + direction;
		if (target < 0 || target >= fields.length) return;
		setFields((prev) => {
			const next = [...prev];
			[next[index]!, next[target]!] = [next[target]!, next[index]!];
			return next;
		});
	};

	const handleSave = async () => {
		if (!name.trim() || !slug.trim()) {
			setError("Name and slug are required");
			return;
		}
		if (fields.length === 0) {
			setError("At least one field is required");
			return;
		}
		for (const f of fields) {
			if (!f.label.trim() || !f.name.trim()) {
				setError("All fields must have a label and name");
				return;
			}
		}

		setSaving(true);
		setError(null);

		const payload = form
			? {
					id: form.id,
					name,
					slug,
					pages: [{ fields }],
					settings,
				}
			: {
					name,
					slug,
					pages: [{ fields }],
					settings: {
						confirmationMessage: "Thank you for your submission.",
						notifyEmails: [],
						digestEnabled: false,
						digestHour: 9,
						retentionDays: 0,
						spamProtection: "honeypot",
						submitLabel: "Submit",
						...settings,
					},
				};

		try {
			const route = form ? "forms/update" : "forms/create";
			const res = await apiFetch(route, payload);
			if (!res.ok) {
				setError(await getErrorMessage(res, "Failed to save form"));
				return;
			}
			onSave();
		} catch {
			setError("Failed to save form");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<Button variant="ghost" shape="square" onClick={onCancel} aria-label="Back">
					<ArrowLeft className="h-5 w-5 rtl:-scale-x-100" />
				</Button>
				<div>
					<h1 className="text-3xl font-bold">{form ? "Edit Form" : "New Form"}</h1>
					{form && <p className="text-muted-foreground mt-0.5 text-sm">Editing: {form.name}</p>}
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
					label="Name"
					value={name}
					onChange={(e) => handleNameChange(e.target.value)}
					placeholder="Contact Form"
				/>
				<Input
					label="Slug"
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
					placeholder="contact-form"
				/>
			</div>

			{/* Fields */}
			<div>
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-lg font-semibold">Fields</h2>
					<Button variant="outline" icon={<Plus />} onClick={addField}>
						Add Field
					</Button>
				</div>

				{fields.length === 0 ? (
					<div className="border border-dashed rounded-lg p-8 text-center text-sm text-muted-foreground">
						No fields yet. Click "Add Field" to get started.
					</div>
				) : (
					<div className="space-y-3">
						{fields.map((field, index) => (
							<FieldRow
								key={field.id}
								field={field}
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
				<h2 className="text-lg font-semibold mb-3">Settings</h2>
				<div className="grid grid-cols-2 gap-4">
					<Input
						label="Confirmation Message"
						value={settings.confirmationMessage ?? "Thank you for your submission."}
						onChange={(e) =>
							setSettings((s) => ({
								...s,
								confirmationMessage: e.target.value,
							}))
						}
					/>
					<Input
						label="Submit Button Label"
						value={settings.submitLabel ?? "Submit"}
						onChange={(e) => setSettings((s) => ({ ...s, submitLabel: e.target.value }))}
					/>
					<div>
						<Select
							label="Spam Protection"
							hideLabel={false}
							value={spamProtection}
							onValueChange={(v) =>
								setSettings((s) => ({
									...s,
									spamProtection: (v ?? "honeypot") as FormSettings["spamProtection"],
								}))
							}
							items={SPAM_ITEMS}
						/>
					</div>
					{spamProtection === "turnstile" &&
						turnstileStatus &&
						(!turnstileStatus.hasSiteKey || !turnstileStatus.hasSecretKey) && (
							<div className="col-span-2 rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-3 text-sm text-yellow-200">
								Turnstile requires a site key and secret key.{" "}
								{!turnstileStatus.hasSiteKey && !turnstileStatus.hasSecretKey
									? "Neither is configured."
									: !turnstileStatus.hasSiteKey
										? "Site key is missing."
										: "Secret key is missing."}{" "}
								Set them in the plugin settings.
							</div>
						)}
					<Input
						label="Retention (days, 0 = forever)"
						type="number"
						value={String(settings.retentionDays ?? 0)}
						onChange={(e) =>
							setSettings((s) => ({
								...s,
								retentionDays: parseInt(e.target.value) || 0,
							}))
						}
					/>
					<div className="col-span-2">
						<Input
							label="Redirect URL (optional)"
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
					{form ? "Save Changes" : "Create Form"}
				</Button>
				<Button variant="outline" onClick={onCancel}>
					Cancel
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
	index,
	total,
	onChange,
	onRemove,
	onMove,
}: {
	field: FormField;
	index: number;
	total: number;
	onChange: (updates: Partial<FormField>) => void;
	onRemove: () => void;
	onMove: (direction: -1 | 1) => void;
}) {
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
							label="Label"
							value={field.label}
							onChange={(e) => handleLabelChange(e.target.value)}
						/>
						<Input
							label="Name"
							value={field.name}
							onChange={(e) => onChange({ name: e.target.value })}
						/>
					</div>
					<div className="flex items-center gap-4">
						<Select
							label="Type"
							hideLabel={false}
							value={field.type}
							onValueChange={(v) => onChange({ type: v ?? "text" })}
							items={FIELD_TYPE_ITEMS}
						/>
						<Select
							label="Width"
							hideLabel={false}
							value={field.width}
							onValueChange={(v) => onChange({ width: v ?? "full" })}
							items={WIDTH_ITEMS}
						/>
						<Checkbox
							label="Required"
							checked={field.required}
							onCheckedChange={(checked) => onChange({ required: checked })}
						/>
					</div>
				</div>
				<div className="flex items-center gap-0.5 pt-6">
					<Button
						variant="ghost"
						shape="square"
						onClick={() => onMove(-1)}
						disabled={index === 0}
						aria-label="Move up"
					>
						&#9650;
					</Button>
					<Button
						variant="ghost"
						shape="square"
						onClick={() => onMove(1)}
						disabled={index === total - 1}
						aria-label="Move down"
					>
						&#9660;
					</Button>
					<Button
						variant="ghost"
						shape="square"
						onClick={onRemove}
						aria-label="Remove"
						className="text-destructive"
					>
						<Trash className="h-3.5 w-3.5" />
					</Button>
				</div>
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
			<span className="text-xs text-muted-foreground">Options:</span>
			{options.map((opt, i) => (
				<div key={i} className="flex items-center gap-2">
					<Input
						value={opt.label}
						onChange={(e) => updateOption(i, { label: e.target.value })}
						placeholder="Label"
					/>
					<Input
						value={opt.value}
						onChange={(e) => updateOption(i, { value: e.target.value })}
						placeholder="value"
					/>
					<Button
						variant="ghost"
						shape="square"
						onClick={() => removeOption(i)}
						className="text-destructive"
						aria-label="Remove option"
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
				+ Add option
			</button>
		</div>
	);
}

// =============================================================================
// Submissions Page
// =============================================================================

function SubmissionsPage() {
	const [forms, setForms] = React.useState<FormItem[]>([]);
	const [selectedFormId, setSelectedFormId] = React.useState<string>("");
	const [submissions, setSubmissions] = React.useState<SubmissionItem[]>([]);
	const [statusFilter, setStatusFilter] = React.useState<string>("");
	const [loading, setLoading] = React.useState(true);
	const [subsLoading, setSubsLoading] = React.useState(false);
	const [selectedSub, setSelectedSub] = React.useState<SubmissionItem | null>(null);

	React.useEffect(() => {
		void (async () => {
			try {
				const res = await apiFetch("forms/list");
				if (res.ok) {
					const data = await parseApiResponse<{ items: FormItem[] }>(res);
					setForms(data.items);
					if (data.items.length > 0 && data.items[0]) {
						setSelectedFormId(data.items[0].id);
					}
				}
			} finally {
				setLoading(false);
			}
		})();
	}, []);

	React.useEffect(() => {
		if (!selectedFormId) return;
		setSubsLoading(true);
		setSelectedSub(null);
		void (async () => {
			try {
				const body: Record<string, unknown> = {
					formId: selectedFormId,
					limit: 50,
				};
				if (statusFilter) body.status = statusFilter;
				const res = await apiFetch("submissions/list", body);
				if (res.ok) {
					const data = await parseApiResponse<{ items: SubmissionItem[] }>(res);
					setSubmissions(data.items);
				}
			} finally {
				setSubsLoading(false);
			}
		})();
	}, [selectedFormId, statusFilter]);

	const handleToggleStar = async (sub: SubmissionItem) => {
		const res = await apiFetch("submissions/update", {
			id: sub.id,
			starred: !sub.starred,
		});
		if (res.ok) {
			setSubmissions((prev) =>
				prev.map((s) => (s.id === sub.id ? { ...s, starred: !s.starred } : s)),
			);
			if (selectedSub?.id === sub.id) setSelectedSub({ ...selectedSub, starred: !sub.starred });
		}
	};

	const handleMarkRead = async (sub: SubmissionItem) => {
		const newStatus = sub.status === "new" ? "read" : sub.status === "read" ? "archived" : "new";
		const res = await apiFetch("submissions/update", {
			id: sub.id,
			status: newStatus,
		});
		if (res.ok) {
			setSubmissions((prev) =>
				prev.map((s) => (s.id === sub.id ? { ...s, status: newStatus } : s)),
			);
			if (selectedSub?.id === sub.id) setSelectedSub({ ...selectedSub, status: newStatus });
		}
	};

	const handleDelete = async (sub: SubmissionItem) => {
		if (!confirm("Delete this submission?")) return;
		const res = await apiFetch("submissions/delete", { id: sub.id });
		if (res.ok) {
			setSubmissions((prev) => prev.filter((s) => s.id !== sub.id));
			if (selectedSub?.id === sub.id) setSelectedSub(null);
		}
	};

	const handleExport = async (format: "csv" | "json") => {
		if (!selectedFormId) return;
		const res = await apiFetch("submissions/export", {
			formId: selectedFormId,
			format,
		});
		if (res.ok) {
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
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	if (forms.length === 0) {
		return (
			<div className="space-y-6">
				<h1 className="text-3xl font-bold">Submissions</h1>
				<EmptyState
					icon={Envelope}
					title="No forms yet"
					description="Create a form first, then submissions will appear here."
				/>
			</div>
		);
	}

	const selectedForm = forms.find((f) => f.id === selectedFormId);
	const formItems = forms.map((f) => ({ label: f.name, value: f.id }));
	const statusItems = [
		{ label: "All Status", value: "" },
		{ label: "New", value: "new" },
		{ label: "Read", value: "read" },
		{ label: "Archived", value: "archived" },
	];

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-3xl font-bold">Submissions</h1>
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
			</div>

			{/* Filters */}
			<div className="flex items-center gap-3">
				<div className="w-56">
					<Select
						value={selectedFormId}
						onValueChange={(v) => setSelectedFormId(v ?? "")}
						items={formItems}
						aria-label="Select form"
					/>
				</div>
				<div className="w-40">
					<Select
						value={statusFilter}
						onValueChange={(v) => setStatusFilter(v ?? "")}
						items={statusItems}
						aria-label="Filter by status"
					/>
				</div>
				{selectedForm && (
					<span className="text-sm text-muted-foreground">
						{selectedForm.submissionCount} total
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
					) : submissions.length === 0 ? (
						<EmptyState
							icon={Envelope}
							title="No submissions"
							description={
								statusFilter
									? "No submissions match the current filter."
									: "This form hasn't received any submissions yet."
							}
						/>
					) : (
						<div className="border rounded-lg overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b bg-muted/50">
										<th className="w-8 p-3" />
										<th className="text-start p-3 font-medium">Date</th>
										<th className="text-start p-3 font-medium">Preview</th>
										<th className="text-start p-3 font-medium">Status</th>
										<th className="text-end p-3 font-medium">Actions</th>
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
												</td>
												<td className="p-3 text-muted-foreground whitespace-nowrap">
													{formatDate(sub.createdAt)}
												</td>
												<td className="p-3 truncate max-w-xs">
													{previewValues || (
														<span className="text-muted-foreground italic">Empty</span>
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
														{sub.status}
													</Badge>
												</td>
												<td className="p-3 text-end">
													<div className="flex items-center justify-end gap-1">
														<Button
															variant="ghost"
															shape="square"
															onClick={(e: React.MouseEvent) => {
																e.stopPropagation();
																void handleMarkRead(sub);
															}}
															aria-label="Toggle status"
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
															aria-label="Delete"
														>
															<Trash className="h-4 w-4" />
														</Button>
													</div>
												</td>
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
							<h3 className="font-semibold">Submission Detail</h3>
							<Badge
								variant={
									selectedSub.status === "new"
										? "success"
										: selectedSub.status === "archived"
											? "default"
											: "warning"
								}
							>
								{selectedSub.status}
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
							<p className="text-xs text-muted-foreground">Country: {selectedSub.meta.country}</p>
						)}

						{selectedSub.notes && (
							<div>
								<dt className="text-xs font-medium text-muted-foreground">Notes</dt>
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
	const [forms, setForms] = React.useState<FormItem[]>([]);
	const [submissions, setSubmissions] = React.useState<SubmissionItem[]>([]);
	const [loading, setLoading] = React.useState(true);

	React.useEffect(() => {
		void (async () => {
			try {
				const formsRes = await apiFetch("forms/list");
				if (!formsRes.ok) return;
				const formsData = await parseApiResponse<{ items: FormItem[] }>(formsRes);
				setForms(formsData.items);

				if (formsData.items.length > 0 && formsData.items[0]) {
					const subsRes = await apiFetch("submissions/list", {
						formId: formsData.items[0].id,
						limit: 5,
					});
					if (subsRes.ok) {
						const subsData = await parseApiResponse<{
							items: SubmissionItem[];
						}>(subsRes);
						setSubmissions(subsData.items);
					}
				}
			} finally {
				setLoading(false);
			}
		})();
	}, []);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-4">
				<Loader />
			</div>
		);
	}

	if (forms.length === 0) {
		return (
			<div className="text-center text-sm text-muted-foreground py-4">No forms configured</div>
		);
	}

	if (submissions.length === 0) {
		return <div className="text-center text-sm text-muted-foreground py-4">No submissions yet</div>;
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
							<Badge variant={sub.status === "new" ? "success" : "default"}>{sub.status}</Badge>
							<span className="truncate">{preview || formMap.get(sub.formId) || "Submission"}</span>
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
