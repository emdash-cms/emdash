/**
 * API Tokens settings page
 *
 * Allows admins to list, create, and revoke Personal Access Tokens.
 */

import { Banner, Button, Checkbox, Input, Loader, Select, Tooltip } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Copy, Eye, EyeSlash, Key, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchApiTokens,
	createApiToken,
	revokeApiToken,
	API_TOKEN_SCOPES,
	type ApiTokenCreateResult,
	type ApiTokenScopeValue,
} from "../../lib/api/api-tokens.js";
import { fetchPlugins } from "../../lib/api/plugins.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

// =============================================================================
// Expiry options
// =============================================================================

const EXPIRY_OPTIONS = [
	{ value: "none", label: msg`No expiry` },
	{ value: "7d", label: msg`7 days` },
	{ value: "30d", label: msg`30 days` },
	{ value: "90d", label: msg`90 days` },
	{ value: "365d", label: msg`1 year` },
] as const;

const API_TOKEN_SCOPE_VALUES: {
	scope: ApiTokenScopeValue;
	label: MessageDescriptor;
	description: MessageDescriptor;
}[] = [
	{
		scope: API_TOKEN_SCOPES.ContentRead,
		label: msg`Content Read`,
		description: msg`Read content entries`,
	},
	{
		scope: API_TOKEN_SCOPES.ContentWrite,
		label: msg`Content Write`,
		description: msg`Create, update, delete content`,
	},
	{
		scope: API_TOKEN_SCOPES.MediaRead,
		label: msg`Media Read`,
		description: msg`Read media files`,
	},
	{
		scope: API_TOKEN_SCOPES.MediaWrite,
		label: msg`Media Write`,
		description: msg`Upload and delete media`,
	},
	{
		scope: API_TOKEN_SCOPES.SchemaRead,
		label: msg`Schema Read`,
		description: msg`Read collection schemas`,
	},
	{
		scope: API_TOKEN_SCOPES.SchemaWrite,
		label: msg`Schema Write`,
		description: msg`Modify collection schemas`,
	},
	{
		scope: API_TOKEN_SCOPES.TaxonomiesManage,
		label: msg`Taxonomies Manage`,
		description: msg`Create, update, and delete taxonomy terms`,
	},
	{
		scope: API_TOKEN_SCOPES.MenusManage,
		label: msg`Menus Manage`,
		description: msg`Create, update, and delete navigation menus`,
	},
	{
		scope: API_TOKEN_SCOPES.SettingsRead,
		label: msg`Settings Read`,
		description: msg`Read site settings`,
	},
	{
		scope: API_TOKEN_SCOPES.SettingsManage,
		label: msg`Settings Manage`,
		description: msg`Update site settings`,
	},
	{
		scope: API_TOKEN_SCOPES.McpTools,
		label: msg`Plugin MCP Tools`,
		description: msg`Invoke MCP tools from all enabled plugins`,
	},
	{
		scope: API_TOKEN_SCOPES.Admin,
		label: msg`Admin`,
		description: msg`Full admin access`,
	},
];

/** Wire scopes shown on the create-token form (contract-tested vs `API_TOKEN_SCOPES` and `@emdash-cms/auth`). */
export const API_TOKEN_SCOPE_FORM_SCOPES: readonly ApiTokenScopeValue[] =
	API_TOKEN_SCOPE_VALUES.map((row) => row.scope);

function computeExpiryDate(option: string): string | undefined {
	if (option === "none") return undefined;
	const days = parseInt(option, 10);
	if (Number.isNaN(days)) return undefined;
	const date = new Date();
	date.setDate(date.getDate() + days);
	return date.toISOString();
}

// =============================================================================
// Main component
// =============================================================================

