/**
 * Welcome Modal
 *
 * Shown to new users on their first login to welcome them to EmDash.
 */

import { Badge, Button, Dialog } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { UserCircleIcon, X } from "@phosphor-icons/react";
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

function roleBadgeVariant(role: number): React.ComponentProps<typeof Badge>["variant"] {
	if (role >= 50) return "primary";
	if (role >= 30) return "secondary";
	return "outline";
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

async function dismissWelcome(fallbackMessage: string): Promise<void> {
	const response = await apiFetch("/_emdash/api/auth/me", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "dismissWelcome" }),
	});
	if (!response.ok) await throwResponseError(response, fallbackMessage);
}

export function WelcomeModal({ open, onClose, userName, userRole }: WelcomeModalProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();

	const dismissMutation = useMutation({
		mutationFn: () => dismissWelcome(t`Failed to dismiss welcome`),
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
				<div className="mb-5 flex items-center justify-between gap-4">
					<LogoIcon className="h-8 w-8" />
					<Dialog.Close
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								size="sm"
								icon={<X />}
								aria-label={t(MSG_CLOSE)}
							/>
						)}
					/>
				</div>

				<Dialog.Title className="text-start text-xl font-semibold leading-tight">
					{t(titleDescriptor)}
				</Dialog.Title>
				<Dialog.Description className="mt-1 text-start text-sm leading-5 text-pretty text-kumo-subtle">
					{t(MSG_ACCOUNT_CREATED)}
				</Dialog.Description>

				<div className="mt-5 space-y-3 border-t border-kumo-line pt-5 text-start">
					<div className="flex items-center gap-2">
						<span className="text-sm text-kumo-subtle">{t(MSG_YOUR_ROLE)}</span>
						<Badge variant={roleBadgeVariant(userRole)} className="gap-1">
							<UserCircleIcon weight="fill" aria-hidden="true" />
							{roleLabel}
						</Badge>
					</div>
					<p className="text-sm leading-5 text-pretty text-kumo-default">
						{t(scopeDescriptor(isAdmin, userRole))}
					</p>
					{isAdmin && (
						<p className="text-sm leading-5 text-pretty text-kumo-subtle">{t(MSG_ADMIN_INVITE)}</p>
					)}
				</div>

				<div className="mt-5 border-t border-kumo-line pt-5">
					<Button
						variant="primary"
						size="lg"
						className="w-full justify-center"
						onClick={handleGetStarted}
						loading={dismissMutation.isPending}
					>
						{t`Get Started`}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
