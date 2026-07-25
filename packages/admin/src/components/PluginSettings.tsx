/**
 * Plugin Settings page
 *
 * Auto-generates a settings form from a plugin's `admin.settingsSchema`.
 * Values are stored server-side under the same KV keys the plugin reads
 * via `ctx.kv.get("settings:{key}")`. Secret fields are write-only: the
 * server never returns their values, only whether one is set.
 */

import { Button, Input, InputArea, Select, Switch, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { FloppyDisk } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchPlugin,
	fetchPluginSettings,
	updatePluginSettings,
	type SettingField,
} from "../lib/api/plugins.js";
import { ArrowPrev } from "./ArrowIcons.js";
import { EditorHeader } from "./EditorHeader";
import { RouterLinkButton } from "./RouterLinkButton.js";

export interface PluginSettingsProps {
	pluginId: string;
}

export function PluginSettings({ pluginId }: PluginSettingsProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();

	const { data: plugin } = useQuery({
		queryKey: ["plugins", pluginId],
		queryFn: () => fetchPlugin(pluginId),
	});

	const {
		data: settings,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["plugin-settings", pluginId],
		queryFn: () => fetchPluginSettings(pluginId),
	});

	const [values, setValues] = React.useState<Record<string, unknown>>({});
	// Secret fields are write-only: track typed input separately and only
	// send keys the user actually changed.
	const [secretInputs, setSecretInputs] = React.useState<Record<string, string>>({});
	const [clearedSecrets, setClearedSecrets] = React.useState<Set<string>>(new Set());

	React.useEffect(() => {
		if (settings) {
			setValues(settings.values);
			setSecretInputs({});
			setClearedSecrets(new Set());
		}
	}, [settings]);

	const saveMutation = useMutation({
		mutationFn: (updates: Record<string, unknown>) => updatePluginSettings(pluginId, updates),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["plugin-settings", pluginId] });
			toastManager.add({
				title: t`Settings saved successfully`,
				timeout: 3000,
			});
		},
		onError: (err) => {
			toastManager.add({
				title: t`Failed to save settings`,
				description: err instanceof Error ? err.message : t`An error occurred`,
				type: "error",
				timeout: 5000,
			});
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!settings) return;

		const updates: Record<string, unknown> = {};
		for (const [key, field] of Object.entries(settings.schema)) {
			if (field.type === "secret") {
				if (clearedSecrets.has(key)) {
					updates[key] = null;
				} else if (secretInputs[key]) {
					updates[key] = secretInputs[key];
				}
				continue;
			}
			const value = values[key];
			// An emptied field reverts to the schema default: send null so
			// the server deletes the stored value. Sending "" would persist
			// an empty string and shadow the default; skipping the key would
			// leave the old stored value in place. Never-set fields also send
			// null — deleting a missing key is a no-op.
			const cleared = value === null || value === undefined || value === "";
			updates[key] = cleared ? null : value;
		}
		saveMutation.mutate(updates);
	};

	const setValue = (key: string, value: unknown) => {
		setValues((prev) => ({ ...prev, [key]: value }));
	};

	const pluginName = plugin?.name ?? pluginId;
	const backLink = (
		<RouterLinkButton
			to="/plugins-manager"
			variant="ghost"
			shape="square"
			aria-label={t`Back to plugins`}
			icon={<ArrowPrev />}
		/>
	);

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					{backLink}
					<h1 className="text-2xl font-bold">{t`${pluginName} Settings`}</h1>
				</div>
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-subtle">{t`Loading settings...`}</p>
				</div>
			</div>
		);
	}

	if (error || !settings) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					{backLink}
					<h1 className="text-2xl font-bold">{t`${pluginName} Settings`}</h1>
				</div>
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-danger">
						{error instanceof Error ? error.message : t`Failed to load plugin settings`}
					</p>
				</div>
			</div>
		);
	}

	const fields = Object.entries(settings.schema);

	return (
		<div className="space-y-6">
			<EditorHeader
				leading={backLink}
				actions={
					<Button
						type="submit"
						form="plugin-settings-form"
						disabled={saveMutation.isPending}
						icon={<FloppyDisk />}
					>
						{saveMutation.isPending ? t`Saving...` : t`Save Settings`}
					</Button>
				}
			>
				<h1 className="text-2xl font-bold truncate">{t`${pluginName} Settings`}</h1>
			</EditorHeader>

			<form id="plugin-settings-form" onSubmit={handleSubmit} className="space-y-6">
				<div className="rounded-lg border bg-kumo-base p-6">
					<div className="space-y-4">
						{fields.length === 0 && (
							<p className="text-kumo-subtle">{t`This plugin has no configurable settings.`}</p>
						)}
						{fields.map(([key, field]) => (
							<SettingFieldInput
								key={key}
								fieldKey={key}
								field={field}
								value={values[key]}
								secretSet={settings.secretsSet[key] ?? false}
								secretInput={secretInputs[key] ?? ""}
								secretCleared={clearedSecrets.has(key)}
								onChange={(value) => setValue(key, value)}
								onSecretChange={(text) => {
									setSecretInputs((prev) => ({ ...prev, [key]: text }));
									setClearedSecrets((prev) => {
										if (!prev.has(key)) return prev;
										const next = new Set(prev);
										next.delete(key);
										return next;
									});
								}}
								onSecretClear={() => {
									setSecretInputs((prev) => ({ ...prev, [key]: "" }));
									setClearedSecrets((prev) => new Set(prev).add(key));
								}}
							/>
						))}
					</div>
				</div>

				{fields.length > 0 && (
					<Button type="submit" disabled={saveMutation.isPending} icon={<FloppyDisk />}>
						{saveMutation.isPending ? t`Saving...` : t`Save Settings`}
					</Button>
				)}
			</form>
		</div>
	);
}

