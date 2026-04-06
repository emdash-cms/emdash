/**
 * Client-side form enhancement.
 *
 * Following the same progressive enhancement pattern as Astro's <ClientRouter />,
 * this uses event delegation on `document` — a single set of listeners handles
 * all forms on the page, including forms added after initial load.
 *
 * Features:
 * - AJAX submission (no page reload)
 * - Client-side validation with inline errors
 * - Multi-page navigation with history integration
 * - Conditional field visibility
 * - Session persistence (survives page refreshes)
 * - Turnstile widget injection
 * - File upload with FormData
 */

const STORAGE_PREFIX = "ec-form:";
const DEBOUNCE_MS = 500;

let saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let listenersRegistered = false;

// ─── Initialization ──────────────────────────────────────────────

export function initForms() {
	const init = () => {
		document.querySelectorAll<HTMLFormElement>("[data-ec-form]").forEach((form) => {
			if (form.dataset.ecInitialized) return;
			form.dataset.ecInitialized = "1";
			restoreState(form);
			initMultiPage(form);
			initConditions(form);
			initTurnstile(form);
		});
	};

	// Guard against duplicate listener registration
	if (!listenersRegistered) {
		listenersRegistered = true;

		// Event delegation — handles all forms, current and future
		document.addEventListener("submit", handleSubmit);
		document.addEventListener("click", handleClick);
		document.addEventListener("input", handleInput);
		document.addEventListener("change", handleChange);
		window.addEventListener("popstate", handlePopState);

		// Astro ClientRouter fires astro:page-load on every navigation
		document.addEventListener("astro:page-load", init);

		// Clean up pending save timers before view transitions swap the DOM
		document.addEventListener("astro:before-swap", () => {
			for (const timer of saveTimers.values()) {
				clearTimeout(timer);
			}
			saveTimers.clear();
		});
	}

	// Fallback for sites without ClientRouter
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
}

// ─── Submit Handler ──────────────────────────────────────────────

async function handleSubmit(e: Event) {
	const form = (e.target as HTMLElement).closest<HTMLFormElement>("[data-ec-form]");
	if (!form) return;
	e.preventDefault();

	// Validate current (or last) page
	if (!validateVisibleFields(form)) return;

	const submitBtn = form.querySelector<HTMLButtonElement>(".ec-form-submit");
	if (submitBtn) {
		submitBtn.disabled = true;
		submitBtn.textContent = "Submitting...";
	}

	clearStatus(form);

	try {
		const hasFiles = form.querySelector<HTMLInputElement>('input[type="file"]');
		let body: BodyInit;
		const headers: Record<string, string> = {};

		if (hasFiles) {
			body = new FormData(form);
		} else {
			headers["Content-Type"] = "application/json";
			const formData = new FormData(form);
			let formId = "";
			const data: Record<string, unknown> = {};
			// Track keys we've seen to detect multi-value fields (checkbox-group)
			const seen = new Set<string>();
			for (const [key, val] of formData) {
				if (typeof val !== "string") continue;
				if (key === "formId") {
					formId = val;
				} else if (key === "_hp" || key === "cf-turnstile-response") {
					// Include spam fields at top level for server-side checks
					data[key] = val;
				} else if (seen.has(key)) {
					// Multi-value field (checkbox-group) — collect into array
					const existing = data[key];
					if (Array.isArray(existing)) {
						existing.push(val);
					} else {
						data[key] = [existing, val];
					}
				} else {
					seen.add(key);
					data[key] = val;
				}
			}
			body = JSON.stringify({ formId, data });
		}

		const res = await fetch(form.action, {
			method: "POST",
			headers,
			body,
		});

		const result = (await res.json()) as {
			success?: boolean;
			message?: string;
			redirect?: string;
			errors?: Array<{ field: string; message: string }>;
		};

		if (result.success) {
			clearSavedState(form);
			if (result.redirect) {
				window.location.href = result.redirect;
			} else {
				showStatus(form, result.message || "Submitted successfully.", "success");
				form.reset();
			}
		} else if (result.errors) {
			showErrors(form, result.errors);
		} else {
			showStatus(form, "Something went wrong. Please try again.", "error");
		}
	} catch {
		showStatus(form, "Network error. Please try again.", "error");
	} finally {
		if (submitBtn) {
			submitBtn.disabled = false;
			submitBtn.textContent = form.dataset.submitLabel || "Submit";
		}
	}
}

