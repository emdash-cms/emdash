/**
 * Allowed Domains Settings - Self-signup domain management
 *
 * Only available when using passkey auth. When external auth (e.g., Cloudflare Access)
 * is configured, this page shows an informational message instead.
 */

import {
	Banner,
	Button,
	Input,
	LayerDialog,
	Loader,
	Select,
	Switch,
	useKumoToastManager,
} from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Pencil, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	ApiResponseError,
	createAllowedDomain,
	deleteAllowedDomain,
	fetchAllowedDomains,
	fetchManifest,
	updateAllowedDomain,
	type AllowedDomain,
	type CreateAllowedDomainInput,
} from "../../lib/api";
import { guardUnsavedInput, revealErrors, useSingleFlight } from "../../lib/dialog-form.js";
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

const DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+$/;

function domainProblem(domain: string): MessageDescriptor | undefined {
	if (!domain) return msg`Enter a domain.`;
	if (!DOMAIN_PATTERN.test(domain)) return msg`Enter a domain such as example.com.`;
	return undefined;
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
	const [addSubmitted, setAddSubmitted] = React.useState(false);
	const [takenDomain, setTakenDomain] = React.useState<string | null>(null);
	const [editRole, setEditRole] = React.useState<number>(30);
	const editFormId = React.useId();

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
			setAddSubmitted(false);
			setTakenDomain(null);
			toastManager.add({ title: t`Domain added successfully`, variant: "success", timeout: 3000 });
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
	});

	const deleteMutation = useMutation({
		mutationFn: deleteAllowedDomain,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["allowed-domains"] });
			setDeletingDomain(null);
			toastManager.add({ title: t`Domain removed`, variant: "success", timeout: 3000 });
		},
	});

	const normalizedNewDomain = newDomain.trim().toLowerCase();
	const newDomainProblem =
		takenDomain !== null && normalizedNewDomain === takenDomain
			? msg`This domain is already in the list. Enter a different one.`
			: domainProblem(normalizedNewDomain);
	const newDomainError = addSubmitted && newDomainProblem ? t(newDomainProblem) : undefined;

	const resetAddForm = () => {
		setNewDomain("");
		setAddSubmitted(false);
		setTakenDomain(null);
	};

	const addDomain = useSingleFlight((input: CreateAllowedDomainInput, form: HTMLFormElement) =>
		createMutation.mutateAsync(input, {
			onError: (mutationError) => {
				if (mutationError instanceof ApiResponseError && mutationError.code === "CONFLICT") {
					revealErrors(form, () => {
						setAddSubmitted(true);
						setTakenDomain(input.domain);
					});
					return;
				}
				toastManager.add({
					title: t`Failed to add domain`,
					description:
						mutationError instanceof Error ? mutationError.message : t`An error occurred`,
					variant: "error",
					timeout: 3000,
				});
			},
		}),
	);

	const handleAddDomain = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (createMutation.isPending) return;
		const form = event.currentTarget;
		if (newDomainProblem) {
			revealErrors(form, () => setAddSubmitted(true));
			return;
		}
		addDomain({ domain: normalizedNewDomain, defaultRole: newRole }, form);
	};

	const handleToggleEnabled = (domain: AllowedDomain) => {
		updateMutation.mutate(
			{
				domain: domain.domain,
				data: { enabled: !domain.enabled },
			},
			{
				onError: (mutationError) => {
					toastManager.add({
						title: t`Failed to update domain`,
						description:
							mutationError instanceof Error ? mutationError.message : t`An error occurred`,
						variant: "error",
						timeout: 3000,
					});
				},
			},
		);
	};

	const saveRole = useSingleFlight((domain: string, role: number) =>
		updateMutation.mutateAsync({ domain, data: { defaultRole: role } }),
	);
	const roleChanged = editingDomain !== null && editRole !== editingDomain.defaultRole;

	const handleSaveRole = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!editingDomain || !roleChanged || updateMutation.isPending) return;
		saveRole(editingDomain.domain, editRole);
	};

	const closeEditDialog = (open: boolean) => {
		if (!open && !updateMutation.isPending) setEditingDomain(null);
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
								resetAddForm();
							}}
						>
							{t`Cancel`}
						</Button>
					) : (
						<Button
							onClick={() => {
								resetAddForm();
								setIsAddingDomain(true);
							}}
							icon={<Plus />}
						>
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
											<bdi dir="ltr">{domain.domain}</bdi>
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
											setEditRole(domain.defaultRole);
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
						<form noValidate onSubmit={handleAddDomain} className="grid gap-4">
							<div className="grid items-start gap-4 sm:grid-cols-2">
								<Input
									dir="ltr"
									label={t`Domain`}
									placeholder={t`example.com`}
									value={newDomain}
									onChange={(event) => setNewDomain(event.target.value)}
									required
									error={newDomainError}
									aria-invalid={newDomainError ? true : undefined}
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
							<Button type="submit" disabled={createMutation.isPending}>
								{createMutation.isPending ? t`Adding...` : t`Add Domain`}
							</Button>
						</form>
					</SettingRow>
				)}
			</SettingsSection>

			<LayerDialog.Root
				open={editingDomain !== null}
				{...guardUnsavedInput(roleChanged, closeEditDialog)}
				dismissDisabled={updateMutation.isPending}
			>
				<LayerDialog.Content>
					<LayerDialog.Title>{t`Edit Domain`}</LayerDialog.Title>
					<LayerDialog.Description>
						{t`Update settings for ${editingDomain?.domain}`}
					</LayerDialog.Description>
					<LayerDialog.Body>
						<form id={editFormId} noValidate onSubmit={handleSaveRole} className="grid gap-5">
							<Select
								label={t`Default Role`}
								className="w-full"
								value={String(editRole)}
								onValueChange={(value) => value !== null && setEditRole(Number(value))}
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
						</form>
					</LayerDialog.Body>
					<LayerDialog.Actions dismissLabel={t`Cancel`}>
						<LayerDialog.Action
							type="submit"
							form={editFormId}
							disabled={!roleChanged || updateMutation.isPending}
						>
							{updateMutation.isPending ? t`Saving...` : t`Save`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				</LayerDialog.Content>
			</LayerDialog.Root>

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
