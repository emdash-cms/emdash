import { Button, Input, Select } from "@cloudflare/kumo";
import { Dialog } from "@cloudflare/kumo/primitives";
import { useLingui } from "@lingui/react/macro";
import {
	X,
	Key,
	Prohibit,
	CheckCircle,
	ArrowSquareOut,
	FloppyDisk,
	Envelope,
} from "@phosphor-icons/react";
import * as React from "react";

import type { UserDetail as UserDetailType, UpdateUserInput } from "../../lib/api";
import { useStableCallback } from "../../lib/hooks";
import { cn } from "../../lib/utils";
import { useRolesConfig } from "./useRolesConfig.js";

export interface UserDetailProps {
	user: UserDetailType | null;
	isLoading?: boolean;
	isOpen: boolean;
	isSaving?: boolean;
	isSendingRecovery?: boolean;
	recoverySent?: boolean;
	recoveryError?: string | null;
	currentUserId?: string;
	onClose: () => void;
	onSave: (data: UpdateUserInput) => void;
	onDisable: () => void;
	onEnable: () => void;
	onSendRecovery?: () => void;
}

/**
 * User detail slide-over panel with inline editing
 */
export function UserDetail({
	user,
	isLoading,
	isOpen,
	isSaving,
	isSendingRecovery,
	recoverySent,
	recoveryError,
	currentUserId,
	onClose,
	onSave,
	onDisable,
	onEnable,
	onSendRecovery,
}: UserDetailProps) {
	const { t } = useLingui();
	const { roles, roleLabels, getRoleLabel } = useRolesConfig();
	const [name, setName] = React.useState(user?.name ?? "");
	const [email, setEmail] = React.useState(user?.email ?? "");
	const [role, setRole] = React.useState(user?.role ?? 30);

	// Reset form when viewing a different user
	const userIdRef = React.useRef(user?.id);
	if (user?.id !== userIdRef.current) {
		userIdRef.current = user?.id;
		if (user) {
			setName(user.name ?? "");
			setEmail(user.email ?? "");
			setRole(user.role);
		}
	}

	const stableOnClose = useStableCallback(onClose);

	const isSelf = user && currentUserId && user.id === currentUserId;

	const isDirty =
		user && (name !== (user.name ?? "") || email !== user.email || role !== user.role);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!user) return;

		const data: UpdateUserInput = {};

		if (name !== (user.name ?? "")) {
			data.name = name || undefined;
		}
		if (email !== user.email) {
			data.email = email;
		}
		if (role !== user.role && !isSelf) {
			data.role = role;
		}

		onSave(data);
	};

	return (
		<Dialog.Root open={isOpen} onOpenChange={(open) => !open && stableOnClose()}>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={cn(
						"fixed inset-0 z-40 bg-black/50 transition-opacity duration-200",
						"data-starting-style:opacity-0 data-ending-style:opacity-0",
					)}
				/>
				<Dialog.Popup
					className={cn(
						"fixed top-0 end-0 z-50 flex h-full w-full max-w-md flex-col bg-kumo-base shadow-xl outline-none",
						"transform transition-transform duration-200 ease-out",
						"data-starting-style:ltr:translate-x-full data-starting-style:rtl:-translate-x-full",
						"data-ending-style:ltr:translate-x-full data-ending-style:rtl:-translate-x-full",
					)}
				>
					{/* Header */}
					<div className="flex items-center justify-between border-b px-6 py-4">
						<Dialog.Title className="text-lg font-semibold">{t`User Details`}</Dialog.Title>
						<Button
							variant="ghost"
							shape="square"
							onClick={stableOnClose}
							aria-label={t`Close panel`}
						>
							<X className="h-5 w-5" aria-hidden="true" />
						</Button>
					</div>

					{/* Content */}
					<div className="flex-1 overflow-y-auto p-6">
						{isLoading ? (
							<UserDetailSkeleton />
						) : user ? (
							<form id="user-edit-form" onSubmit={handleSubmit} className="space-y-6">
								{/* Avatar + editable fields */}
								<div className="flex items-start gap-4">
									{user.avatarUrl ? (
										<img
											src={user.avatarUrl}
											alt=""
											className="h-16 w-16 shrink-0 rounded-full object-cover"
										/>
									) : (
										<div className="h-16 w-16 shrink-0 rounded-full bg-kumo-tint flex items-center justify-center text-2xl font-medium">
											{(name || email)?.[0]?.toUpperCase() ?? "?"}
										</div>
									)}
									<div className="flex-1 min-w-0 space-y-3">
										<Input
											label={t`Name`}
											value={name}
											onChange={(e) => setName(e.target.value)}
											placeholder={t`Enter name`}
										/>
										<Input
											label={t`Email`}
											type="email"
											value={email}
											onChange={(e) => setEmail(e.target.value)}
											placeholder={t`Enter email`}
											required
										/>
									</div>
								</div>

								{/* Role + status */}
								<div className="flex items-end gap-3">
									{isSelf ? (
										<div className="flex-1">
											<Input
												label={t`Role`}
												value={getRoleLabel(role)}
												disabled
												className="cursor-not-allowed"
											/>
											<p className="text-xs text-kumo-subtle mt-1">
												{t`You cannot change your own role`}
											</p>
										</div>
									) : (
										<div className="flex-1">
											<Select
												label={t`Role`}
												value={role.toString()}
												onValueChange={(v) => v !== null && setRole(parseInt(v, 10))}
												items={roleLabels}
											>
												{roles.map((r) => (
													<Select.Option key={r.value} value={r.value.toString()}>
														<div>
															<div>{r.label}</div>
															<div className="text-xs text-kumo-subtle">{r.description}</div>
														</div>
													</Select.Option>
												))}
											</Select>
										</div>
									)}
									<div className="pb-1">
										{user.disabled ? (
											<span className="inline-flex items-center gap-1 text-sm text-kumo-danger">
												<Prohibit className="h-3.5 w-3.5" aria-hidden="true" />
												{t`Disabled`}
											</span>
										) : (
											<span className="inline-flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
												<CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />
												{t`Active`}
											</span>
										)}
									</div>
								</div>

								{/* Info cards */}
								<div className="grid gap-4">
									{/* Timestamps */}
									<div className="rounded-lg border p-4">
										<h4 className="text-sm font-medium text-kumo-subtle mb-3">{t`Account Info`}</h4>
										<div className="space-y-2 text-sm">
											<div className="flex justify-between">
												<span className="text-kumo-subtle">{t`Created`}</span>
												<span>{new Date(user.createdAt).toLocaleDateString()}</span>
											</div>
											<div className="flex justify-between">
												<span className="text-kumo-subtle">{t`Last updated`}</span>
												<span>{new Date(user.updatedAt).toLocaleDateString()}</span>
											</div>
											<div className="flex justify-between">
												<span className="text-kumo-subtle">{t`Last login`}</span>
												<span>
													{user.lastLogin
														? new Date(user.lastLogin).toLocaleDateString()
														: t`Never`}
												</span>
											</div>
											<div className="flex justify-between">
												<span className="text-kumo-subtle">{t`Email verified`}</span>
												<span>{user.emailVerified ? t`Yes` : t`No`}</span>
											</div>
										</div>
									</div>

									{/* Passkeys */}
									<div className="rounded-lg border p-4">
										<h4 className="text-sm font-medium text-kumo-subtle mb-3 flex items-center gap-2">
											<Key className="h-4 w-4" aria-hidden="true" />
											{t`Passkeys (${user.credentials.length})`}
										</h4>
										{user.credentials.length === 0 ? (
											<p className="text-sm text-kumo-subtle">{t`No passkeys registered`}</p>
										) : (
											<div className="space-y-2">
												{user.credentials.map((cred) => (
													<div key={cred.id} className="flex justify-between text-sm">
														<div>
															<div>{cred.name || t`Unnamed passkey`}</div>
															<div className="text-xs text-kumo-subtle">
																{cred.deviceType === "multiDevice" ? t`Synced` : t`Device-bound`}
															</div>
														</div>
														<div className="text-end text-kumo-subtle">
															<div>{t`Created ${new Date(cred.createdAt).toLocaleDateString()}`}</div>
															<div className="text-xs">
																{t`Last used ${new Date(cred.lastUsedAt).toLocaleDateString()}`}
															</div>
														</div>
													</div>
												))}
											</div>
										)}
									</div>

									{/* OAuth accounts */}
									{user.oauthAccounts.length > 0 && (
										<div className="rounded-lg border p-4">
											<h4 className="text-sm font-medium text-kumo-subtle mb-3 flex items-center gap-2">
												<ArrowSquareOut className="h-4 w-4" aria-hidden="true" />
												{t`Linked Accounts (${user.oauthAccounts.length})`}
											</h4>
											<div className="space-y-2">
												{user.oauthAccounts.map((account, i) => (
													<div
														key={`${account.provider}-${i}`}
														className="flex justify-between text-sm"
													>
														<span className="capitalize">{account.provider}</span>
														<span className="text-kumo-subtle">
															{t`Connected ${new Date(account.createdAt).toLocaleDateString()}`}
														</span>
													</div>
												))}
											</div>
										</div>
									)}
								</div>
							</form>
						) : (
							<div className="text-center text-kumo-subtle py-8">{t`User not found`}</div>
						)}
					</div>

					{/* Footer actions */}
					{user && (
						<div className="border-t px-6 py-4 space-y-2">
							<div className="flex gap-2">
								<Button
									type="submit"
									form="user-edit-form"
									className="flex-1"
									disabled={!isDirty || isSaving}
									icon={<FloppyDisk />}
								>
									{isSaving ? t`Saving...` : t`Save Changes`}
								</Button>
								{!isSelf && (
									<Button
										variant={user.disabled ? "outline" : "destructive"}
										onClick={user.disabled ? onEnable : onDisable}
										icon={user.disabled ? <CheckCircle /> : <Prohibit />}
									>
										{user.disabled ? t`Enable` : t`Disable`}
									</Button>
								)}
							</div>
							{!isSelf && onSendRecovery && (
								<div className="space-y-1">
									<Button
										variant="outline"
										className="w-full"
										onClick={onSendRecovery}
										disabled={isSendingRecovery}
										icon={<Envelope />}
									>
										{isSendingRecovery ? t`Sending...` : t`Send Recovery Link`}
									</Button>
									{recoverySent && (
										<p className="text-xs text-green-600 dark:text-green-400 text-center">
											{t`Recovery link sent to ${user.email}`}
										</p>
									)}
									{recoveryError && (
										<p className="text-xs text-kumo-danger text-center">{recoveryError}</p>
									)}
								</div>
							)}
						</div>
					)}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** Loading skeleton for user detail */
function UserDetailSkeleton() {
	return (
		<div className="space-y-6 animate-pulse">
			{/* Profile skeleton */}
			<div className="flex items-start gap-4">
				<div className="h-16 w-16 rounded-full bg-kumo-tint" />
				<div className="flex-1 space-y-2">
					<div className="h-6 w-48 bg-kumo-tint rounded" />
					<div className="h-4 w-36 bg-kumo-tint rounded" />
					<div className="h-5 w-24 bg-kumo-tint rounded" />
				</div>
			</div>

			{/* Cards skeleton */}
			{Array.from({ length: 2 }, (_, i) => (
				<div key={i} className="rounded-lg border p-4 space-y-3">
					<div className="h-4 w-24 bg-kumo-tint rounded" />
					<div className="space-y-2">
						<div className="h-4 w-full bg-kumo-tint rounded" />
						<div className="h-4 w-full bg-kumo-tint rounded" />
						<div className="h-4 w-3/4 bg-kumo-tint rounded" />
					</div>
				</div>
			))}
		</div>
	);
}