// ─── Click Handler (Prev/Next) ───────────────────────────────────

function handleClick(e: Event) {
	const target = e.target as HTMLElement;

	const nextBtn = target.closest("[data-ec-next]");
	if (nextBtn) {
		const form = nextBtn.closest<HTMLFormElement>("[data-ec-form]");
		if (form) {
			const current = getCurrentPage(form);
			if (validatePage(form, current)) {
				showPage(form, current + 1);
				saveState(form);
				history.pushState({ ecFormPage: current + 1, ecFormId: form.dataset.formId }, "");
			}
		}
		return;
	}

	const prevBtn = target.closest("[data-ec-prev]");
	if (prevBtn) {
		const form = prevBtn.closest<HTMLFormElement>("[data-ec-form]");
		if (form) {
			const current = getCurrentPage(form);
			if (current > 0) {
				showPage(form, current - 1);
				saveState(form);
				history.pushState({ ecFormPage: current - 1, ecFormId: form.dataset.formId }, "");
			}
		}
	}
}

// ─── Input/Change Handlers ───────────────────────────────────────

function handleInput(e: Event) {
	const target = e.target as HTMLElement;
	const form = target.closest<HTMLFormElement>("[data-ec-form]");
	if (!form) return;

	// Clear field error on input
	const name = (target as HTMLInputElement).name;
	if (name) {
		const errorEl = form.querySelector(`[data-error-for="${name}"]`);
		if (errorEl) errorEl.textContent = "";
	}

	// Debounced save
	debouncedSave(form);
}

function handleChange(e: Event) {
	const target = e.target as HTMLElement;
	const form = target.closest<HTMLFormElement>("[data-ec-form]");
	if (!form) return;

	// Evaluate conditions
	evaluateConditions(form);
}

// ─── Popstate Handler ────────────────────────────────────────────

function handlePopState(e: PopStateEvent) {
	if (e.state && typeof e.state.ecFormPage === "number" && typeof e.state.ecFormId === "string") {
		const form = document.querySelector<HTMLFormElement>(
			`[data-ec-form][data-form-id="${CSS.escape(e.state.ecFormId)}"]`,
		);
		if (form) {
			const pages = form.querySelectorAll("[data-page]");
			const page = Math.min(e.state.ecFormPage, pages.length - 1);
			showPage(form, Math.max(0, page));
		}
	}
}

// ─── Multi-Page ──────────────────────────────────────────────────

function initMultiPage(form: HTMLFormElement) {
	const pages = form.querySelectorAll<HTMLFieldSetElement>("[data-page]");
	if (pages.length <= 1) return;

	// Hide all pages except first
	pages.forEach((page, i) => {
		if (i > 0) {
			page.hidden = true;
			// Remove required from hidden pages to prevent native validation
			page.querySelectorAll<HTMLElement>("[required]").forEach((el) => {
				el.removeAttribute("required");
				el.dataset.wasRequired = "1";
			});
		}
	});

	// Show next button, hide submit (unless single page)
	const nextBtn = form.querySelector<HTMLButtonElement>("[data-ec-next]");
	const submitBtn = form.querySelector<HTMLButtonElement>(".ec-form-submit");
	if (nextBtn) nextBtn.hidden = false;
	if (submitBtn) submitBtn.hidden = true;

	updateProgress(form, 0, pages.length);
}

