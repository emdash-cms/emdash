/**
 * Allowed Domains Settings - Self-signup domain management
 *
 * Only available when using passkey auth. When external auth (e.g., Cloudflare Access)
 * is configured, this page shows an informational message instead.
 */

import { Button, Dialog, Input, Select, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Globe, Plus, Trash, Pencil, Info } from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchAllowedDomains,
	createAllowedDomain,
	updateAllowedDomain,
	deleteAllowedDomain,
	fetchManifest,
	type AllowedDomain,
} from "../../lib/api";
import { BackToSettingsLink } from "./BackToSettingsLink.js";
import { useAllowedDomainsRolesConfig } from "./useAllowedDomainsRolesConfig.js";

export function AllowedDomainsSettings() {
	const { t } = useLingui();
	const { getRoleLabel, signupRoles, signupRoleItems } = useAllowedDomainsRolesConfig();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [isAddingDomain, setIsAddingDomain] = React.useState(false);
	const [editingDomain, setEditingDomain] = React.useState<AllowedDomain | null>(null);
	const [deletingDomain, setDeletingDomain] = React.useState<string | null>(null);

	// Form state
	const [newDomain, setNewDomain] = React.useState("");
	const [newRole, setNewRole] = React.useState<number>(30); // Default to Author

	// Fetch manifest for auth mode
	const { data: manifest, isLoading: manifestLoading } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const isExternalAuth = manifest?.authMode && manifest.authMode !== "passkey";

	// Fetch domains (only when using passkey auth)
	const {
		data: domains,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["allowed-domains"],
		queryFn: fetchAllowedDomains,
		enabled: !isExternalAuth && !manifestLoading,
	});

	// Create mutation
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
				title: mutationError instanceof Error ? mutationError.message : t`Failed to add domain`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	// Update mutation
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
				title: mutationError instanceof Error ? mutationError.message : t`Failed to update domain`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: deleteAllowedDomain,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["allowed-domains"] });
			setDeletingDomain(null);
			toastManager.add({ title: t`Domain removed`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: mutationError instanceof Error ? mutationError.message : t`Failed to remove domain`,
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
		setEditingDomain(null);
	};

	const handleDelete = () => {
		if (deletingDomain) {
			deleteMutation.mutate(deletingDomain);
		}
	};

	const settingsHeader = (
		<div className="flex items-center gap-3">
			<BackToSettingsLink />
			<h1 className="text-2xl font-bold">{t`Self-Signup Domains`}</h1>
		</div>
	);

	if (manifestLoading || isLoading) {
		return (
			<div className="space-y-6">
				{settingsHeader}
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-subtle">{t`Loading...`}</p>
				</div>
			</div>
		);
	}

	// Show message when external auth is configured
	if (isExternalAuth) {
		return (
			<div className="space-y-6">
				{settingsHeader}
				<div className="rounded-lg border bg-kumo-base p-6">
					<div className="flex items-start gap-3">
						<Info className="h-5 w-5 text-kumo-subtle mt-0.5 flex-shrink-0" />
						<div className="space-y-2">
							<p className="text-kumo-subtle">
								{t`User access is managed by an external provider (${manifest?.authMode}). Self-signup domain settings are not available when using external authentication.`}
							</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				{settingsHeader}
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-danger">
						{error instanceof Error ? error.message : t`Failed to load allowed domains`}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{settingsHeader}

			{/* Domains Section */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<Globe className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">{t`Allowed Domains`}</h2>
				</div>

				<p className="text-sm text-kumo-subtle mb-6">
					{t`Users with email addresses from these domains can sign up without an invite. They will be assigned the specified role automatically.`}
				</p>

				{/* Domain list */}
				{domains && domains.length > 0 ? (
					<div className="space-y-2">
						{domains.map((domain) => (
							<div
								key={domain.domain}
								className={`flex items-center justify-between p-4 rounded-lg border ${
									domain.enabled ? "bg-kumo-base" : "bg-kumo-tint/50 opacity-60"
								}`}
							>
								<div className="flex items-center gap-4">
									<Switch
										checked={domain.enabled}
										onCheckedChange={() => handleToggleEnabled(domain)}
										disabled={updateMutation.isPending}
									/>
									<div>
										<div className="font-medium">{domain.domain}</div>
										<div className="text-sm text-kumo-subtle">
											{t`Default role:`} {getRoleLabel(domain.defaultRole)}
										</div>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<Button
										variant="ghost"
										shape="square"
										onClick={() => setEditingDomain(domain)}
										disabled={updateMutation.isPending}
										aria-label={t`Edit ${domain.domain}`}
									>
										<Pencil className="h-4 w-4" />
									</Button>
									<Button
										variant="ghost"
										shape="square"
										onClick={() => setDeletingDomain(domain.domain)}
										disabled={deleteMutation.isPending}
										aria-label={t`Delete ${domain.domain}`}
									>
										<Trash className="h-4 w-4 text-kumo-danger" />
									</Button>
								</div>
							</div>
						))}
					</div>
				) : (
					<div className="rounded-lg border border-dashed p-6 text-center text-kumo-subtle">
						{t`No domains configured. Users must be invited individually.`}
					</div>
				)}

				{/* Add domain section */}
				<div className="mt-6 pt-6 border-t">
					{isAddingDomain ? (
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<h3 className="font-medium">{t`Add an allowed domain`}</h3>
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
							</div>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-2">
									<Input
										label={t`Domain`}
										placeholder="example.com"
										value={newDomain}
										onChange={(e) => setNewDomain(e.target.value)}
									/>
								</div>
								<div className="space-y-2">
									<Select
										label={t`Default Role`}
										value={String(newRole)}
										onValueChange={(v) => v !== null && setNewRole(Number(v))}
										items={signupRoleItems}
									>
										{signupRoles.map((role) => (
											<Select.Option key={role.value} value={String(role.value)}>
												{role.label}
											</Select.Option>
										))}
									</Select>
								</div>
							</div>
							<Button
								onClick={handleAddDomain}
								disabled={!newDomain.trim() || createMutation.isPending}
							>
								{createMutation.isPending ? t`Adding...` : t`Add Domain`}
							</Button>
						</div>
					) : (
						<Button onClick={() => setIsAddingDomain(true)} icon={<Plus />}>
							{t`Add Domain`}
						</Button>
					)}
				</div>
			</div>

			{/* Edit Domain Dialog */}
			<Dialog.Root
				open={!!editingDomain}
				onOpenChange={(open: boolean) => !open && setEditingDomain(null)}
			>
				<Dialog className="p-6" size="lg">
					<div className="flex items-start justify-between gap-4 mb-4">
						<div className="flex flex-col space-y-1.5">
							<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
								{t`Edit Domain`}
							</Dialog.Title>
							<Dialog.Description className="text-sm text-kumo-subtle">
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
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Select
								label={t`Default Role`}
								value={String(editingDomain?.defaultRole ?? 30)}
								onValueChange={(v) =>
									v !== null && editingDomain && handleUpdateRole(editingDomain.domain, Number(v))
								}
								items={signupRoleItems}
							>
								{signupRoles.map((role) => (
									<Select.Option key={role.value} value={String(role.value)}>
										{role.label}
									</Select.Option>
								))}
							</Select>
						</div>
					</div>
				</Dialog>
			</Dialog.Root>

			{/* Delete Confirmation */}
			<Dialog.Root
				open={!!deletingDomain}
				onOpenChange={(open) => !open && setDeletingDomain(null)}
				disablePointerDismissal
			>
				<Dialog className="p-6" size="sm">
					<Dialog.Title className="text-lg font-semibold">{t`Remove Domain?`}</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle">
						{t`Users from`} <strong>{deletingDomain}</strong>{" "}
						{t`will no longer be able to sign up without an invite. Existing users are not affected.`}
					</Dialog.Description>
					<div className="mt-6 flex justify-end gap-2">
						<Dialog.Close
							render={(p) => (
								<Button {...p} variant="secondary">
									{t`Cancel`}
								</Button>
							)}
						/>
						<Dialog.Close
							render={(p) => (
								<Button {...p} variant="destructive" onClick={handleDelete}>
									{t`Remove Domain`}
								</Button>
							)}
						/>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}

export default AllowedDomainsSettings;
