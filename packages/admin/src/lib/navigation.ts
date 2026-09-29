/** Full-page navigation, for pages outside the admin router such as setup. */
export function navigateTo(href: string): void {
	window.location.assign(href);
}
