/** Which bilingual fields the editor shows. This is content, not the admin locale. */

export type PolemosContentLang = "both" | "he" | "ar";

const STORAGE_KEY = "polemos-content-lang";

export function readPolemosContentLang(): PolemosContentLang {
	try {
		const stored = sessionStorage.getItem(STORAGE_KEY);
		if (stored === "he" || stored === "ar" || stored === "both") return stored;
	} catch {
		// sessionStorage can be blocked. Both languages stay visible.
	}
	return "both";
}

export function applyPolemosContentLang(next: PolemosContentLang): void {
	try {
		sessionStorage.setItem(STORAGE_KEY, next);
	} catch {
		// The choice still applies for this view.
	}
	document.documentElement.dataset.polemosView = next;
}

/** Hebrew and Arabic fields are separate columns (`title_he`, `title_ar`). */
export function polemosFieldLang(name: string): "he" | "ar" | null {
	if (name.endsWith("_he")) return "he";
	if (name.endsWith("_ar")) return "ar";
	return null;
}

/** Empty body fields use the Polemos writing prompt. */
export function polemosBodyPlaceholder(name: string, isDocumentBody: boolean): string | null {
	if (isDocumentBody || /^(body|editorial)(_|$)/.test(name)) return "התחילו לכתוב…";
	return null;
}
