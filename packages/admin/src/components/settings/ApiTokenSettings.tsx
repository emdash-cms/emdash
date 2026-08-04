/**
 * API Tokens settings page
 *
 * Allows admins to list, create, and revoke Personal Access Tokens.
 */

import { Button, Checkbox, Input, Select } from "@cloudflare/kumo";
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
import { DialogError, getMutationError } from "../DialogError.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";
import {
	SettingsEmptyState,
	SettingsErrorState,
	SettingsFrame,
	SettingsLoadingState,
	SettingsSection,
} from "./SettingsLayout.js";

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
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [showCreateForm, setShowCreateForm] = React.useState(false);
	const [newToken, setNewToken] = React.useState<ApiTokenCreateResult | null>(null);
	const [tokenVisible, setTokenVisible] = React.useState(false);
	const [copied, setCopied] = React.useState(false);
	const [revokeConfirmId, setRevokeConfirmId] = React.useState<string | null>(null);

	// Queries
	const {
		data: tokens,
		isLoading,
		error: tokensError,
	} = useQuery({
		queryKey: ["api-tokens"],
		queryFn: fetchApiTokens,
	});
	const { data: plugins = [] } = useQuery({
		queryKey: ["plugins"],
		queryFn: fetchPlugins,
	});

	// Create mutation
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

	// Revoke mutation
	const revokeMutation = useMutation({
		mutationFn: revokeApiToken,
		onSuccess: () => {
			setRevokeConfirmId(null);
			void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
		},
	});

	// Clean up copy feedback timeout on unmount
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

	if (isLoading) {
		return (
			<SettingsFrame title={t(msg`API Tokens`)} leading={<BackToSettingsLink />}>
				<SettingsLoadingState />
			</SettingsFrame>
		);
	}

	if (tokensError) {
		return (
			<SettingsFrame title={t(msg`API Tokens`)} leading={<BackToSettingsLink />}>
				<SettingsErrorState
					message={getMutationError(tokensError) ?? t`Failed to load API tokens`}
				/>
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame
			title={t(msg`API Tokens`)}
			description={t(msg`Create personal access tokens for programmatic API access`)}
			leading={<BackToSettingsLink />}
		>
			<div className="space-y-8">
				{/* New token banner */}
				{newToken && (
					<div className="rounded-lg border border-kumo-success/50 bg-kumo-success-tint p-4">
						<div className="flex items-start gap-3">
							<Key className="h-5 w-5 text-kumo-success mt-0.5 shrink-0" />
							<div className="flex-1 min-w-0">
								<p className="font-medium text-kumo-success">
									{t(msg`Token created: ${newToken.info.name}`)}
								</p>
								<p className="text-sm text-kumo-subtle mt-1">
									{t(msg`Copy this token now — it won't be shown again.`)}
								</p>
								<div className="mt-3 flex items-center gap-2">
									<code className="flex-1 rounded bg-kumo-base px-3 py-2 text-sm font-mono border truncate">
										{tokenVisible ? newToken.token : "••••••••••••••••••••••••••••"}
									</code>
									<Button
										type="button"
										variant="ghost"
										shape="square"
										onClick={() => setTokenVisible(!tokenVisible)}
										aria-label={tokenVisible ? t(msg`Hide token`) : t(msg`Show token`)}
									>
										{tokenVisible ? <EyeSlash /> : <Eye />}
									</Button>
									<Button
										type="button"
										variant="ghost"
										shape="square"
										onClick={handleCopyToken}
										aria-label={t(msg`Copy token`)}
									>
										<Copy />
									</Button>
								</div>
								{copied && (
									<p className="text-xs text-kumo-success mt-1">{t(msg`Copied to clipboard`)}</p>
								)}
							</div>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setNewToken(null)}
								aria-label={t(msg`Dismiss`)}
							>
								{t(msg`Dismiss`)}
							</Button>
						</div>
					</div>
				)}

				<SettingsSection
					title={t(msg`Create a token`)}
					description={t(msg`Create a personal access token with only the scopes it needs.`)}
				>
					{showCreateForm ? (
						<CreateTokenForm
							expirySelectItems={expirySelectItems}
							isCreating={createMutation.isPending}
							error={getMutationError(createMutation.error)}
							pluginScopes={plugins
								.filter((plugin) => (plugin.mcpTools?.length ?? 0) > 0)
								.map((plugin) => ({ scope: `mcp:tools:${plugin.id}`, name: plugin.name }))}
							onSubmit={(input) =>
								createMutation.mutate({
									name: input.name,
									scopes: input.scopes,
									expiresAt: input.expiresAt,
								})
							}
							onCancel={() => setShowCreateForm(false)}
						/>
					) : (
						<Button type="button" icon={<Plus />} onClick={() => setShowCreateForm(true)}>
							{t(msg`Create Token`)}
						</Button>
					)}
				</SettingsSection>

				<SettingsSection title={t(msg`Active tokens`)}>
					{!tokens || tokens.length === 0 ? (
						<SettingsEmptyState>
							{t(msg`No API tokens yet. Create one to get started.`)}
						</SettingsEmptyState>
					) : (
						<ul className="divide-y divide-kumo-line">
							{tokens.map((token) => (
								<li
									key={token.id}
									className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
								>
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<span className="font-medium truncate">{token.name}</span>
											<code className="text-xs text-kumo-subtle bg-kumo-tint px-1.5 py-0.5 rounded">
												{token.prefix}...
											</code>
										</div>
										<div className="flex gap-3 mt-1 text-xs text-kumo-subtle">
											<span>{t(msg`Scopes: ${token.scopes.join(", ")}`)}</span>
											{token.expiresAt && (
												<span>
													{t(msg`Expires ${new Date(token.expiresAt).toLocaleDateString()}`)}
												</span>
											)}
											{token.lastUsedAt && (
												<span>
													{t(msg`Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`)}
												</span>
											)}
										</div>
										<div className="text-xs text-kumo-subtle mt-0.5">
											{t(msg`Created ${new Date(token.createdAt).toLocaleDateString()}`)}
										</div>
									</div>

									<Button
										type="button"
										variant="ghost"
										shape="square"
										onClick={() => {
											revokeMutation.reset();
											setRevokeConfirmId(token.id);
										}}
										aria-label={t(msg`Revoke token`)}
									>
										<Trash className="h-4 w-4 text-kumo-subtle hover:text-kumo-danger" />
									</Button>
								</li>
							))}
						</ul>
					)}
				</SettingsSection>
			</div>

			<ConfirmDialog
				open={revokeConfirmId !== null}
				onClose={() => {
					setRevokeConfirmId(null);
					revokeMutation.reset();
				}}
				title={t(msg`Revoke token?`)}
				description={t(
					msg`The token ${tokenToRevoke?.name ?? ""} will stop working immediately. This action cannot be undone.`,
				)}
				confirmLabel={t(msg`Revoke`)}
				pendingLabel={t(msg`Revoking...`)}
				isPending={revokeMutation.isPending}
				error={revokeMutation.error}
				onConfirm={() => {
					if (revokeConfirmId) revokeMutation.mutate(revokeConfirmId);
				}}
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
	onCancel: () => void;
}

