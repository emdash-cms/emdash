/**
 * Allowed Domains Settings - Self-signup domain management
 *
 * Only available when using passkey auth. When external auth (e.g., Cloudflare Access)
 * is configured, this page shows an informational message instead.
 */

import {
	Banner,
	Button,
	Dialog,
	Input,
	Loader,
	Select,
	Switch,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import { Pencil, Plus, Trash, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	createAllowedDomain,
	deleteAllowedDomain,
	fetchAllowedDomains,
	fetchManifest,
	updateAllowedDomain,
	type AllowedDomain,
} from "../../lib/api";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { DialogError, getMutationError } from "../DialogError.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";
import { useAllowedDomainsRolesConfig } from "./useAllowedDomainsRolesConfig.js";

export function DomainRemovalMessage({ domain }: { domain: string }) {
	return (
		<Trans>
			Users from <strong>{domain}</strong> will no longer be able to sign up without an invite.
			Existing users are not affected.
		</Trans>
	);
}

export function AllowedDomainsSettings() {
	const { t } = useLingui();
	const { getRoleLabel, signupRoles, signupRoleItems } = useAllowedDomainsRolesConfig();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [isAddingDomain, setIsAddingDomain] = React.useState(false);
	const [editingDomain, setEditingDomain] = React.useState<AllowedDomain | null>(null);
	const [deletingDomain, setDeletingDomain] = React.useState<string | null>(null);
	const [newDomain, setNewDomain] = React.useState("");
	const [newRole, setNewRole] = React.useState<number>(30);

	const { data: manifest, isLoading: manifestLoading } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const isExternalAuth = manifest?.authMode && manifest.authMode !== "passkey";

	const {
		data: domains,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["allowed-domains"],
		queryFn: fetchAllowedDomains,
		enabled: !isExternalAuth && !manifestLoading,
	});

	const createMutation = useMutation({
		mutationFn: createAllowedDomain,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["allowed-domains"] });
			setIsAddingDomain(false);
			setNewDomain("");
			setNewRole(30);
			toastManager.add({ title: t`Domain added successfully`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: t`Failed to add domain`,
				description: mutationError instanceof Error ? mutationError.message : t`An error occurred`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	const updateMutation = useMutation({
		mutationFn: ({
			domain,
			data,
		}: {
			domain: string;
			data: { enabled?: boolean; defaultRole?: number };
		}) => updateAllowedDomain(domain, data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["allowed-domains"] });
			setEditingDomain(null);
			toastManager.add({ title: t`Domain updated`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: t`Failed to update domain`,
				description: mutationError instanceof Error ? mutationError.message : t`An error occurred`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: deleteAllowedDomain,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["allowed-domains"] });
			setDeletingDomain(null);
			toastManager.add({ title: t`Domain removed`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: t`Failed to remove domain`,
				description: mutationError instanceof Error ? mutationError.message : t`An error occurred`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	const handleAddDomain = () => {
		if (!newDomain.trim()) return;
		createMutation.mutate({
			domain: newDomain.trim().toLowerCase(),
			defaultRole: newRole,
		});
	};

	const handleToggleEnabled = (domain: AllowedDomain) => {
		updateMutation.mutate({
			domain: domain.domain,
			data: { enabled: !domain.enabled },
		});
	};

	const handleUpdateRole = (domain: string, role: number) => {
		updateMutation.mutate({
			domain,
			data: { defaultRole: role },
		});
	};

	const handleDelete = () => {
		if (deletingDomain) deleteMutation.mutate(deletingDomain);
	};

	const title = t`Self-Signup Domains`;
	const description = t`Allow users from specific domains to sign up`;

	if (manifestLoading || isLoading) {
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

	if (isExternalAuth) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="secondary"
					title={t`Self-Signup Domains`}
					description={t`User access is managed by an external provider (${manifest?.authMode}). Self-signup domain settings are not available when using external authentication.`}
					role="status"
				/>
			</SettingsFrame>
		);
	}

	if (error) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`Failed to load allowed domains`}
					description={error instanceof Error ? error.message : t`Failed to load allowed domains`}
					role="alert"
				/>
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame title={title} description={description}>
			<SettingsSection
				title={t`Allowed Domains`}
				description={t`Users with email addresses from these domains can sign up without an invite. They will be assigned the specified role automatically.`}
				actions={
					isAddingDomain ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setIsAddingDomain(false);
								setNewDomain("");
							}}
						>
							{t`Cancel`}
						</Button>
					) : (
						<Button onClick={() => setIsAddingDomain(true)} icon={<Plus />}>
							{t`Add Domain`}
						</Button>
					)
				}
				contentClassName={
					domains && domains.length > 0 ? undefined : "border-2 border-dashed border-kumo-subtle/60"
				}
			>
				{domains && domains.length > 0 ? (
					domains.map((domain) => (
						<SettingRow
							key={domain.domain}
							className={domain.enabled ? undefined : "bg-kumo-tint/50"}
						>
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex min-w-0 items-start gap-3">
									<Switch
										checked={domain.enabled}
										onCheckedChange={() => handleToggleEnabled(domain)}
										disabled={updateMutation.isPending}
										aria-labelledby={`allowed-domain-${domain.domain}`}
									/>
									<div className="min-w-0">
										<div
											id={`allowed-domain-${domain.domain}`}
											className="break-words text-sm font-medium"
										>
											{domain.domain}
										</div>
										<div className="text-sm leading-5 text-kumo-subtle">
											{t`Default role:`} {getRoleLabel(domain.defaultRole)}
										</div>
									</div>
								</div>
								<div className="flex shrink-0 self-end items-center gap-1 sm:self-center">
									<Button
										variant="ghost"
										shape="square"
										onClick={() => {
											updateMutation.reset();
											setEditingDomain(domain);
										}}
										disabled={updateMutation.isPending}
										aria-label={t`Edit ${domain.domain}`}
									>
										<Pencil className="h-4 w-4" />
									</Button>
									<Button
										variant="ghost"
										shape="square"
										onClick={() => {
											deleteMutation.reset();
											setDeletingDomain(domain.domain);
										}}
										disabled={deleteMutation.isPending}
										aria-label={t`Delete ${domain.domain}`}
									>
										<Trash className="h-4 w-4 text-kumo-danger" />
									</Button>
								</div>
							</div>
						</SettingRow>
					))
				) : (
					<SettingRow className="py-8 text-center text-sm text-kumo-subtle">
						{t`No domains configured. Users must be invited individually.`}
					</SettingRow>
				)}
				{isAddingDomain && (
					<SettingRow>
						<div className="grid gap-4">
							<div className="grid gap-4 sm:grid-cols-2">
								<Input
									label={t`Domain`}
									placeholder={t`example.com`}
									value={newDomain}
									onChange={(event) => setNewDomain(event.target.value)}
								/>
								<Select
									label={t`Default Role`}
									value={String(newRole)}
									onValueChange={(value) => value !== null && setNewRole(Number(value))}
									items={signupRoleItems}
								>
									{signupRoles.map((role) => (
										<Select.Option key={role.value} value={String(role.value)}>
											{role.label}
										</Select.Option>
									))}
								</Select>
							</div>
							<Button
								onClick={handleAddDomain}
								disabled={!newDomain.trim() || createMutation.isPending}
							>
								{createMutation.isPending ? t`Adding...` : t`Add Domain`}
							</Button>
						</div>
					</SettingRow>
				)}
			</SettingsSection>

			<Dialog.Root
				open={editingDomain !== null}
				onOpenChange={(open: boolean) => !open && setEditingDomain(null)}
			>
				<Dialog className="p-6" size="lg">
					<div className="mb-4 flex items-start justify-between gap-4">
						<div className="flex flex-col gap-1.5">
							<Dialog.Title className="text-lg font-semibold leading-tight">
								{t`Edit Domain`}
							</Dialog.Title>
							<Dialog.Description className="text-sm leading-5 text-kumo-subtle">
								{t`Update settings for ${editingDomain?.domain}`}
							</Dialog.Description>
						</div>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button
									{...props}
									variant="ghost"
									shape="square"
									aria-label={t`Close`}
									className="absolute end-4 top-4"
								>
									<X className="h-4 w-4" />
									<span className="sr-only">{t`Close`}</span>
								</Button>
							)}
						/>
					</div>
					<div className="grid gap-4 py-4">
						<Select
							label={t`Default Role`}
							value={String(editingDomain?.defaultRole ?? 30)}
							onValueChange={(value) =>
								value !== null &&
								editingDomain &&
								handleUpdateRole(editingDomain.domain, Number(value))
							}
							items={signupRoleItems}
							disabled={updateMutation.isPending}
						>
							{signupRoles.map((role) => (
								<Select.Option key={role.value} value={String(role.value)}>
									{role.label}
								</Select.Option>
							))}
						</Select>
						<DialogError message={getMutationError(updateMutation.error)} />
					</div>
				</Dialog>
			</Dialog.Root>

			<ConfirmDialog
				open={deletingDomain !== null}
				onClose={() => {
					setDeletingDomain(null);
					deleteMutation.reset();
				}}
				title={t`Remove Domain?`}
				description={<DomainRemovalMessage domain={deletingDomain ?? ""} />}
				confirmLabel={t`Remove Domain`}
				pendingLabel={t`Removing...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={handleDelete}
			/>
		</SettingsFrame>
	);
}

export default AllowedDomainsSettings;
