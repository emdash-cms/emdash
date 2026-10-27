import { Banner, Button, Code, Input, Link, Loader } from "@cloudflare/kumo";
import * as React from "react";

import { call, type Connection, errorMessage } from "./admin-api.js";
import { Row, RowText, Section } from "./admin-ui.js";
import { ENV } from "./env.js";

const ACCOUNT_ID_URL =
	"https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/";
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/** The account's API tokens page, or the dashboard's account picker for it. */
function accountTokensUrl(accountId: string): string {
	return ACCOUNT_ID.test(accountId)
		? `https://dash.cloudflare.com/${accountId}/api-tokens`
		: "https://dash.cloudflare.com/?to=/:account/api-tokens";
}

const BINDING_SNIPPET = `// wrangler.jsonc
{
  "ai_search_namespaces": [
    { "binding": "AI_SEARCH", "namespace": "default" }
  ]
}`;

function useConnection() {
	const [connection, setConnection] = React.useState<Connection | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	React.useEffect(() => {
		call<Connection>("connection").then(setConnection, (loadError: unknown) =>
			setError(errorMessage(loadError)),
		);
	}, []);
	return { connection, setConnection, error };
}

/** Shown until the plugin can reach AI Search. */
export function ConnectPanel(props: { rejected: boolean; onConnected: () => Promise<void> }) {
	const { connection, setConnection, error } = useConnection();
	if (error) return <Banner variant="error" description={error} />;
	if (!connection) return <Loader />;

	return (
		<div className="space-y-5">
			{props.rejected ? (
				<Banner
					variant="error"
					title="Cloudflare rejected the API token"
					description={`The token may have expired, been revoked, or lost its AI Search permissions. ${
						connection.apiToken.source === "env"
							? `Set a new token in ${ENV.apiToken} to reconnect.`
							: "Enter a new one to reconnect."
					}`}
				/>
			) : (
				<Banner
					variant="alert"
					title="AI Search is not connected"
					description="Connect with a Cloudflare API token. On Cloudflare Workers, you can add an AI Search binding instead."
				/>
			)}
			<Section
				title="Connect with an API token"
				description="Works on any platform, including Node.js."
			>
				<div className="p-4">
					<CredentialsForm
						connection={connection}
						onSaved={async (next) => {
							setConnection(next);
							await props.onConnected();
						}}
					/>
				</div>
			</Section>
			<Section
				title="Or use a Workers binding"
				description="Add the binding to your Wrangler configuration and deploy again. A binding takes precedence over a token."
			>
				<div className="p-4">
					<Code lang="jsonc" code={BINDING_SNIPPET} />
				</div>
			</Section>
		</div>
	);
}

/**
 * The REST credentials stored in settings. This card checks them with
 * Cloudflare before saving; the plugin manager's generated settings form,
 * which core shows for any declared settings, saves them unchecked.
 * Renders nothing for a binding or for credentials the environment sets.
 */
export function ConnectionCard(props: { onChanged: () => void }) {
	const { connection, setConnection } = useConnection();
	const [editing, setEditing] = React.useState(false);

	const stored =
		connection?.accountId.source === "settings" || connection?.apiToken.source === "settings";
	if (!connection || !stored) return null;

	return (
		<Section title="Connection">
			<Row>
				<div className="min-w-0 flex-1">
					<RowText title="Cloudflare API token" description="Saved in settings." />
				</div>
				{!editing && (
					<Button variant="outline" size="sm" onClick={() => setEditing(true)}>
						Change
					</Button>
				)}
			</Row>
			{editing && (
				<div className="p-4">
					<CredentialsForm
						connection={connection}
						onSaved={(next) => {
							setConnection(next);
							setEditing(false);
							// Saving can start a build, when the new account has no instance yet.
							props.onChanged();
						}}
						onCancel={() => setEditing(false)}
					/>
				</div>
			)}
		</Section>
	);
}

function CredentialsForm(props: {
	connection: Connection;
	onSaved: (next: Connection) => void | Promise<void>;
	onCancel?: () => void;
}) {
	const { connection } = props;
	const [accountId, setAccountId] = React.useState(connection.accountId.value ?? "");
	const [apiToken, setApiToken] = React.useState("");
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	const accountFromEnv = connection.accountId.source === "env";
	const tokenFromEnv = connection.apiToken.source === "env";
	const tokenStored = connection.apiToken.source === "settings";
	const accountChanged = !accountFromEnv && accountId.trim() !== (connection.accountId.value ?? "");
	const tokenTyped = !tokenFromEnv && apiToken.trim() !== "";
	const missing =
		(!accountFromEnv && accountId.trim() === "") || (!tokenFromEnv && !tokenStored && !tokenTyped);

	const save = async (input: { accountId?: string; apiToken?: string }) => {
		setSaving(true);
		setError(null);
		try {
			const next = await call<Connection>("connection/save", input);
			setApiToken("");
			await props.onSaved(next);
		} catch (saveError) {
			setError(errorMessage(saveError));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				void save({
					...(accountChanged ? { accountId: accountId.trim() } : {}),
					...(tokenTyped ? { apiToken: apiToken.trim() } : {}),
				});
			}}
		>
			{error && <Banner variant="error" description={error} />}
			{accountFromEnv ? (
				<EnvValue label="Account ID" name={ENV.accountId} />
			) : (
				<Input
					label="Account ID"
					description={<ExternalLink href={ACCOUNT_ID_URL}>Find your account ID</ExternalLink>}
					value={accountId}
					dir="ltr"
					autoComplete="off"
					onChange={(event) => setAccountId(event.target.value)}
				/>
			)}
			{tokenFromEnv ? (
				<EnvValue label="API token" name={ENV.apiToken} />
			) : (
				<Input
					label="API token"
					type="password"
					dir="ltr"
					autoComplete="off"
					placeholder={tokenStored ? "Stored. Enter a new token to replace it." : undefined}
					description={
						<>
							<ExternalLink href={accountTokensUrl(accountId.trim())}>
								Create an account API token
							</ExternalLink>{" "}
							with the AI Search Edit and AI Search Run permissions. It is stored encrypted.
						</>
					}
					value={apiToken}
					onChange={(event) => setApiToken(event.target.value)}
				/>
			)}
			{!(accountFromEnv && tokenFromEnv) && (
				<div className="flex flex-wrap gap-2">
					<Button
						type="submit"
						variant="primary"
						loading={saving}
						disabled={missing || (!accountChanged && !tokenTyped)}
					>
						Connect
					</Button>
					{props.onCancel && (
						<Button type="button" variant="ghost" disabled={saving} onClick={props.onCancel}>
							Cancel
						</Button>
					)}
				</div>
			)}
		</form>
	);
}

/** A credential the environment sets. Its value never reaches the browser. */
function EnvValue(props: { label: string; name: string }) {
	return (
		<div className="space-y-1">
			<p className="text-sm font-medium">{props.label}</p>
			<p className="text-sm text-kumo-subtle">
				Set by the <code dir="ltr">{props.name}</code> environment variable.
			</p>
		</div>
	);
}

function ExternalLink(props: { href: string; children: React.ReactNode }) {
	return (
		<Link variant="inline" href={props.href} target="_blank" rel="noopener noreferrer">
			{props.children}
			<Link.ExternalIcon />
		</Link>
	);
}
