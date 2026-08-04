/**
 * Security Settings page - Passkey management
 *
 * Only available when using passkey auth. When external auth (e.g., Cloudflare Access)
 * is configured, this page shows an informational message instead.
 */

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus, Info } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { fetchPasskeys, renamePasskey, deletePasskey, fetchManifest } from "../../lib/api";
import { PasskeyRegistration } from "../auth/PasskeyRegistration";
import { getMutationError } from "../DialogError.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";
import { PasskeyList } from "./PasskeyList";
import {
	SettingsErrorState,
	SettingsFrame,
	SettingsLoadingState,
	SettingsSection,
} from "./SettingsLayout.js";

export function SecuritySettings() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [isAdding, setIsAdding] = React.useState(false);

	// Fetch manifest for auth mode
	const { data: manifest, isLoading: manifestLoading } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const isExternalAuth = manifest?.authMode && manifest.authMode !== "passkey";

	// Fetch passkeys (only when using passkey auth)
	const {
		data: passkeys,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["passkeys"],
		queryFn: fetchPasskeys,
		enabled: !isExternalAuth && !manifestLoading,
	});

	// Rename mutation
	const renameMutation = useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) => renamePasskey(id, name),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
			toastManager.add({ title: t`Passkey renamed`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: t`Failed to rename passkey`,
				description: getMutationError(mutationError) ?? t`An error occurred`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: (id: string) => deletePasskey(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
			toastManager.add({ title: t`Passkey removed`, variant: "success", timeout: 3000 });
		},
		onError: (mutationError) => {
			toastManager.add({
				title: t`Failed to remove passkey`,
				description: getMutationError(mutationError) ?? t`An error occurred`,
				variant: "error",
				timeout: 3000,
			});
		},
	});

	const handleRename = async (id: string, name: string) => {
		await renameMutation.mutateAsync({ id, name });
	};

	const handleDelete = async (id: string) => {
		await deleteMutation.mutateAsync(id);
	};

	const handleAddSuccess = () => {
		void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
		setIsAdding(false);
		toastManager.add({ title: t`Passkey added successfully`, variant: "success", timeout: 3000 });
	};

	if (manifestLoading || isLoading) {
		return (
			<SettingsFrame title={t`Security Settings`} leading={<BackToSettingsLink />}>
				<SettingsLoadingState label={t`Loading...`} />
			</SettingsFrame>
		);
	}

	// Show message when external auth is configured
	if (isExternalAuth) {
		return (
			<SettingsFrame title={t`Security Settings`} leading={<BackToSettingsLink />}>
				<SettingsSection title={t`Authentication provider`}>
					<div className="flex items-start gap-3">
						<Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-kumo-subtle" aria-hidden="true" />
						<div className="space-y-2">
							<p className="text-kumo-subtle">
								{t`Authentication is managed by an external provider (${manifest?.authMode}). Passkey settings are not available when using external authentication.`}
							</p>
						</div>
					</div>
				</SettingsSection>
			</SettingsFrame>
		);
	}

	if (error) {
		return (
			<SettingsFrame title={t`Security Settings`} leading={<BackToSettingsLink />}>
				<SettingsErrorState message={getMutationError(error) ?? t`Failed to load passkeys`} />
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame title={t`Security Settings`} leading={<BackToSettingsLink />}>
			<SettingsSection
				title={t`Passkeys`}
				description={t`Passkeys are a secure, passwordless way to sign in to your account. You can register multiple passkeys for different devices.`}
			>
				{passkeys && passkeys.length > 0 ? (
					<PasskeyList
						passkeys={passkeys}
						onRename={handleRename}
						onDelete={handleDelete}
						isDeleting={deleteMutation.isPending}
						isRenaming={renameMutation.isPending}
					/>
				) : (
					<div className="rounded-lg border border-dashed p-6 text-center text-kumo-subtle">
						{t`No passkeys registered yet.`}
					</div>
				)}
			</SettingsSection>

			<SettingsSection
				title={t`Register a passkey`}
				description={t`Add another secure sign-in method for this account.`}
			>
				{isAdding ? (
					<div className="space-y-4">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<p className="font-medium">{t`Add a new passkey`}</p>
							<Button type="button" variant="ghost" size="sm" onClick={() => setIsAdding(false)}>
								{t`Cancel`}
							</Button>
						</div>
						<PasskeyRegistration
							optionsEndpoint="/_emdash/api/auth/passkey/register/options"
							verifyEndpoint="/_emdash/api/auth/passkey/register/verify"
							onSuccess={handleAddSuccess}
							onError={(registrationError) =>
								toastManager.add({
									title: t`Failed to add passkey`,
									description: registrationError.message,
									variant: "error",
									timeout: 3000,
								})
							}
							showNameInput
							buttonText={t`Register Passkey`}
						/>
					</div>
				) : (
					<Button type="button" onClick={() => setIsAdding(true)} icon={<Plus />}>
						{t`Add Passkey`}
					</Button>
				)}
			</SettingsSection>
		</SettingsFrame>
	);
}

export default SecuritySettings;