interface SettingFieldInputProps {
	fieldKey: string;
	field: SettingField;
	value: unknown;
	secretSet: boolean;
	secretInput: string;
	secretCleared: boolean;
	onChange: (value: unknown) => void;
	onSecretChange: (text: string) => void;
	onSecretClear: () => void;
}

function SettingFieldInput({
	fieldKey,
	field,
	value,
	secretSet,
	secretInput,
	secretCleared,
	onChange,
	onSecretChange,
	onSecretClear,
}: SettingFieldInputProps) {
	const { t } = useLingui();

	// Schema labels/descriptions are plugin-authored strings (like admin
	// page labels) — rendered as-is, not localized.
	switch (field.type) {
		case "string":
			return field.multiline ? (
				<InputArea
					label={field.label}
					description={field.description}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			) : (
				<Input
					label={field.label}
					description={field.description}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);

		case "url":
		case "email":
			return (
				<Input
					type={field.type}
					label={field.label}
					description={field.description}
					placeholder={field.placeholder}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);

		case "number":
			return (
				<Input
					type="number"
					label={field.label}
					description={field.description}
					min={field.min}
					max={field.max}
					value={typeof value === "number" ? String(value) : ""}
					onChange={(e) => {
						const parsed = Number.parseFloat(e.target.value);
						onChange(Number.isNaN(parsed) ? null : parsed);
					}}
				/>
			);

		case "boolean":
			return (
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm font-medium">{field.label}</p>
						{field.description && <p className="text-xs text-kumo-subtle">{field.description}</p>}
					</div>
					<Switch
						checked={value === true}
						onCheckedChange={(checked) => onChange(checked)}
						aria-label={field.label}
					/>
				</div>
			);

		case "select": {
			// Kumo Select.items is a value->label record, not {value,label}[].
			const items: Record<string, string> = {};
			for (const option of field.options) {
				items[option.value] = option.label;
			}
			return (
				<Select
					label={field.label}
					value={typeof value === "string" ? value : (field.default ?? "")}
					onValueChange={(v) => v !== null && onChange(v)}
					items={items}
				>
					{field.options.map((option) => (
						<Select.Option key={option.value} value={option.value}>
							{option.label}
						</Select.Option>
					))}
				</Select>
			);
		}

		case "secret":
			return (
				<div className="space-y-1">
					<Input
						type="password"
						label={field.label}
						description={field.description}
						autoComplete="new-password"
						placeholder={
							secretCleared
								? t`Will be cleared on save`
								: secretSet
									? t`Currently set — enter a new value to replace`
									: t`Not set`
						}
						value={secretInput}
						onChange={(e) => onSecretChange(e.target.value)}
					/>
					{secretSet && !secretCleared && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={onSecretClear}
							aria-label={t`Clear stored value for ${fieldKey}`}
						>
							{t`Clear stored value`}
						</Button>
					)}
				</div>
			);

		default: {
			const _exhaustive: never = field;
			return null;
		}
	}
}

export default PluginSettings;
