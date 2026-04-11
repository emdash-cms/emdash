/**
 * Welcome Modal
 *
 * Shown to new users on their first login to welcome them to EmDash.
 */

import { Button, Dialog } from "@cloudflare/kumo";
import { t } from "@lingui/core/macro";
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

// Role labels
function getRoleLabel(role: number): string {
	if (role >= 50) return t`Administrator`;
	if (role >= 40) return t`Editor`;
	if (role >= 30) return t`Author`;
	if (role >= 20) return t`Contributor`;
	return t`Subscriber`;
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

	const roleLabel = getRoleLabel(userRole);
	const isAdmin = userRole >= 50;

	return (
		<Dialog.Root open={open} onOpenChange={(isOpen: boolean) => !isOpen && handleGetStarted()}>
			<Dialog className="p-6 sm:max-w-md">
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
						Welcome to EmDash{userName ? `, ${userName.split(" ")[0]}` : ""}!
					</Dialog.Title>
					<Dialog.Description className="text-base text-kumo-subtle">
						Your account has been created successfully.
					</Dialog.Description>
				</div>

				<div className="space-y-4 py-4">
					<div className="rounded-lg bg-kumo-tint p-4">
						<div className="text-sm font-medium">Your Role</div>
						<div className="text-lg font-semibold text-kumo-brand">{roleLabel}</div>
						<p className="text-sm text-kumo-subtle mt-1">
							{isAdmin
								? "You have full access to manage this site, including users, settings, and all content."
								: userRole >= 40
									? "You can manage content, media, menus, and taxonomies."
									: userRole >= 30
										? "You can create and edit your own content."
										: "You can view and contribute to the site."}
						</p>
					</div>

					{isAdmin && (
						<p className="text-sm text-kumo-subtle">
							As an administrator, you can invite other users from the{" "}
							<span className="font-medium">Users</span> section.
						</p>
					)}
				</div>

				<div className="flex flex-col-reverse sm:flex-row sm:justify-center sm:space-x-2">
					<Button onClick={handleGetStarted} disabled={dismissMutation.isPending} size="lg">
						{dismissMutation.isPending ? "Loading..." : "Get Started"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
