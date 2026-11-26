import { useSidebar } from "@cloudflare/kumo";
import * as React from "react";

import { useStableCallback } from "../lib/hooks.js";
import { focusableIn } from "./block-field-keyboard.js";

const SETTINGS_FIELDS = new Set(["publishedAt", "bylines", "slug", "seo"]);

export function isSettingsField(field: string): boolean {
	return SETTINGS_FIELDS.has(field);
}

/** Reveals and focuses a settings alias from inside the sidebar's desktop/mobile context. */
export function SettingsFieldLink({
	field,
	panelId,
	openToken,
	onReveal,
	onFocused,
}: {
	field: string;
	panelId: string;
	/** Advances once the sidebar finishes opening, after its own mobile autofocus. */
	openToken: number;
	onReveal: () => void;
	onFocused?: () => void;
}) {
	const { isMobile, open, openMobile, setOpenMobile } = useSidebar();
	const revealedMode = React.useRef<boolean | null>(null);
	const waitingToken = React.useRef<number | null>(null);
	const attempted = React.useRef(false);
	const reveal = useStableCallback(onReveal);
	const focused = useStableCallback(() => onFocused?.());

	React.useEffect(() => {
		if (attempted.current || !isSettingsField(field)) return;
		const isOpen = isMobile ? openMobile : open;
		if (revealedMode.current !== isMobile) {
			revealedMode.current = isMobile;
			waitingToken.current = isOpen ? null : openToken;
			reveal();
			if (isMobile) setOpenMobile(true);
		}
		if (!isOpen || waitingToken.current === openToken) return;
		const panel = document.getElementById(panelId);
		if (!panel) return;
		const focus = () => {
			if (attempted.current) return;
			attempted.current = true;
			const marker = panel.querySelector(`[data-settings-field="${field}"]`);
			const control = focusableIn(marker);
			if (!control || control.closest("[inert]")) return;
			control.focus({ preventScroll: true });
			if (document.activeElement !== control) return;
			control.scrollIntoView({ block: "center", behavior: "smooth" });
			focused();
		};
		const frame = requestAnimationFrame(focus);
		return () => cancelAnimationFrame(frame);
	}, [field, panelId, openToken, isMobile, open, openMobile, setOpenMobile, reveal, focused]);

	return null;
}
