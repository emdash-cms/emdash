import { Banner, Button, Input, Loader, Surface } from "@cloudflare/kumo";
import { type FormEvent, type ReactNode, useState } from "react";

import { beginIdentityAuthorization, UiApiError } from "./api.js";
import { useT } from "./i18n.js";

export function Page({ children }: { children: ReactNode }) {
	const t = useT();
	return (
		<main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-6 sm:p-10">
			<header>
				<div>
					<p className="text-sm text-kumo-subtle">EmDash</p>
					<h1 className="text-2xl font-semibold text-kumo-strong">
						{t("brand.releaseService", "Plugin releases")}
					</h1>
				</div>
			</header>
			{children}
		</main>
	);
}

export function LoadingPanel() {
	const t = useT();
	return (
		<Surface className="flex min-h-48 items-center justify-center rounded-xl border bg-kumo-base p-6">
			<div className="flex items-center gap-3 text-kumo-subtle">
				<Loader />
				<span>{t("loading.label", "Loading release service…")}</span>
			</div>
		</Surface>
	);
}

export function ErrorBanner({ error }: { error: unknown }) {
	const t = useT();
	const description =
		error instanceof UiApiError
			? t("error.withCode", "{message} ({code})", { message: error.message, code: error.code })
			: t("error.generic", "The release service request failed.");
	return (
		<Banner variant="error" title={t("error.title", "Request failed")} description={description} />
	);
}

export function LoginPanel({ realm }: { realm: "approver" | "publisher" }) {
	const t = useT();
	const [identifier, setIdentifier] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [loading, setLoading] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		setLoading(true);
		try {
			const authorizationUrl = await beginIdentityAuthorization(
				realm,
				identifier,
				`${location.pathname}${location.search}`,
			);
			location.assign(authorizationUrl);
		} catch (cause) {
			setError(cause);
			setLoading(false);
		}
	}

	return (
		<Surface className="mx-auto w-full max-w-xl rounded-xl border bg-kumo-base p-6 sm:p-8">
			<form className="flex flex-col gap-5" onSubmit={submit}>
				<div>
					<h2 className="text-xl font-semibold text-kumo-strong">{t("login.title", "Sign in")}</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{t(
							"login.description",
							"Use your Atmosphere account to view and manage your plugin releases.",
						)}
					</p>
				</div>
				{error ? <ErrorBanner error={error} /> : null}
				<Input
					label={t("login.identifier", "Account handle")}
					placeholder={t("login.placeholder", "your-handle.example")}
					value={identifier}
					onChange={(event) => setIdentifier(event.currentTarget.value)}
					required
				/>
				<Button loading={loading} type="submit" variant="primary">
					{t("login.continue", "Sign in with Atmosphere")}
				</Button>
			</form>
		</Surface>
	);
}
