/**
 * Welcome Modal
 *
 * Shown to new users on their first login to welcome them to EmDash.
 */

import { Button, Dialog } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { X } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, throwResponseError } from "../lib/api/client";
import { LogoIcon } from "./Logo.js";

interface WelcomeModalProps {
	open: boolean;
	onClose: () => void;
	userName?: string;
	userRole: number;
}

const MSG_ROLE_ADMINISTRATOR = msg`Administrator`;
const MSG_ROLE_EDITOR = msg`Editor`;
const MSG_ROLE_AUTHOR = msg`Author`;
const MSG_ROLE_CONTRIBUTOR = msg`Contributor`;
const MSG_ROLE_SUBSCRIBER = msg`Subscriber`;

function roleDescriptor(role: number): MessageDescriptor {
	if (role >= 50) return MSG_ROLE_ADMINISTRATOR;
	if (role >= 40) return MSG_ROLE_EDITOR;
	if (role >= 30) return MSG_ROLE_AUTHOR;
	if (role >= 20) return MSG_ROLE_CONTRIBUTOR;
	return MSG_ROLE_SUBSCRIBER;
}

const MSG_ACCOUNT_CREATED = msg`Your account has been created successfully.`;
const MSG_YOUR_ROLE = msg`Your Role`;
const MSG_SCOPE_ADMIN = msg`You have full access to manage this site, including users, settings, and all content.`;
const MSG_SCOPE_EDITOR = msg`You can manage content, media, menus, and taxonomies.`;
const MSG_SCOPE_AUTHOR = msg`You can create and edit your own content.`;
const MSG_SCOPE_CONTRIBUTOR = msg`You can view and contribute to the site.`;

function scopeDescriptor(isAdmin: boolean, userRole: number): MessageDescriptor {
	if (isAdmin) return MSG_SCOPE_ADMIN;
	if (userRole >= 40) return MSG_SCOPE_EDITOR;
	if (userRole >= 30) return MSG_SCOPE_AUTHOR;
	return MSG_SCOPE_CONTRIBUTOR;
}

const MSG_ADMIN_INVITE = msg`As an administrator, you can invite other users from the Users section.`;
const MSG_CLOSE = msg`Close`;

async function dismissWelcome(): Promise<void> {
	const response = await apiFetch("/_emdash/api/auth/me", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "dismissWelcome" }),
	});
	if (!response.ok) await throwResponseError(response, "Failed to dismiss welcome");
}

export function WelcomeModal({ open, onClose, userName, userRole }: WelcomeModalProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();

	const dismissMutation = useMutation({
		mutationFn: dismissWelcome,
		onSuccess: () => {
			// Update the cached user data to reflect that they've seen the welcome
			queryClient.setQueryData(["currentUser"], (old: unknown) => {
				if (old && typeof old === "object") {
					return { ...old, isFirstLogin: false };
				}
				return old;
			});
			onClose();
		},
		onError: () => {
			// Still close on error - don't block the user
			onClose();
		},
	});

	const handleGetStarted = () => {
		dismissMutation.mutate();
	};

	const roleLabel = t(roleDescriptor(userRole));
	const isAdmin = userRole >= 50;

	const firstName = userName?.split(" ")?.[0]?.trim() ?? "";
	const titleDescriptor =
		firstName.length > 0 ? msg`Welcome to EmDash, ${firstName}!` : msg`Welcome to EmDash!`;

	return (
		<Dialog.Root open={open} onOpenChange={(isOpen: boolean) => !isOpen && handleGetStarted()}>
			<Dialog className="p-6 sm:max-w-md">
				<div className="flex items-start justify-between gap-4">
					<div className="flex-1" />
					<Dialog.Close
						aria-label={t(MSG_CLOSE)}
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label={t(MSG_CLOSE)}
								className="absolute right-4 top-4"
							>
								<X className="h-4 w-4" />
								<span className="sr-only">{t(MSG_CLOSE)}</span>
							</Button>
						)}
					/>
				</div>
				<div className="flex flex-col space-y-1.5 text-center sm:text-center">
					<div className="mx-auto mb-4">
						<LogoIcon className="h-16 w-16" />
					</div>
					<Dialog.Title className="text-2xl font-semibold leading-none tracking-tight">
						{t(titleDescriptor)}
					</Dialog.Title>
					<Dialog.Description className="text-base text-kumo-subtle">
						{t(MSG_ACCOUNT_CREATED)}
					</Dialog.Description>
				</div>

				<div className="space-y-4 py-4">
					<div className="rounded-lg bg-kumo-tint p-4">
						<div className="text-sm font-medium">{t(MSG_YOUR_ROLE)}</div>
						<div className="text-lg font-semibold text-kumo-brand">{roleLabel}</div>
						<p className="text-sm text-kumo-subtle mt-1">{t(scopeDescriptor(isAdmin, userRole))}</p>
					</div>

					{isAdmin && <p className="text-sm text-kumo-subtle">{t(MSG_ADMIN_INVITE)}</p>}
				</div>

				<div className="flex flex-col-reverse sm:flex-row sm:justify-center sm:space-x-2">
					<Button onClick={handleGetStarted} disabled={dismissMutation.isPending} size="lg">
						{dismissMutation.isPending ? t`Loading...` : t`Get Started`}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
