/**
 * AI Moderation Plugin — Admin Components
 *
 * Exports widgets and pages for the admin UI.
 */

import { Switch } from "@cloudflare/kumo";
import {
	ShieldCheck,
	CheckCircle,
	WarningCircle,
	FloppyDisk,
	CircleNotch,
	Trash,
	PencilSimple,
	Plus,
	TestTube,
	X,
} from "@phosphor-icons/react";
import type { PluginAdminExports } from "emdash";
import { apiFetch, isRecord, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import type { Category } from "./categories.js";

const API_BASE = "/_emdash/api/plugins/ai-moderation";

// =============================================================================
// Dashboard Widget
// =============================================================================

interface PluginStatus {
	enabled: boolean;
	categoryCount: number;
	autoApproveClean: boolean;
}

function StatusWidget() {
	const [status, setStatus] = React.useState<PluginStatus | null>(null);
	const [isLoading, setIsLoading] = React.useState(true);

	React.useEffect(() => {
		async function fetchStatus() {
			try {
				const response = await apiFetch(`${API_BASE}/status`);
				if (!response.ok) return;
				const data = await parseApiResponse<PluginStatus>(response);
				setStatus(data);
			} catch {
				// Widget is non-critical
			} finally {
				setIsLoading(false);
			}
		}
		void fetchStatus();
	}, []);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<CircleNotch className="h-5 w-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-3">
				<div className="p-2 rounded-full bg-green-100 dark:bg-green-900/30">
					<ShieldCheck className="h-5 w-5 text-green-600 dark:text-green-400" />
				</div>
				<div>
					<div className="font-medium">AI Moderation Active</div>
					<div className="text-xs text-muted-foreground">
						{status?.categoryCount ?? 0} active categories
					</div>
				</div>
			</div>

			<div className="pt-2 border-t space-y-1">
				<div className="flex justify-between text-sm">
					<span className="text-muted-foreground">Auto-approve clean</span>
					<span>{status?.autoApproveClean ? "Yes" : "No"}</span>
				</div>
			</div>

			<div className="pt-2">
				<a
					href="/_emdash/admin/plugins/ai-moderation/settings"
					className="text-xs text-primary hover:underline"
				>
					Configure moderation
				</a>
			</div>
		</div>
	);
}

// =============================================================================
// Category Edit Dialog
// =============================================================================

interface CategoryDialogProps {
	category: Category | null;
	onSave: (category: Category) => void;
	onClose: () => void;
}

function CategoryDialog({ category, onSave, onClose }: CategoryDialogProps) {
	const [form, setForm] = React.useState<Category>(
		category ?? {
			id: "",
			name: "",
			description: "",
			action: "hold",
			builtin: false,
		},
	);

	const isEditing = !!category;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<div className="bg-background border rounded-lg p-6 w-full max-w-md space-y-4">
				<div className="flex items-center justify-between">
					<h3 className="text-lg font-semibold">{isEditing ? "Edit Category" : "Add Category"}</h3>
					<button onClick={onClose} className="p-1 hover:bg-muted rounded">
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="space-y-3">
					<div className="space-y-1">
						<label className="text-sm font-medium">ID</label>
						<input
							type="text"
							value={form.id}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
								setForm({ ...form, id: e.target.value })
							}
							disabled={isEditing}
							placeholder="e.g. S10"
							className="w-full px-3 py-2 border rounded-md bg-background text-sm disabled:opacity-50"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium">Name</label>
						<input
							type="text"
							value={form.name}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
								setForm({ ...form, name: e.target.value })
							}
							placeholder="e.g. Self-Promotion"
							className="w-full px-3 py-2 border rounded-md bg-background text-sm"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium">Description</label>
						<textarea
							value={form.description}
							onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
								setForm({ ...form, description: e.target.value })
							}
							rows={3}
							placeholder="Description for AI classification..."
							className="w-full px-3 py-2 border rounded-md bg-background text-sm resize-none"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium">Action</label>
						<select
							value={form.action}
							onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
								const val = e.target.value;
								if (val === "block" || val === "hold" || val === "ignore") {
									setForm({ ...form, action: val });
								}
							}}
							className="w-full px-3 py-2 border rounded-md bg-background text-sm"
						>
							<option value="block">Block (mark as spam)</option>
							<option value="hold">Hold (pending review)</option>
							<option value="ignore">Ignore (no action)</option>
						</select>
					</div>
				</div>

				<div className="flex justify-end gap-2 pt-2">
					<button onClick={onClose} className="px-4 py-2 border rounded-md hover:bg-muted text-sm">
						Cancel
					</button>
					<button
						onClick={() => {
							if (form.id && form.name && form.description) {
								onSave(form);
							}
						}}
						disabled={!form.id || !form.name || !form.description}
						className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 text-sm"
					>
						{isEditing ? "Save" : "Add"}
					</button>
				</div>
			</div>
		</div>
	);
}