function showPage(form: HTMLFormElement, pageIndex: number) {
	const pages = form.querySelectorAll<HTMLFieldSetElement>("[data-page]");
	const totalPages = pages.length;

	pages.forEach((page, i) => {
		if (i === pageIndex) {
			page.hidden = false;
			// Restore required attributes
			page.querySelectorAll<HTMLElement>("[data-was-required]").forEach((el) => {
				el.setAttribute("required", "");
				delete el.dataset.wasRequired;
			});
		} else {
			page.hidden = true;
			// Strip required from hidden
			page.querySelectorAll<HTMLElement>("[required]").forEach((el) => {
				el.removeAttribute("required");
				el.dataset.wasRequired = "1";
			});
		}
	});

	// Update button visibility
	const prevBtn = form.querySelector<HTMLButtonElement>("[data-ec-prev]");
	const nextBtn = form.querySelector<HTMLButtonElement>("[data-ec-next]");
	const submitBtn = form.querySelector<HTMLButtonElement>(".ec-form-submit");

	if (prevBtn) prevBtn.hidden = pageIndex === 0;
	if (nextBtn) nextBtn.hidden = pageIndex === totalPages - 1;
	if (submitBtn) submitBtn.hidden = pageIndex < totalPages - 1;

	updateProgress(form, pageIndex, totalPages);
}

function getCurrentPage(form: HTMLFormElement): number {
	const pages = form.querySelectorAll<HTMLFieldSetElement>("[data-page]");
	for (let i = 0; i < pages.length; i++) {
		if (!pages[i]!.hidden) return i;
	}
	return 0;
}

function updateProgress(form: HTMLFormElement, current: number, total: number) {
	const progress = form.querySelector("[data-ec-progress]");
	if (progress) {
		progress.textContent = `Step ${current + 1} of ${total}`;
	}
}

// ─── Validation ──────────────────────────────────────────────────

function validatePage(form: HTMLFormElement, pageIndex: number): boolean {
	const page = form.querySelector<HTMLFieldSetElement>(`[data-page="${pageIndex}"]`);
	if (!page) return true;

	let valid = true;
	page
		.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
			"input, select, textarea",
		)
		.forEach((input) => {
			if (!input.checkValidity()) {
				valid = false;
				showFieldError(form, input.name, input.validationMessage);
			}
		});

	return valid;
}

function validateVisibleFields(form: HTMLFormElement): boolean {
	let valid = true;
	form.querySelectorAll<HTMLFieldSetElement>("[data-page]:not([hidden])").forEach((page) => {
		page
			.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
				"input, select, textarea",
			)
			.forEach((input) => {
				if (!input.checkValidity()) {
					valid = false;
					showFieldError(form, input.name, input.validationMessage);
				}
			});
	});

	return valid;
}

function showFieldError(form: HTMLFormElement, fieldName: string, message: string) {
	const errorEl = form.querySelector(`[data-error-for="${fieldName}"]`);
	if (errorEl) errorEl.textContent = message;
}

function showErrors(form: HTMLFormElement, errors: Array<{ field: string; message: string }>) {
	for (const err of errors) {
		showFieldError(form, err.field, err.message);
	}
}

// ─── Status Messages ─────────────────────────────────────────────

function showStatus(form: HTMLFormElement, message: string, type: "success" | "error") {
	const status = form.querySelector("[data-form-status]");
	if (status) {
		status.textContent = message;
		status.className = `ec-form-status ec-form-status--${type}`;
	}
}

function clearStatus(form: HTMLFormElement) {
	const status = form.querySelector("[data-form-status]");
	if (status) {
		status.textContent = "";
		status.className = "ec-form-status";
	}
}

// ─── Conditional Fields ──────────────────────────────────────────

function initConditions(form: HTMLFormElement) {
	evaluateConditions(form);
}

