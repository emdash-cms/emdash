/**
 * Kumo Tailwind safelist.
 *
 * Kumo ships compiled JS where some component class strings are assembled
 * inside the local `cn()` utility (for example, Dialog's `dialogVariants()`).
 * The Tailwind v4 candidate scanner detects strings inside JSX `className`
 * attributes, but not inside arbitrary runtime `cn()` calls in a third-party
 * package. This component is never rendered; it exists only so the build
 * scans these classes and emits the corresponding utility rules into
 * `dist/styles.css`.
 */
export function KumoTailwindSafelist() {
	return (
		<div className="shadow-m ring ring-kumo-line fixed top-1/2 left-1/2 w-full sm:w-auto max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-kumo-base text-kumo-default duration-150 data-ending-style:scale-90 data-ending-style:opacity-0 data-starting-style:scale-90 data-starting-style:opacity-0 sm:min-w-96" />
	);
}
