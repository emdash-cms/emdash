/**
 * API Tokens settings page
 *
 * Allows admins to list, create, and revoke Personal Access Tokens.
 */

import { Banner, Button, Checkbox, Input, Loader, Select } from "@cloudflare/kumo";
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
		label: msg`Content read`,
		description: msg`Read content entries`,
	},
	{
		scope: API_TOKEN_SCOPES.ContentWrite,
		label: msg`Content write`,
		description: msg`Create, update, delete content`,
	},
	{
		scope: API_TOKEN_SCOPES.MediaRead,
		label: msg`Media read`,
		description: msg`Read media files`,
	},
	{
		scope: API_TOKEN_SCOPES.MediaWrite,
		label: msg`Media write`,
		description: msg`Upload and delete media`,
	},
	{
		scope: API_TOKEN_SCOPES.SchemaRead,
		label: msg`Schema read`,
		description: msg`Read collection schemas`,
	},
	{
		scope: API_TOKEN_SCOPES.SchemaWrite,
		label: msg`Schema write`,
		description: msg`Modify collection schemas`,
	},
	{
		scope: API_TOKEN_SCOPES.TaxonomiesManage,
		label: msg`Manage taxonomies`,
		description: msg`Create, update, and delete taxonomy terms`,
	},
	{
		scope: API_TOKEN_SCOPES.MenusManage,
		label: msg`Manage menus`,
		description: msg`Create, update, and delete navigation menus`,
	},
	{
		scope: API_TOKEN_SCOPES.SettingsRead,
		label: msg`Settings read`,
		description: msg`Read site settings`,
	},
	{
		scope: API_TOKEN_SCOPES.SettingsManage,
		label: msg`Manage settings`,
		description: msg`Update site settings`,
	},
	{
		scope: API_TOKEN_SCOPES.McpTools,
		label: msg`Plugin MCP tools`,
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
	const { t } = useLingui();
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
	const revokeDescription = tokenToRevoke
		? t`Revoke ${tokenToRevoke.name}? Any integration using it will immediately lose access.`
		: t`Revoke this token? Any integration using it will immediately lose access.`;
	const title = t`API tokens`;
	const description = t`Create and revoke tokens for API access.`;

	if (isLoading) {
		return (
			<SettingsFrame title={title} description={description}>
				<div
					className="flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 text-sm text-kumo-subtle"
					role="status"
				>
					<Loader size="sm" />
					<span>{t`Loading API tokens…`}</span>
				</div>
			</SettingsFrame>
		);
	}

	if (loadError) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`Unable to load API tokens`}
					description={
						loadError instanceof Error ? loadError.message : t`Failed to load API tokens`
					}
					role="alert"
				/>
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame title={title} description={description}>
			<div className="grid gap-8">
				<SettingsSection
					title={t`Create a token`}
					description={t`Choose a name, permissions, and expiration for a new token.`}
					actions={
						showCreateForm ? (
							<Button variant="ghost" size="sm" onClick={() => setShowCreateForm(false)}>
								{t`Cancel`}
							</Button>
						) : (
							<Button icon={<Plus />} onClick={() => setShowCreateForm(true)}>
								{t`Create token`}
							</Button>
						)
					}
				>
					{newToken && (
						<SettingRow className="bg-kumo-success-tint">
							<div className="flex flex-col gap-3 sm:flex-row sm:items-start">
								<div className="flex min-w-0 flex-1 items-start gap-3">
									<span
										className="h-lh flex shrink-0 items-center text-kumo-success"
										aria-hidden="true"
									>
										<Key className="h-5 w-5" />
									</span>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium text-kumo-success">
											{t`Token created: ${newToken.info.name}`}
										</p>
										<p className="mt-1 text-sm leading-5 text-kumo-subtle">
											{t`Copy this token now — it won't be shown again.`}
										</p>
										<div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
											<code className="min-w-0 flex-1 truncate rounded border border-kumo-line bg-kumo-base px-3 py-2 font-mono text-[0.9em]">
												{tokenVisible ? newToken.token : "••••••••••••••••••••••••••••"}
											</code>
											<div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
												<Button
													variant="ghost"
													shape="square"
													onClick={() => setTokenVisible(!tokenVisible)}
													aria-label={tokenVisible ? t`Hide token` : t`Show token`}
												>
													{tokenVisible ? <EyeSlash /> : <Eye />}
												</Button>
												<Button
													variant="ghost"
													shape="square"
													onClick={handleCopyToken}
													aria-label={t`Copy token`}
												>
													<Copy />
												</Button>
											</div>
										</div>
										{copied && (
											<p className="mt-1 text-sm text-kumo-success" role="status">
												{t`Copied to clipboard`}
											</p>
										)}
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									className="self-end sm:self-start"
									onClick={() => setNewToken(null)}
								>
									{t`Dismiss`}
								</Button>
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
								{t`Tokens grant programmatic access to your site. Only select the permissions an integration needs.`}
							</SettingRow>
						)
					)}
				</SettingsSection>

				<SettingsSection
					title={t`Active tokens`}
					description={t`Review and revoke tokens that can access your site.`}
					contentClassName={
						tokens && tokens.length > 0 ? undefined : "border-2 border-dashed border-kumo-subtle/60"
					}
				>
					{tokens && tokens.length > 0 ? (
						tokens.map((token) => (
							<SettingRow key={token.id}>
								<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
									<div className="min-w-0">
										<div className="flex min-w-0 flex-wrap items-center gap-2">
											<span className="truncate text-sm font-medium">{token.name}</span>
											<code className="rounded bg-kumo-tint px-1.5 py-0.5 font-mono text-[0.8em] text-kumo-subtle">
												{token.prefix}...
											</code>
										</div>
										<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm leading-5 text-kumo-subtle">
											<span>{t`Scopes: ${token.scopes.join(", ")}`}</span>
											{token.expiresAt && (
												<span>{t`Expires ${new Date(token.expiresAt).toLocaleDateString()}`}</span>
											)}
											{token.lastUsedAt && (
												<span>{t`Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}</span>
											)}
										</div>
										<div className="text-sm leading-5 text-kumo-subtle">
											{t`Created ${new Date(token.createdAt).toLocaleDateString()}`}
										</div>
									</div>
									<Button
										variant="ghost"
										shape="square"
										className="self-end sm:self-auto"
										onClick={() => {
											revokeMutation.reset();
											setRevokeConfirmId(token.id);
										}}
										aria-label={t`Revoke ${token.name}`}
									>
										<Trash className="h-4 w-4 text-kumo-danger" />
									</Button>
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
				title={t`Revoke token?`}
				description={revokeDescription}
				confirmLabel={t`Revoke token`}
				pendingLabel={t`Revoking…`}
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
				<Banner
					variant="error"
					title={t`Unable to create token`}
					description={error}
					role="alert"
				/>
			)}

			<form onSubmit={handleSubmit} className="grid gap-4">
				<Input
					label={t(msg`Token name`)}
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={t(msg`e.g., CI/CD pipeline`)}
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
					label={t(msg`Expiration`)}
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
						{isCreating ? t(msg`Creating…`) : t(msg`Create token`)}
					</Button>
				</div>
			</form>
		</div>
	);
}
