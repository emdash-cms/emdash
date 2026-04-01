/**
 * Security Settings page - Passkey management
 *
 * Only available when using passkey auth. When external auth (e.g., Cloudflare Access)
 * is configured, this page shows an informational message instead.
 */

import { Button, Input } from "@cloudflare/kumo";
import { Shield, Plus, CheckCircle, WarningCircle, ArrowLeft, Info } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	beginTwoFactorSetup,
	disableTwoFactorAuth,
	enableTwoFactorAuth,
	fetchManifest,
	fetchPasskeys,
	fetchTwoFactorStatus,
	renamePasskey,
	deletePasskey,
} from "../../lib/api";
import { PasskeyRegistration } from "../auth/PasskeyRegistration";
import { PasskeyList } from "./PasskeyList";

export function SecuritySettings() {
	const queryClient = useQueryClient();
	const [isAdding, setIsAdding] = React.useState(false);
	const [twoFactorCode, setTwoFactorCode] = React.useState("");
	const [twoFactorSetup, setTwoFactorSetup] = React.useState<{
		secret: string;
		otpAuthUrl: string;
	} | null>(null);
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

	const {
		data: twoFactorStatus,
		isLoading: isTwoFactorLoading,
		error: twoFactorError,
	} = useQuery({
		queryKey: ["two-factor", "status"],
		queryFn: fetchTwoFactorStatus,
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
			setSaveStatus({ type: "success", message: "Passkey renamed" });
		},
		onError: (mutationError) => {
			setSaveStatus({
				type: "error",
				message:
					mutationError instanceof Error ? mutationError.message : "Failed to rename passkey",
			});
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: (id: string) => deletePasskey(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
			setSaveStatus({ type: "success", message: "Passkey removed" });
		},
		onError: (mutationError) => {
			setSaveStatus({
				type: "error",
				message:
					mutationError instanceof Error ? mutationError.message : "Failed to remove passkey",
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
		setSaveStatus({ type: "success", message: "Passkey added successfully" });
	};

	const setupTwoFactorMutation = useMutation({
		mutationFn: beginTwoFactorSetup,
		onSuccess: (data) => {
			setTwoFactorSetup(data);
			setTwoFactorCode("");
			setSaveStatus({ type: "success", message: "Two-factor setup initialized" });
			void queryClient.invalidateQueries({ queryKey: ["two-factor", "status"] });
		},
		onError: (mutationError) => {
			setSaveStatus({
				type: "error",
				message:
					mutationError instanceof Error
						? mutationError.message
						: "Failed to initialize two-factor setup",
			});
		},
	});

	const enableTwoFactorMutation = useMutation({
		mutationFn: (code: string) => enableTwoFactorAuth(code),
		onSuccess: () => {
			setTwoFactorSetup(null);
			setTwoFactorCode("");
			setSaveStatus({ type: "success", message: "Two-factor authentication enabled" });
			void queryClient.invalidateQueries({ queryKey: ["two-factor", "status"] });
		},
		onError: (mutationError) => {
			setSaveStatus({
				type: "error",
				message:
					mutationError instanceof Error
						? mutationError.message
						: "Failed to enable two-factor authentication",
			});
		},
	});

	const disableTwoFactorMutation = useMutation({
		mutationFn: (code: string) => disableTwoFactorAuth(code),
		onSuccess: () => {
			setTwoFactorCode("");
			setSaveStatus({ type: "success", message: "Two-factor authentication disabled" });
			void queryClient.invalidateQueries({ queryKey: ["two-factor", "status"] });
		},
		onError: (mutationError) => {
			setSaveStatus({
				type: "error",
				message:
					mutationError instanceof Error
						? mutationError.message
						: "Failed to disable two-factor authentication",
			});
		},
	});

	if (manifestLoading || isLoading || isTwoFactorLoading) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold">Security Settings</h1>
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-subtle">Loading...</p>
				</div>
			</div>
		);
	}

	// Show message when external auth is configured
	if (isExternalAuth) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold">Security Settings</h1>
				<div className="rounded-lg border bg-kumo-base p-6">
					<div className="flex items-start gap-3">
						<Info className="h-5 w-5 text-kumo-subtle mt-0.5 flex-shrink-0" />
						<div className="space-y-2">
							<p className="text-kumo-subtle">
								Authentication is managed by an external provider ({manifest?.authMode}). Passkey
								settings are not available when using external authentication.
							</p>
							<Link to="/settings">
								<Button variant="outline" size="sm" icon={<ArrowLeft />}>
									Back to Settings
								</Button>
							</Link>
						</div>
					</div>
				</div>
			</div>
		);
	}

	if (error || twoFactorError) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold">Security Settings</h1>
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-6">
					<p className="text-kumo-danger">
						{error instanceof Error
							? error.message
							: twoFactorError instanceof Error
								? twoFactorError.message
								: "Failed to load security settings"}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold">Security Settings</h1>

			{/* Status message */}
			{saveStatus && (
				<div
					className={`rounded-lg border p-4 flex items-center gap-2 ${
						saveStatus.type === "success"
							? "bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400"
							: "bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400"
					}`}
				>
					{saveStatus.type === "success" ? (
						<CheckCircle className="h-5 w-5" />
					) : (
						<WarningCircle className="h-5 w-5" />
					)}
					<span>{saveStatus.message}</span>
				</div>
			)}

			{/* Two-factor authentication section */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<Shield className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">Two-factor authentication (2FA)</h2>
				</div>

				{twoFactorStatus?.enabled ? (
					<div className="space-y-4">
						<p className="text-sm text-kumo-subtle">
							2FA is enabled. Use your authenticator app code plus your sign-in method to access
							the admin.
						</p>
						<Input
							label="Authenticator code"
							type="text"
							value={twoFactorCode}
							onChange={(e) => setTwoFactorCode(e.target.value)}
							placeholder="123456"
							autoComplete="one-time-code"
							disabled={disableTwoFactorMutation.isPending}
						/>
						<Button
							variant="outline"
							disabled={!twoFactorCode || disableTwoFactorMutation.isPending}
							loading={disableTwoFactorMutation.isPending}
							onClick={() => disableTwoFactorMutation.mutate(twoFactorCode)}
						>
							Disable 2FA
						</Button>
					</div>
				) : (
					<div className="space-y-4">
						<p className="text-sm text-kumo-subtle">
							Add a second factor with an authenticator app (Google Authenticator, 1Password,
							Authy, etc.).
						</p>

						{twoFactorSetup ? (
							<div className="space-y-4 rounded-lg border border-kumo-tint p-4">
								<p className="text-sm">
									Scan your app with this secret, then enter a generated code to confirm.
								</p>
								<div className="rounded bg-kumo-tint p-3 font-mono text-sm break-all">
									{twoFactorSetup.secret}
								</div>
								<a
									href={twoFactorSetup.otpAuthUrl}
									className="text-sm text-kumo-brand hover:underline"
								>
									Open in authenticator app
								</a>
								<Input
									label="Verification code"
									type="text"
									value={twoFactorCode}
									onChange={(e) => setTwoFactorCode(e.target.value)}
									placeholder="123456"
									autoComplete="one-time-code"
									disabled={enableTwoFactorMutation.isPending}
								/>
								<div className="flex gap-3">
									<Button
										loading={enableTwoFactorMutation.isPending}
										disabled={!twoFactorCode || enableTwoFactorMutation.isPending}
										onClick={() => enableTwoFactorMutation.mutate(twoFactorCode)}
									>
										Enable 2FA
									</Button>
									<Button
										variant="outline"
										onClick={() => {
											setTwoFactorSetup(null);
											setTwoFactorCode("");
										}}
									>
										Cancel
									</Button>
								</div>
							</div>
						) : (
							<Button
								onClick={() => setupTwoFactorMutation.mutate()}
								loading={setupTwoFactorMutation.isPending}
							>
								Set up 2FA
							</Button>
						)}

						{twoFactorStatus?.hasPendingSetup && !twoFactorSetup && (
							<p className="text-xs text-kumo-subtle">
								A previous 2FA setup is pending. Start setup again to get a fresh secret.
							</p>
						)}
					</div>
				)}
			</div>

			{/* Passkeys Section */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<Shield className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">Passkeys</h2>
				</div>

				<p className="text-sm text-kumo-subtle mb-6">
					Passkeys are a secure, passwordless way to sign in to your account. You can register
					multiple passkeys for different devices.
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
						No passkeys registered yet.
					</div>
				)}

				{/* Add passkey section */}
				<div className="mt-6 pt-6 border-t">
					{isAdding ? (
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<h3 className="font-medium">Add a new passkey</h3>
								<Button variant="ghost" size="sm" onClick={() => setIsAdding(false)}>
									Cancel
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
								buttonText="Register Passkey"
							/>
						</div>
					) : (
						<Button onClick={() => setIsAdding(true)} icon={<Plus />}>
							Add Passkey
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

export default SecuritySettings;