export function ApiTokenSettings() {
	const { t, i18n } = useLingui();
	const queryClient = useQueryClient();
	const [showCreateForm, setShowCreateForm] = React.useState(false);
	const [newToken, setNewToken] = React.useState<ApiTokenCreateResult | null>(null);
	const [tokenVisible, setTokenVisible] = React.useState(false);
	const [copied, setCopied] = React.useState(false);
	const [revokeConfirmId, setRevokeConfirmId] = React.useState<string | null>(null);

	const {
		data: tokens,
		isLoading,
		error: loadError,
	} = useQuery({
		queryKey: ["api-tokens"],
		queryFn: fetchApiTokens,
	});
	const { data: plugins = [] } = useQuery({
		queryKey: ["plugins"],
		queryFn: fetchPlugins,
	});

	const createMutation = useMutation({
		mutationFn: createApiToken,
		onSuccess: (result) => {
			setNewToken(result);
			setShowCreateForm(false);
			setTokenVisible(false);
			setCopied(false);
			void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
		},
	});

	const revokeMutation = useMutation({
		mutationFn: revokeApiToken,
		onSuccess: () => {
			setRevokeConfirmId(null);
			void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
		},
	});

	const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	React.useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	const handleCopyToken = async () => {
		if (!newToken) return;
		try {
			await navigator.clipboard.writeText(newToken.token);
			setCopied(true);
			copyTimeoutRef.current = setTimeout(setCopied, 2000, false);
		} catch {
			// Clipboard API can fail in insecure contexts or when denied
		}
	};

	const expirySelectItems = React.useMemo(
		() => Object.fromEntries(EXPIRY_OPTIONS.map((o) => [o.value, t(o.label)])),
		[t],
	);
	const tokenToRevoke = tokens?.find((token) => token.id === revokeConfirmId);
	const revokeDescription = tokenToRevoke ? (
		<>
			{t(msg`Revoke token`)}: {tokenToRevoke.name}
		</>
	) : (
		t(msg`Revoke token`)
	);
	const title = t`API Tokens`;
	const description = t`Create personal access tokens for programmatic API access`;

	if (isLoading) {
		return (
			<SettingsFrame title={title} description={description}>
				<div
					className="flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 text-sm text-kumo-subtle"
					role="status"
				>
					<Loader size="sm" />
					<span>{t`Loading...`}</span>
				</div>
			</SettingsFrame>
		);
	}

	if (loadError && tokens === undefined) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`An error occurred`}
					description={loadError instanceof Error ? loadError.message : t`An error occurred`}
					role="alert"
				/>
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame title={title} description={description}>
			<div className="grid gap-8">
				<SettingsSection
					title={t(msg`Create New Token`)}
					description={t`Create personal access tokens for programmatic API access`}
					actions={
						showCreateForm ? (
							<Button variant="ghost" size="sm" onClick={() => setShowCreateForm(false)}>
								{t`Cancel`}
							</Button>
						) : (
							<Button icon={<Plus />} onClick={() => setShowCreateForm(true)}>
								{t(msg`Create Token`)}
							</Button>
						)
					}
				>
					{newToken && (
						<SettingRow className="bg-kumo-success-tint">
							<div className="grid gap-4">
								<div className="flex items-start gap-3">
									<span
										className="flex h-5 shrink-0 items-center text-kumo-success"
										aria-hidden="true"
									>
										<Key className="h-5 w-5" />
									</span>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium text-kumo-success">
											{t`Token created: ${newToken.info.name}`}
										</p>
										<p className="mt-0.5 text-sm leading-5 text-kumo-subtle">
											{t`Copy this token now — it won't be shown again.`}
										</p>
									</div>
									<Button
										variant="ghost"
										size="sm"
										className="shrink-0"
										onClick={() => setNewToken(null)}
									>
										{t`Dismiss`}
									</Button>
								</div>
								<div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:ps-8">
									<code className="flex min-h-10 min-w-0 flex-1 select-all items-center overflow-hidden break-all rounded border border-kumo-line bg-kumo-base px-3 py-2 font-mono text-[0.9em] leading-5">
										{tokenVisible ? newToken.token : "••••••••••••••••••••••••••••"}
									</code>
									<div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
										<Tooltip
											content={tokenVisible ? t`Hide token` : t`Show token`}
											render={
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													onClick={() => setTokenVisible(!tokenVisible)}
													aria-label={tokenVisible ? t`Hide token` : t`Show token`}
													icon={tokenVisible ? <EyeSlash /> : <Eye />}
												/>
											}
										/>
										<Tooltip
											content={t`Copy token`}
											render={
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													onClick={handleCopyToken}
													aria-label={t`Copy token`}
													icon={<Copy />}
												/>
											}
										/>
									</div>
								</div>
								{copied && (
									<p className="text-sm text-kumo-success sm:ps-8" role="status">
										{t`Copied to clipboard`}
									</p>
								)}
							</div>
						</SettingRow>
					)}
					{showCreateForm ? (
						<SettingRow>
							<CreateTokenForm
								expirySelectItems={expirySelectItems}
								isCreating={createMutation.isPending}
								error={createMutation.error?.message ?? null}
								pluginScopes={plugins
									.filter((plugin) => (plugin.mcpTools?.length ?? 0) > 0)
									.map((plugin) => ({ scope: `mcp:tools:${plugin.id}`, name: plugin.name }))}
								onSubmit={(input) => createMutation.mutate(input)}
							/>
						</SettingRow>
					) : (
						!newToken && (
							<SettingRow className="text-sm leading-5 text-kumo-subtle">
								{t`Create personal access tokens for programmatic API access`}
							</SettingRow>
						)
					)}
				</SettingsSection>

				<SettingsSection
					title={t`API Tokens`}
					contentClassName={
						tokens && tokens.length > 0 ? undefined : "border-2 border-dashed border-kumo-subtle/60"
					}
				>
					{tokens && tokens.length > 0 ? (
						tokens.map((token) => (
							<SettingRow key={token.id}>
								<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
									<div className="min-w-0 flex-1">
										<div className="flex min-w-0 flex-wrap items-center gap-2">
											<span className="truncate text-sm font-medium">{token.name}</span>
											<code className="rounded bg-kumo-tint px-1.5 py-0.5 font-mono text-[0.9em] text-kumo-subtle">
												{token.prefix}...
											</code>
										</div>
										<dl className="mt-2 grid gap-1 text-sm leading-5">
											<div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-2">
												<dt className="shrink-0 font-medium">{t(msg`Scopes`)}</dt>
												<dd className="min-w-0 break-words text-kumo-subtle">
													{token.scopes.join(", ")}
												</dd>
											</div>
											<div className="flex flex-wrap gap-x-4 gap-y-1 text-kumo-subtle">
												<div className="flex gap-1.5">
													<dt>{t`Created`}</dt>
													<dd className="tabular-nums">
														{i18n.date(new Date(token.createdAt), { dateStyle: "medium" })}
													</dd>
												</div>
												{token.expiresAt && (
													<div className="flex gap-1.5">
														<dt>{t(msg`Expiry`)}</dt>
														<dd className="tabular-nums">
															{i18n.date(new Date(token.expiresAt), { dateStyle: "medium" })}
														</dd>
													</div>
												)}
												{token.lastUsedAt && (
													<div className="flex gap-1.5">
														<dt>{t`Last used`}</dt>
														<dd className="tabular-nums">
															{i18n.date(new Date(token.lastUsedAt), { dateStyle: "medium" })}
														</dd>
													</div>
												)}
											</div>
										</dl>
									</div>
									<div className="flex shrink-0 justify-end">
										<Button
											variant="ghost"
											size="sm"
											icon={<Trash />}
											className="text-kumo-danger"
											onClick={() => {
												revokeMutation.reset();
												setRevokeConfirmId(token.id);
											}}
											aria-label={t`Revoke token ${token.name}`}
										>
											{t(msg`Revoke token`)}
										</Button>
									</div>
								</div>
							</SettingRow>
						))
					) : (
						<SettingRow className="py-8 text-center text-sm text-kumo-subtle">
							{t`No API tokens yet. Create one to get started.`}
						</SettingRow>
					)}
				</SettingsSection>
			</div>

			<ConfirmDialog
				open={revokeConfirmId !== null}
				onClose={() => {
					setRevokeConfirmId(null);
					revokeMutation.reset();
				}}
				title={t(msg`Revoke?`)}
				description={revokeDescription}
				confirmLabel={t(msg`Confirm`)}
				pendingLabel={t(msg`Revoking...`)}
				isPending={revokeMutation.isPending}
				error={revokeMutation.error}
				onConfirm={() => revokeConfirmId && revokeMutation.mutate(revokeConfirmId)}
			/>
		</SettingsFrame>
	);
}

