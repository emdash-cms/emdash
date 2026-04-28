/**
 * Security Settings page - Passkey management
 *
 * Only available when using passkey auth. When external auth (e.g., Cloudflare Access)
 * is configured, this page shows an informational message instead.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Shield, Plus, CheckCircle, WarningCircle, Info } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { fetchPasskeys, renamePasskey, deletePasskey, fetchManifest } from "../../lib/api";
import { ArrowPrev } from "../ArrowIcons.js";
import { PasskeyRegistration } from "../auth/PasskeyRegistration";
import { PasskeyList } from "./PasskeyList";

export function SecuritySettings() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [isAdding, setIsAdding] = React.useState(false);
	const [saveStatus, setSaveStatus] = React.useState<{
		type: "success" | "error";
		message: string;
	} | null>(null);

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

	// Clear status message after 3 seconds
	React.useEffect(() => {
		if (saveStatus) {
			const timer = setTimeout(setSaveStatus, 3000, null);
			return () => clearTimeout(timer);
		}
	}, [saveStatus]);

	// Rename mutation
	const renameMutation = useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) => renamePasskey(id, name),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
			setSaveStatus({ type: "success", message: t`Passkey renamed` });
		},
		onError: (mutationError) => {
			setSaveStatus({
				type: "error",
				message:
					mutationError instanceof Error ? mutationError.message : t`Failed to rename passkey`,
			});
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: (id: string) => deletePasskey(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
			setSaveStatus({ type: "success", message: t`Passkey removed` });
		},
		onError: (mutationError) => {
			setSaveStatus({
				type: "error",
				message:
					mutationError instanceof Error ? mutationError.message : t`Failed to remove passkey`,
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
		setSaveStatus({ type: "success", message: t`Passkey added successfully` });
	};

	const settingsHeader = (
		<div className="flex items-center gap-3">
			<Link to="/settings">
				<Button variant="ghost" shape="square" aria-label={t`Back to settings`}>
					<ArrowPrev className="h-4 w-4" />
				</Button>
			</Link>
			<h1 className="text-2xl font-bold">{t`Security Settings`}</h1>
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
								{t`Authentication is managed by an external provider (${manifest?.authMode}). Passkey settings are not available when using external authentication.`}
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
						{error instanceof Error ? error.message : t`Failed to load passkeys`}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{settingsHeader}

			{/* Status message */}
			{saveStatus && (
				<div
					className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
						saveStatus.type === "success"
							? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200"
							: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
					}`}
				>
					{saveStatus.type === "success" ? (
						<CheckCircle className="h-4 w-4 flex-shrink-0" />
					) : (
						<WarningCircle className="h-4 w-4 flex-shrink-0" />
					)}
					{saveStatus.message}
				</div>
			)}

			{/* Passkeys Section */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<Shield className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">{t`Passkeys`}</h2>
				</div>

				<p className="text-sm text-kumo-subtle mb-6">
					{t`Passkeys are a secure, passwordless way to sign in to your account. You can register multiple passkeys for different devices.`}
				</p>

				{/* Passkey list */}
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

				{/* Add passkey section */}
				<div className="mt-6 pt-6 border-t">
					{isAdding ? (
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<h3 className="font-medium">{t`Add a new passkey`}</h3>
								<Button variant="ghost" size="sm" onClick={() => setIsAdding(false)}>
									{t`Cancel`}
								</Button>
							</div>
							<PasskeyRegistration
								optionsEndpoint="/_emdash/api/auth/passkey/register/options"
								verifyEndpoint="/_emdash/api/auth/passkey/register/verify"
								onSuccess={handleAddSuccess}
								onError={(registrationError) =>
									setSaveStatus({
										type: "error",
										message: registrationError.message,
									})
								}
								showNameInput
								buttonText={t`Register Passkey`}
							/>
						</div>
					) : (
						<Button onClick={() => setIsAdding(true)} icon={<Plus />}>
							{t`Add Passkey`}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

export default SecuritySettings;
