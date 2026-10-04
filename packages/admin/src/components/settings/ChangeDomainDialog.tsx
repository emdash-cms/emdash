import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { changeSiteDomain, updateSettings } from "../../lib/api";
import { DialogError, getMutationError } from "../DialogError.js";

export interface ChangeDomainDialogProps {
	open: boolean;
	currentUrl?: string;
	configuredUrl?: string;
	onClose: () => void;
	onChanged: (url: string, checked: boolean) => void;
}

const TRAILING_SLASHES = /\/+$/;

/** Turn what the user typed into a URL to store without the domain check. */
export function uncheckedSiteUrl(input: string): string | undefined {
	const trimmed = input.trim();
	const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
	if (!trimmed || !URL.canParse(candidate)) return undefined;
	const url = new URL(candidate);
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	if (url.username || url.password) return undefined;
	return `${url.origin}${url.pathname.replace(TRAILING_SLASHES, "")}`;
}

export function ChangeDomainDialog({
	open,
	currentUrl,
	configuredUrl,
	onClose,
	onChanged,
}: ChangeDomainDialogProps) {
	const { t } = useLingui();
	const [domain, setDomain] = React.useState("");

	const checkMutation = useMutation({
		mutationFn: (value: string) => changeSiteDomain(value),
		onSuccess: ({ url }) => onChanged(url, true),
	});
	const uncheckedMutation = useMutation({
		mutationFn: async (url: string) => {
			await updateSettings({ url });
			return url;
		},
		onSuccess: (url) => onChanged(url, false),
	});

	React.useEffect(() => {
		if (!open) return;
		setDomain("");
		checkMutation.reset();
		uncheckedMutation.reset();
	}, [open]);

	const isPending = checkMutation.isPending || uncheckedMutation.isPending;
	const fallbackUrl = checkMutation.isError ? uncheckedSiteUrl(domain) : undefined;

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		if (isPending || !domain.trim()) return;
		uncheckedMutation.reset();
		checkMutation.mutate(domain.trim());
	};

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !isPending) onClose();
			}}
			disablePointerDismissal={isPending}
		>
			<Dialog className="max-h-[85vh] overflow-y-auto p-6" size="lg">
				<form onSubmit={submit} noValidate>
					<Dialog.Title className="text-lg font-semibold">{t`Change domain`}</Dialog.Title>
					<Dialog.Description className="mt-2 text-sm text-kumo-subtle">
						{currentUrl && <>{t`Your site is currently at ${currentUrl}.`} </>}
						{configuredUrl
							? t`Sitemaps and absolute URLs in search and social metadata will use the new domain. Links in emails and plugins keep using ${configuredUrl}, set by the deployment configuration.`
							: t`Links in emails and plugins, sitemaps, and absolute URLs in search and social metadata will use the new domain.`}
					</Dialog.Description>

					<ol className="mt-4 grid list-decimal gap-2 ps-5 text-sm">
						<li>
							{t`Point the domain at this site. On Cloudflare, open your Worker in Workers & Pages, go to the Domains tab, and add the domain.`}
						</li>
						<li>{t`Enter the domain below. EmDash checks that it serves this site before switching.`}</li>
					</ol>

					<div className="mt-5">
						<Input
							label={t`New domain`}
							placeholder={t`example.com`}
							value={domain}
							onChange={(event) => {
								setDomain(event.target.value);
								checkMutation.reset();
								uncheckedMutation.reset();
							}}
							autoFocus
							disabled={isPending}
							dir="ltr"
							autoComplete="off"
							spellCheck={false}
						/>
					</div>

					<p className="mt-4 text-sm text-kumo-subtle">
						{t`Passkeys only work at the address where they were created. After switching, keep signing in at the current address, or use an email sign-in link at the new one.`}
					</p>

					<DialogError
						message={getMutationError(checkMutation.error ?? uncheckedMutation.error)}
						className="mt-4"
					/>
					{fallbackUrl && (
						<div className="mt-3 grid gap-2 rounded-md border border-kumo-line p-3 text-sm">
							<p>
								{t`If the site can't be reached from the internet yet, for example on localhost or behind a login, you can use the address without the check.`}
							</p>
							<div>
								<Button
									type="button"
									variant="secondary"
									size="sm"
									disabled={isPending}
									onClick={() => uncheckedMutation.mutate(fallbackUrl)}
								>
									{t`Use ${fallbackUrl} anyway`}
								</Button>
							</div>
						</div>
					)}

					<div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
						<Button
							variant="secondary"
							type="button"
							onClick={onClose}
							disabled={isPending}
							className="w-full sm:w-auto"
						>
							{t`Cancel`}
						</Button>
						<Button
							type="submit"
							variant="primary"
							disabled={isPending || !domain.trim()}
							className="w-full sm:w-auto"
						>
							{checkMutation.isPending ? t`Checking…` : t`Check and switch`}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