// =============================================================================
// Create token form
// =============================================================================

interface CreateTokenFormProps {
	expirySelectItems: Record<string, string>;
	isCreating: boolean;
	error: string | null;
	pluginScopes: Array<{ scope: string; name: string }>;
	onSubmit: (input: { name: string; scopes: string[]; expiresAt?: string }) => void;
}

function CreateTokenForm({
	expirySelectItems,
	isCreating,
	error,
	pluginScopes,
	onSubmit,
}: CreateTokenFormProps) {
	const { t } = useLingui();
	const [name, setName] = React.useState("");
	const [selectedScopes, setSelectedScopes] = React.useState<Set<string>>(new Set());
	const [expiry, setExpiry] = React.useState("30d");

	const toggleScope = (scope: string) => {
		setSelectedScopes((prev) => {
			const next = new Set(prev);
			if (next.has(scope)) {
				next.delete(scope);
			} else {
				next.add(scope);
			}
			return next;
		});
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		onSubmit({
			name: name.trim(),
			scopes: [...selectedScopes],
			expiresAt: computeExpiryDate(expiry),
		});
	};

	const isValid = name.trim().length > 0 && selectedScopes.size > 0;

	return (
		<div className="grid gap-4">
			{error && (
				<Banner variant="error" title={t`An error occurred`} description={error} role="alert" />
			)}

			<form onSubmit={handleSubmit} className="grid gap-4">
				<Input
					label={t(msg`Token Name`)}
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={t(msg`e.g., CI/CD Pipeline`)}
					required
					autoFocus
				/>

				<div className="grid gap-2">
					<div className="text-sm font-medium">{t(msg`Scopes`)}</div>
					<div className="grid gap-3">
						{API_TOKEN_SCOPE_VALUES.map(({ scope, label, description }) => {
							return (
								<label key={scope} className="flex cursor-pointer items-start gap-2">
									<Checkbox
										checked={selectedScopes.has(scope)}
										onCheckedChange={() => toggleScope(scope)}
										aria-label={t(label)}
									/>
									<div className="min-w-0">
										<div className="text-sm font-medium">{t(label)}</div>
										<div className="text-sm leading-5 text-kumo-subtle">{t(description)}</div>
									</div>
								</label>
							);
						})}
						{pluginScopes.map((plugin) => (
							<label key={plugin.scope} className="flex cursor-pointer items-start gap-2">
								<Checkbox
									checked={selectedScopes.has(plugin.scope)}
									onCheckedChange={() => toggleScope(plugin.scope)}
									aria-label={t`Plugin tools: ${plugin.name}`}
								/>
								<div className="min-w-0">
									<div className="text-sm font-medium">{t`Plugin tools: ${plugin.name}`}</div>
									<div className="text-sm leading-5 text-kumo-subtle">
										{t`Invoke only this plugin's enabled MCP tools`}
									</div>
								</div>
							</label>
						))}
					</div>
				</div>

				<Select
					label={t(msg`Expiry`)}
					value={expiry}
					onValueChange={(v) => v !== null && setExpiry(v)}
					items={expirySelectItems}
				>
					{EXPIRY_OPTIONS.map((option) => (
						<Select.Option key={option.value} value={option.value}>
							{t(option.label)}
						</Select.Option>
					))}
				</Select>

				<div className="flex flex-wrap gap-2 pt-2">
					<Button type="submit" disabled={!isValid || isCreating}>
						{isCreating ? t(msg`Creating...`) : t(msg`Create Token`)}
					</Button>
				</div>
			</form>
		</div>
	);
}
