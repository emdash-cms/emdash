/**
 * Welcome Modal
 *
 * Shown to new users on their first login to welcome them to EmDash.
 */

import { Button, Dialog } from "@cloudflare/kumo";
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

// Role labels - returns a key, translated in component
function getRoleKey(role: number): string {
	if (role >= 50) return "administrator";
	if (role >= 40) return "editor";
	if (role >= 30) return "author";
	if (role >= 20) return "contributor";
	return "subscriber";
}

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

	const roleKey = getRoleKey(userRole);
	const roleLabelMap: Record<string, string> = {
		administrator: t`Administrator`,
		editor: t`Editor`,
		author: t`Author`,
		contributor: t`Contributor`,
		subscriber: t`Subscriber`,
	};
	const roleLabel = roleLabelMap[roleKey] ?? roleKey;
	const isAdmin = userRole >= 50;

	return (
		<Dialog.Root open={open} onOpenChange={(isOpen: boolean) => !isOpen && handleGetStarted()}>
			<Dialog className="p-6 sm:max-w-md" size="lg">
				<div className="flex items-start justify-between gap-4">
					<div className="flex-1" />
					<Dialog.Close
						aria-label="Close"
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label="Close"
								className="absolute right-4 top-4"
							>
								<X className="h-4 w-4" />
								<span className="sr-only">Close</span>
							</Button>
						)}
					/>
				</div>
				<div className="flex flex-col space-y-1.5 text-center sm:text-center">
					<div className="mx-auto mb-4">
						<LogoIcon className="h-16 w-16" />
					</div>
					<Dialog.Title className="text-2xl font-semibold leading-none tracking-tight">
						{userName ? t`Welcome to EmDash, ${userName.split(" ")[0]}!` : t`Welcome to EmDash!`}
					</Dialog.Title>
					<Dialog.Description className="text-base text-kumo-subtle">
						{t`Your account has been created successfully.`}
					</Dialog.Description>
				</div>

				<div className="space-y-4 py-4">
					<div className="rounded-lg bg-kumo-tint p-4">
						<div className="text-sm font-medium">{t`Your Role`}</div>
						<div className="text-lg font-semibold text-kumo-brand">{roleLabel}</div>
						<p className="text-sm text-kumo-subtle mt-1">
							{isAdmin
								? t`You have full access to manage this site, including users, settings, and all content.`
								: userRole >= 40
									? t`You can manage content, media, menus, and taxonomies.`
									: userRole >= 30
										? t`You can create and edit your own content.`
										: t`You can view and contribute to the site.`}
						</p>
					</div>

					{isAdmin && (
						<p className="text-sm text-kumo-subtle">
							{t`As an administrator, you can invite other users from the Users section.`}
						</p>
					)}
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