function evaluateConditions(form: HTMLFormElement) {
	form.querySelectorAll<HTMLElement>("[data-condition]").forEach((wrapper) => {
		try {
			const condition = JSON.parse(wrapper.dataset.condition || "{}") as {
				field: string;
				op: string;
				value?: string;
			};
			const input = form.elements.namedItem(condition.field) as HTMLInputElement | null;
			if (!input) return;

			const value = input.value;
			let visible = true;

			switch (condition.op) {
				case "eq":
					visible = value === (condition.value ?? "");
					break;
				case "neq":
					visible = value !== (condition.value ?? "");
					break;
				case "filled":
					visible = value !== "";
					break;
				case "empty":
					visible = value === "";
					break;
			}

			wrapper.hidden = !visible;
			// Disable inputs in hidden fields so they're excluded from FormData
			wrapper.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach((el) => {
				el.disabled = !visible;
			});
		} catch {
			// Invalid condition JSON — show field
		}
	});
}

// ─── Session Persistence ─────────────────────────────────────────

function saveState(form: HTMLFormElement) {
	const formId = form.dataset.formId;
	if (!formId) return;

	const page = getCurrentPage(form);
	const values: Record<string, string> = {};
	for (const [key, val] of new FormData(form)) {
		if (typeof val === "string") values[key] = val;
	}

	try {
		sessionStorage.setItem(
			STORAGE_PREFIX + formId,
			JSON.stringify({ page, values, savedAt: Date.now() }),
		);
	} catch {
		// sessionStorage full or unavailable — ignore
	}
}

function restoreState(form: HTMLFormElement) {
	const formId = form.dataset.formId;
	if (!formId) return;

	try {
		const raw = sessionStorage.getItem(STORAGE_PREFIX + formId);
		if (!raw) return;

		const state = JSON.parse(raw) as {
			page: number;
			values: Record<string, string>;
		};

		// Restore field values
		for (const [name, value] of Object.entries(state.values)) {
			const input = form.elements.namedItem(name);
			if (
				input instanceof HTMLInputElement ||
				input instanceof HTMLTextAreaElement ||
				input instanceof HTMLSelectElement
			) {
				input.value = value;
			}
		}

		// Navigate to saved page (clamped to valid range)
		if (state.page > 0) {
			const pages = form.querySelectorAll("[data-page]");
			const page = Math.min(state.page, pages.length - 1);
			if (page > 0) showPage(form, page);
		}
	} catch {
		// Invalid saved state — ignore
	}
}

function clearSavedState(form: HTMLFormElement) {
	const formId = form.dataset.formId;
	if (formId) {
		try {
			sessionStorage.removeItem(STORAGE_PREFIX + formId);
		} catch {
			// Ignore
		}
	}
}

function debouncedSave(form: HTMLFormElement) {
	const formId = form.dataset.formId;
	if (!formId) return;

	const existing = saveTimers.get(formId);
	if (existing) clearTimeout(existing);

	saveTimers.set(
		formId,
		setTimeout(() => {
			saveState(form);
			saveTimers.delete(formId);
		}, DEBOUNCE_MS),
	);
}

// ─── Turnstile ───────────────────────────────────────────────────

function initTurnstile(form: HTMLFormElement) {
	const container = form.querySelector<HTMLElement>("[data-ec-turnstile]");
	if (!container) return;

	const siteKey = container.dataset.sitekey;
	if (!siteKey) return;

	// Load Turnstile script if not already loaded
	if (!document.querySelector('script[src*="turnstile"]')) {
		const script = document.createElement("script");
		script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		script.async = true;
		script.onload = () => renderTurnstile(container, siteKey);
		document.head.appendChild(script);
	} else {
		renderTurnstile(container, siteKey);
	}
}

function renderTurnstile(container: HTMLElement, siteKey: string) {
	interface TurnstileWindow {
		turnstile?: {
			render: (el: HTMLElement, opts: Record<string, unknown>) => void;
		};
	}

	const w = window as Window & TurnstileWindow;
	if (w.turnstile) {
		w.turnstile.render(container, { sitekey: siteKey });
	}
}