function CreateTokenForm({
	expirySelectItems,
	isCreating,
	error,
	pluginScopes,
	onSubmit,
	onCancel,
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
		<div className="space-y-4">
			{error && <DialogError message={error} />}

			<form onSubmit={handleSubmit} className="space-y-4">
				<Input
					label={t(msg`Token Name`)}
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={t(msg`e.g., CI/CD Pipeline`)}
					required
					autoFocus
				/>

				<div>
					<div className="text-sm font-medium mb-2">{t(msg`Scopes`)}</div>
					<div className="space-y-2">
						{API_TOKEN_SCOPE_VALUES.map(({ scope, label, description }) => {
							return (
								<label key={scope} className="flex items-start gap-2 cursor-pointer">
									<Checkbox
										checked={selectedScopes.has(scope)}
										onCheckedChange={() => toggleScope(scope)}
										aria-label={t(label)}
									/>
									<div>
										<div className="text-sm font-medium">{t(label)}</div>
										<div className="text-xs text-kumo-subtle">{t(description)}</div>
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
								<div>
									<div className="text-sm font-medium">{t`Plugin tools: ${plugin.name}`}</div>
									<div className="text-xs text-kumo-subtle">
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

				<div className="flex gap-2 pt-2">
					<Button type="submit" disabled={!isValid || isCreating}>
						{isCreating ? t(msg`Creating...`) : t(msg`Create Token`)}
					</Button>
					<Button type="button" variant="outline" onClick={onCancel}>
						{t(msg`Cancel`)}
					</Button>
				</div>
			</form>
		</div>
	);
}
