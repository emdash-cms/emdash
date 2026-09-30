/**
 * Cloudflare Turnstile widget for the public auth forms.
 *
 * Loads Cloudflare's script once and renders the widget explicitly. Tokens
 * are single-use: remount the widget (change its `key`) after each submit.
 */

import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useLocale } from "../../locales/useLocale.js";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Language codes the Turnstile widget accepts, besides `auto`. */
const TURNSTILE_LANGUAGES = new Set(
	"ar bg zh zh-cn zh-tw hr cs da nl en fa fi fr de el he hi hu id it ja ko lt ms nb pl pt pt-br ro ru sr sk sl es sv tl th tr uk vi".split(
		" ",
	),
);

export function toTurnstileLanguage(locale: string): string {
	const code = locale.toLowerCase();
	if (TURNSTILE_LANGUAGES.has(code)) return code;
	const base = code.split("-")[0] ?? "";
	return TURNSTILE_LANGUAGES.has(base) ? base : "auto";
}

interface TurnstileApi {
	render: (
		container: HTMLElement,
		options: {
			sitekey: string;
			language: string;
			callback: (token: string) => void;
			"expired-callback": () => void;
			"error-callback": () => void;
		},
	) => string;
	remove: (widgetId: string) => void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT_URL;
		script.async = true;
		const fail = (message: string) => {
			scriptPromise = null;
			script.remove();
			reject(new Error(message));
		};
		script.onload = () => {
			if (window.turnstile) resolve(window.turnstile);
			else fail("Turnstile unavailable");
		};
		script.onerror = () => fail("Turnstile failed to load");
		document.head.append(script);
	});
	return scriptPromise;
}

export interface TurnstileWidgetProps {
	siteKey: string;
	/** Called with a fresh token, or `null` when the token expires or fails. */
	onToken: (token: string | null) => void;
}

export function TurnstileWidget({ siteKey, onToken }: TurnstileWidgetProps) {
	const { t } = useLingui();
	const { locale } = useLocale();
	const language = toTurnstileLanguage(locale);
	const [loadFailed, setLoadFailed] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const onTokenRef = React.useRef(onToken);
	onTokenRef.current = onToken;

	React.useEffect(() => {
		let widgetId: string | undefined;
		let cancelled = false;

		void (async () => {
			try {
				const turnstile = await loadTurnstile();
				if (cancelled || !containerRef.current) return;
				widgetId = turnstile.render(containerRef.current, {
					sitekey: siteKey,
					language,
					callback: (token) => onTokenRef.current(token),
					"expired-callback": () => onTokenRef.current(null),
					"error-callback": () => onTokenRef.current(null),
				});
			} catch (error) {
				console.error("[turnstile]", error);
				if (!cancelled) setLoadFailed(true);
			}
		})();

		return () => {
			cancelled = true;
			if (widgetId !== undefined) window.turnstile?.remove(widgetId);
		};
	}, [siteKey, language]);

	if (loadFailed) {
		return (
			<p role="alert" className="text-sm text-kumo-danger text-center">
				{t`The security check couldn't load. Disable content blockers for this site and reload the page.`}
			</p>
		);
	}

	return <div ref={containerRef} className="flex justify-center" />;
}
