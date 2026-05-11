/**
 * API Tokens settings page
 *
 * Allows admins to list, create, and revoke Personal Access Tokens.
 */

import { Button, Checkbox, Input, Loader, Select } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Copy, Eye, EyeSlash, Key, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
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
import { getMutationError } from "../DialogError.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

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
	const { data: tokens, isLoading } = useQuery({
		queryKey: ["api-tokens"],
		queryFn: fetchApiTokens,
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

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-3">
				<BackToSettingsLink />
				<div>
					<h1 className="text-2xl font-bold">{t(msg`API Tokens`)}</h1>
					<p className="text-sm text-kumo-subtle">
						{t(msg`Create personal access tokens for programmatic API access`)}
					</p>
				</div>
			</div>

			{/* New token banner */}
			{newToken && (
				<div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-4">
					<div className="flex items-start gap-3">
						<Key className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
						<div className="flex-1 min-w-0">
							<p className="font-medium text-green-800 dark:text-green-200">
								{t(msg`Token created: ${newToken.info.name}`)}
							</p>
							<p className="text-sm text-green-700 dark:text-green-300 mt-1">
								{t(msg`Copy this token now — it won't be shown again.`)}
							</p>
							<div className="mt-3 flex items-center gap-2">
								<code className="flex-1 rounded bg-white dark:bg-black/30 px-3 py-2 text-sm font-mono border truncate">
									{tokenVisible ? newToken.token : "••••••••••••••••••••••••••••"}
								</code>
								<Button
									variant="ghost"
									shape="square"
									onClick={() => setTokenVisible(!tokenVisible)}
									aria-label={tokenVisible ? t(msg`Hide token`) : t(msg`Show token`)}
								>
									{tokenVisible ? <EyeSlash /> : <Eye />}
								</Button>
								<Button
									variant="ghost"
									shape="square"
									onClick={handleCopyToken}
									aria-label={t(msg`Copy token`)}
								>
									<Copy />
								</Button>
							</div>
							{copied && (
								<p className="text-xs text-green-600 dark:text-green-400 mt-1">
									{t(msg`Copied to clipboard`)}
								</p>
							)}
						</div>
						<Button
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

			{/* Create form */}
			{showCreateForm ? (
				<CreateTokenForm
					expirySelectItems={expirySelectItems}
					isCreating={createMutation.isPending}
					error={createMutation.error?.message ?? null}
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
				<Button icon={<Plus />} onClick={() => setShowCreateForm(true)}>
					{t(msg`Create Token`)}
				</Button>
			)}

			{/* Token list */}
			<div className="rounded-lg border bg-kumo-base">
				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Loader />
					</div>
				) : !tokens || tokens.length === 0 ? (
					<div className="py-8 text-center text-sm text-kumo-subtle">
						{t(msg`No API tokens yet. Create one to get started.`)}
					</div>
				) : (
					<div className="divide-y">
						{tokens.map((token) => (
							<div key={token.id} className="flex items-center justify-between p-4">
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

								{revokeConfirmId === token.id ? (
									<div className="flex items-center gap-2 shrink-0">
										{revokeMutation.error && (
											<span className="text-sm text-kumo-danger">
												{getMutationError(revokeMutation.error)}
											</span>
										)}
										<span className="text-sm text-kumo-danger">{t(msg`Revoke?`)}</span>
										<Button
											variant="destructive"
											size="sm"
											disabled={revokeMutation.isPending}
											onClick={() => revokeMutation.mutate(token.id)}
										>
											{revokeMutation.isPending ? t(msg`Revoking...`) : t(msg`Confirm`)}
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												setRevokeConfirmId(null);
												revokeMutation.reset();
											}}
										>
											{t(msg`Cancel`)}
										</Button>
									</div>
								) : (
									<Button
										variant="ghost"
										shape="square"
										onClick={() => setRevokeConfirmId(token.id)}
										aria-label={t(msg`Revoke token`)}
									>
										<Trash className="h-4 w-4 text-kumo-subtle hover:text-kumo-danger" />
									</Button>
								)}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

// =============================================================================
// Create token form
// =============================================================================

interface CreateTokenFormProps {
	expirySelectItems: Record<string, string>;
	isCreating: boolean;
	error: string | null;
	onSubmit: (input: { name: string; scopes: string[]; expiresAt?: string }) => void;
	onCancel: () => void;
}

function CreateTokenForm({
	expirySelectItems,
	isCreating,
	error,
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
		<div className="rounded-lg border bg-kumo-base p-6">
			<h2 className="text-lg font-semibold mb-4">{t(msg`Create New Token`)}</h2>

			{error && (
				<div className="mb-4 rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-3 flex items-center gap-2 text-sm text-kumo-danger">
					<WarningCircle className="h-4 w-4 shrink-0" />
					{error}
				</div>
			)}

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
									/>
									<div>
										<div className="text-sm font-medium">{t(label)}</div>
										<div className="text-xs text-kumo-subtle">{t(description)}</div>
									</div>
								</label>
							);
						})}
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