// =============================================================================
// Settings Page
// =============================================================================

function SettingsPage() {
	const [categories, setCategories] = React.useState<Category[]>([]);
	const [autoApproveClean, setAutoApproveClean] = React.useState(true);
	const [isLoading, setIsLoading] = React.useState(true);
	const [isSaving, setIsSaving] = React.useState(false);
	const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
	const [editingCategory, setEditingCategory] = React.useState<Category | null | "new">(null);

	// Test panel state
	const [testText, setTestText] = React.useState("");
	const [testResult, setTestResult] = React.useState<Record<string, unknown> | null>(null);
	const [isTesting, setIsTesting] = React.useState(false);

	// Load settings on mount
	React.useEffect(() => {
		async function loadSettings() {
			try {
				const response = await apiFetch(`${API_BASE}/settings`);
				if (response.ok) {
					const data = await parseApiResponse<{
						categories?: Category[];
						behavior?: { autoApproveClean?: boolean };
					}>(response);
					if (data.categories) setCategories(data.categories);
					if (data.behavior?.autoApproveClean !== undefined) {
						setAutoApproveClean(data.behavior.autoApproveClean);
					}
				}
			} catch {
				// Use defaults
			} finally {
				setIsLoading(false);
			}
		}
		void loadSettings();
	}, []);

	const handleSave = async () => {
		setIsSaving(true);
		setSaveMessage(null);
		try {
			const response = await apiFetch(`${API_BASE}/settings/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					categories,
					behavior: { autoApproveClean },
				}),
			});
			if (response.ok) {
				setSaveMessage("Settings saved");
			} else {
				setSaveMessage("Failed to save settings");
			}
		} catch {
			setSaveMessage("Failed to save settings");
		} finally {
			setIsSaving(false);
			// eslint-disable-next-line e18e/prefer-timer-args -- conflicts with no-implied-eval
			setTimeout(() => setSaveMessage(null), 3000);
		}
	};

	const handleTest = async () => {
		if (!testText.trim()) return;
		setIsTesting(true);
		setTestResult(null);
		try {
			const response = await apiFetch(`${API_BASE}/settings/test`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: testText }),
			});
			const data = await parseApiResponse<Record<string, unknown>>(response);
			setTestResult(data);
		} catch {
			setTestResult({ success: false, error: "Failed to run test" });
		} finally {
			setIsTesting(false);
		}
	};

	const handleCategorySave = (cat: Category) => {
		setCategories((prev) => {
			const idx = prev.findIndex((c) => c.id === cat.id);
			if (idx >= 0) {
				const updated = [...prev];
				updated[idx] = cat;
				return updated;
			}
			return [...prev, cat];
		});
		setEditingCategory(null);
	};

	const handleCategoryDelete = (id: string) => {
		setCategories((prev) => prev.filter((c) => c.id !== id));
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-16">
				<CircleNotch className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold">AI Moderation</h1>
					<p className="text-muted-foreground mt-1">Configure AI-powered comment moderation</p>
				</div>
				<div className="flex items-center gap-3">
					{saveMessage && <span className="text-sm text-muted-foreground">{saveMessage}</span>}
					<button
						onClick={handleSave}
						disabled={isSaving}
						className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
					>
						{isSaving ? (
							<CircleNotch className="h-4 w-4 animate-spin" />
						) : (
							<FloppyDisk className="h-4 w-4" />
						)}
						{isSaving ? "Saving..." : "Save Settings"}
					</button>
				</div>
			</div>

			<div className="grid gap-6 lg:grid-cols-2">
				{/* Categories */}
				<div className="border rounded-lg p-6 space-y-4 lg:col-span-2">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<ShieldCheck className="h-5 w-5 text-muted-foreground" />
							<h2 className="text-lg font-semibold">Safety Categories</h2>
						</div>
						<button
							onClick={() => setEditingCategory("new")}
							className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-md hover:bg-muted text-sm"
						>
							<Plus className="h-3.5 w-3.5" />
							Add Category
						</button>
					</div>

					<div className="divide-y">
						{categories.map((cat) => (
							<div key={cat.id} className="flex items-center justify-between py-3">
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
											{cat.id}
										</span>
										<span className="font-medium">{cat.name}</span>
										<span
											className={`text-xs px-2 py-0.5 rounded-full ${
												cat.action === "block"
													? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
													: cat.action === "hold"
														? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
														: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
											}`}
										>
											{cat.action}
										</span>
									</div>
									<p className="text-sm text-muted-foreground mt-0.5 truncate">{cat.description}</p>
								</div>
								<div className="flex items-center gap-1 ms-4">
									<button
										onClick={() => setEditingCategory(cat)}
										className="p-1.5 hover:bg-muted rounded"
										title="Edit"
									>
										<PencilSimple className="h-4 w-4" />
									</button>
									{!cat.builtin && (
										<button
											onClick={() => handleCategoryDelete(cat.id)}
											className="p-1.5 hover:bg-muted rounded text-red-600"
											title="Delete"
										>
											<Trash className="h-4 w-4" />
										</button>
									)}
								</div>
							</div>
						))}
					</div>
				</div>

				{/* Behavior */}
				<div className="border rounded-lg p-6 space-y-4">
					<h2 className="text-lg font-semibold">Behavior</h2>

					<Switch
						checked={autoApproveClean}
						onCheckedChange={setAutoApproveClean}
						label="Auto-approve clean comments"
						labelTooltip="Automatically approve comments that pass AI checks. When off, falls back to collection moderation settings."
						controlFirst={false}
					/>
				</div>

				{/* Test Panel */}
				<div className="border rounded-lg p-6 space-y-4 lg:col-span-2">
					<div className="flex items-center gap-2">
						<TestTube className="h-5 w-5 text-muted-foreground" />
						<h2 className="text-lg font-semibold">Test Panel</h2>
					</div>

					<div className="space-y-3">
						<textarea
							value={testText}
							onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setTestText(e.target.value)}
							rows={3}
							placeholder="Paste a comment to test AI analysis..."
							className="w-full px-3 py-2 border rounded-md bg-background text-sm resize-none"
						/>
						<button
							onClick={handleTest}
							disabled={isTesting || !testText.trim()}
							className="inline-flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-muted disabled:opacity-50 text-sm"
						>
							{isTesting ? (
								<CircleNotch className="h-4 w-4 animate-spin" />
							) : (
								<TestTube className="h-4 w-4" />
							)}
							{isTesting ? "Analyzing..." : "Analyze"}
						</button>

						{testResult && (
							<div className="p-4 bg-muted/50 rounded-md space-y-2">
								{testResult.guard && isRecord(testResult.guard) ? (
									<div className="flex items-center gap-2">
										{testResult.guard.safe ? (
											<CheckCircle className="h-5 w-5 text-green-600" />
										) : (
											<WarningCircle className="h-5 w-5 text-red-600" />
										)}
										<span className="font-medium">{testResult.guard.safe ? "Safe" : "Unsafe"}</span>
										{!testResult.guard.safe && Array.isArray(testResult.guard.categories) && (
											<span className="text-sm text-muted-foreground">
												— Categories: {(testResult.guard.categories as string[]).join(", ")}
											</span>
										)}
									</div>
								) : testResult.guardError ? (
									<div className="text-sm text-red-600">
										AI Error:{" "}
										{typeof testResult.guardError === "string"
											? testResult.guardError
											: "Unknown error"}
									</div>
								) : (
									<div className="text-sm text-muted-foreground">
										AI analysis not available (no active categories)
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Category Dialog */}
			{editingCategory !== null && (
				<CategoryDialog
					category={editingCategory === "new" ? null : editingCategory}
					onSave={handleCategorySave}
					onClose={() => setEditingCategory(null)}
				/>
			)}
		</div>
	);
}

// =============================================================================
// Exports
// =============================================================================

export const widgets: PluginAdminExports["widgets"] = {
	status: StatusWidget,
};

export const pages: PluginAdminExports["pages"] = {
	"/settings": SettingsPage,
};
