import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
	createSeoTextBridge,
	SeoPanel,
	seoTextInput,
	type SeoText,
	type SeoTextBridge,
} from "../../src/components/SeoPanel";
import type { ContentSeo, ContentSeoInput } from "../../src/lib/api";
import { render } from "../utils/render";
import { tap } from "../utils/touch";

// SeoPanel renders SeoImageField, which uses MediaPickerModal -- that hooks
// into react-query. Tests need a QueryClient in scope even when the modal is
// not opened, because the hook is called on the initial render.
function QueryWrapper({ children }: { children: React.ReactNode }) {
	const queryClient = React.useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[],
	);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SeoPanel", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("renders an OG image control regardless of collection fields", async () => {
		// The OG image picker used to live next to a `featured_image` content
		// field, so collections without that field (e.g. typical Pages) had no
		// way to set it. It now lives inside SeoPanel itself.
		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="page-1"
					seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
					onChange={() => {}}
				/>
			</QueryWrapper>,
		);

		screen.getByText("OG Image");
		screen.getByRole("button", { name: "Drop an image here or browse for OG Image" });
	});

	it("associates visible SEO labels with their fields", async () => {
		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="page-1"
					seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
					onChange={() => {}}
				/>
			</QueryWrapper>,
		);

		for (const label of ["SEO Title", "Meta Description", "Canonical URL"]) {
			await userEvent.click(screen.getByText(label));
			expect(document.activeElement).toBe(screen.getByLabelText(label).element());
		}
	});

	it("keeps the meta description field mounted while its character count updates", async () => {
		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="page-1"
					seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
					onChange={() => {}}
				/>
			</QueryWrapper>,
		);
		const initialField = screen.getByLabelText("Meta Description").element();

		await userEvent.type(initialField, "f");

		expect(screen.getByLabelText("Meta Description").element()).toBe(initialField);
		await expect.element(screen.getByText("1/160 characters")).toBeVisible();
	});

	it("renders the existing OG image preview when set", async () => {
		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="page-1"
					seo={{
						title: null,
						description: null,
						image: "https://example.com/og.jpg",
						canonical: null,
						noIndex: false,
					}}
					onChange={() => {}}
				/>
			</QueryWrapper>,
		);

		// The decorative <img> has alt="" so it doesn't have role="img" --
		// query the DOM directly after confirming the panel rendered.
		screen.getByText("OG Image");
		const img = document.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("https://example.com/og.jpg");
	});

	it("debounces text field saves", async () => {
		const onChange = vi.fn();

		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="post-1"
					seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
					onChange={onChange}
				/>
			</QueryWrapper>,
		);

		const titleInput = screen.getByLabelText("SEO Title");
		await userEvent.type(titleInput, "SEO title");

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(onChange).not.toHaveBeenCalled();

		await vi.waitFor(
			() => {
				expect(onChange).toHaveBeenCalledTimes(1);
			},
			{ timeout: 1500 },
		);
		expect(onChange).toHaveBeenLastCalledWith({
			title: "SEO title",
			description: null,
			canonical: null,
			noIndex: false,
		});
	});

	it("saves noindex changes immediately", async () => {
		const onChange = vi.fn();

		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="post-1"
					seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
					onChange={onChange}
				/>
			</QueryWrapper>,
		);

		await userEvent.click(screen.getByRole("switch"));

		await vi.waitFor(() => {
			expect(onChange).toHaveBeenCalledWith({
				title: null,
				description: null,
				canonical: null,
				noIndex: true,
			});
		});
	});

	it("does not overwrite newer local text when stale props arrive", async () => {
		function Host() {
			const [seo, setSeo] = React.useState({
				title: "Original",
				description: null,
				image: null,
				canonical: null,
				noIndex: false,
			});

			return (
				<>
					<SeoPanel contentKey="post-1" seo={seo} onChange={() => {}} />
					<button
						type="button"
						onClick={() =>
							setSeo({
								title: "Older save",
								description: null,
								image: null,
								canonical: null,
								noIndex: false,
							})
						}
					>
						Apply stale props
					</button>
				</>
			);
		}

		const screen = await render(
			<QueryWrapper>
				<Host />
			</QueryWrapper>,
		);
		const titleInput = screen.getByLabelText("SEO Title");
		await userEvent.clear(titleInput);
		await userEvent.type(titleInput, "Newest local value");
		await vi.waitFor(() => {
			expect((titleInput.element() as HTMLInputElement).value).toBe("Newest local value");
		});

		const stalePropsButton = screen.getByRole("button", { name: "Apply stale props" });
		await userEvent.click(stalePropsButton);

		expect((titleInput.element() as HTMLInputElement).value).toBe("Newest local value");
	});

	it("resets when switching to a different content item", async () => {
		const onChange = vi.fn();

		function Host() {
			const [contentKey, setContentKey] = React.useState("post-1");
			const [seo, setSeo] = React.useState({
				title: "First post",
				description: null,
				image: null,
				canonical: null,
				noIndex: false,
			});

			return (
				<>
					<SeoPanel contentKey={contentKey} seo={seo} onChange={onChange} />
					<button
						type="button"
						onClick={() => {
							setContentKey("post-2");
							setSeo({
								title: "Second post",
								description: "Fresh content",
								image: null,
								canonical: null,
								noIndex: false,
							});
						}}
					>
						Switch content
					</button>
				</>
			);
		}

		const screen = await render(
			<QueryWrapper>
				<Host />
			</QueryWrapper>,
		);
		const titleInput = screen.getByLabelText("SEO Title");
		await userEvent.clear(titleInput);
		await userEvent.type(titleInput, "Unsaved local edit");

		await userEvent.click(screen.getByRole("button", { name: "Switch content" }));

		expect(onChange).toHaveBeenCalledWith({
			title: "Unsaved local edit",
			description: null,
			canonical: null,
			noIndex: false,
		});
		expect((titleInput.element() as HTMLInputElement).value).toBe("Second post");

		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("flushes pending text changes on unmount", async () => {
		const onChange = vi.fn();

		function Host() {
			const [isVisible, setIsVisible] = React.useState(true);

			return (
				<>
					{isVisible ? (
						<SeoPanel
							contentKey="post-1"
							seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
							onChange={onChange}
						/>
					) : null}
					<button type="button" onClick={() => setIsVisible(false)}>
						Hide panel
					</button>
				</>
			);
		}

		const screen = await render(
			<QueryWrapper>
				<Host />
			</QueryWrapper>,
		);
		const titleInput = screen.getByLabelText("SEO Title");
		await userEvent.type(titleInput, "SEO title");

		await userEvent.click(screen.getByRole("button", { name: "Hide panel" }));

		const expectedSeo = {
			title: "SEO title",
			description: null,
			canonical: null,
			noIndex: false,
		};
		expect(onChange).toHaveBeenCalledWith(expectedSeo);

		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.lastCall?.[0]).toEqual(expectedSeo);
	});
	it("shows the derived title and description as placeholders", async () => {
		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="page-1"
					seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
					onChange={() => {}}
					defaultTitle="About us"
					defaultDescription="Who we are and what we do."
				/>
			</QueryWrapper>,
		);

		await expect
			.element(screen.getByLabelText("SEO Title"))
			.toHaveAttribute("placeholder", "About us");
		await expect
			.element(screen.getByLabelText("Meta Description"))
			.toHaveAttribute("placeholder", "Who we are and what we do.");
	});

	it("omits placeholders when there is nothing to derive from", async () => {
		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="page-1"
					seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
					onChange={() => {}}
				/>
			</QueryWrapper>,
		);

		await expect.element(screen.getByLabelText("SEO Title")).not.toHaveAttribute("placeholder");
		await expect
			.element(screen.getByLabelText("Meta Description"))
			.not.toHaveAttribute("placeholder");
	});

	it("keeps SEO help open after a tap until the next tap", async () => {
		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="page-1"
					seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
					onChange={() => {}}
				/>
			</QueryWrapper>,
		);
		const help = screen.getByRole("button", {
			name: "Why is this important for search result titles?",
		});
		const helpText = page.getByRole("tooltip", {
			name: "Overrides the page title in search engine results",
		});

		await tap(help.element());
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expect.element(helpText).toBeVisible();

		await tap(help.element());
		await expect.element(helpText).not.toBeInTheDocument();
	});
});

function seoOf(title: string): ContentSeo {
	return { title, description: null, image: null, canonical: null, noIndex: false };
}

/** Writes SEO text the way the editor does: through a mounted panel, or saved at once. */
function writeText(
	bridge: SeoTextBridge,
	text: Partial<SeoText>,
	save: (seo: ContentSeoInput) => void,
) {
	bridge.text = { ...bridge.text, ...text };
	if (bridge.setText) bridge.setText(text);
	else save(seoTextInput(text));
}

describe("SeoPanel text bridge", () => {
	it("starts from the bridge's text and doesn't send it again", async () => {
		const onChange = vi.fn();
		const bridge = createSeoTextBridge(seoOf("Saved title"));
		bridge.text = { title: "Patched title", description: "" };
		const screen = await render(
			<QueryWrapper>
				<SeoPanel
					contentKey="post-1"
					seo={seoOf("Saved title")}
					onChange={onChange}
					textBridge={bridge}
				/>
			</QueryWrapper>,
		);

		await expect.element(screen.getByLabelText("SEO Title")).toHaveValue("Patched title");
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(onChange).not.toHaveBeenCalled();
	});

	it("writes typed text to the bridge before its debounce sends it", async () => {
		const onChange = vi.fn();
		const bridge = createSeoTextBridge(seoOf(""));
		const screen = await render(
			<QueryWrapper>
				<SeoPanel contentKey="post-1" seo={seoOf("")} onChange={onChange} textBridge={bridge} />
			</QueryWrapper>,
		);

		await userEvent.type(screen.getByLabelText("Meta Description"), "Typed");

		expect(bridge.text).toEqual({ title: "", description: "Typed" });
		expect(onChange).not.toHaveBeenCalled();
	});

	it("saves text written through the bridge after its debounce, and sends pending text as it unmounts", async () => {
		const onChange = vi.fn();
		const bridge = createSeoTextBridge(seoOf(""));
		function Host() {
			const [visible, setVisible] = React.useState(true);
			return (
				<>
					{visible && (
						<SeoPanel contentKey="post-1" seo={seoOf("")} onChange={onChange} textBridge={bridge} />
					)}
					<button type="button" onClick={() => setVisible(false)}>
						Hide panel
					</button>
				</>
			);
		}
		const screen = await render(
			<QueryWrapper>
				<Host />
			</QueryWrapper>,
		);

		writeText(bridge, { title: "Bonjour" }, onChange);
		await expect.element(screen.getByLabelText("SEO Title")).toHaveValue("Bonjour");
		expect(onChange).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(onChange).toHaveBeenCalledWith({
				title: "Bonjour",
				description: null,
				canonical: null,
				noIndex: false,
			}),
		);

		writeText(bridge, { title: "Bonjour à tous" }, onChange);
		await userEvent.click(screen.getByRole("button", { name: "Hide panel" }));
		expect(onChange).toHaveBeenLastCalledWith({
			title: "Bonjour à tous",
			description: null,
			canonical: null,
			noIndex: false,
		});
		expect(bridge.setText).toBeNull();
	});

	it("shows and saves text the editor writes as the panel mounts", async () => {
		const onChange = vi.fn();
		const bridge = createSeoTextBridge(seoOf("Saved title"));
		function Host() {
			const [visible, setVisible] = React.useState(false);
			React.useLayoutEffect(() => {
				if (visible) writeText(bridge, { title: "Patched title" }, onChange);
			}, [visible]);
			return (
				<>
					{visible && (
						<SeoPanel
							contentKey="post-1"
							seo={seoOf("Saved title")}
							onChange={onChange}
							textBridge={bridge}
						/>
					)}
					<button type="button" onClick={() => setVisible(true)}>
						Show panel
					</button>
				</>
			);
		}
		const screen = await render(
			<QueryWrapper>
				<Host />
			</QueryWrapper>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Show panel" }));

		await expect.element(screen.getByLabelText("SEO Title")).toHaveValue("Patched title");
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		expect(onChange).toHaveBeenLastCalledWith({
			title: "Patched title",
			description: null,
			canonical: null,
			noIndex: false,
		});
	});

	it("sends text the editor writes right after an entry switch to the new entry", async () => {
		const savesToFirst = vi.fn();
		const savesToSecond = vi.fn();
		const entries = {
			"post-1": {
				seo: seoOf("First"),
				bridge: createSeoTextBridge(seoOf("First")),
				save: savesToFirst,
			},
			"post-2": {
				seo: seoOf("Second"),
				bridge: createSeoTextBridge(seoOf("Second")),
				save: savesToSecond,
			},
		};
		function Host() {
			const [key, setKey] = React.useState<keyof typeof entries>("post-1");
			const entry = entries[key];
			React.useLayoutEffect(() => {
				if (key === "post-2")
					writeText(entry.bridge, { title: "For the second entry" }, entry.save);
			}, [entry, key]);
			return (
				<>
					<SeoPanel
						contentKey={key}
						seo={entry.seo}
						onChange={entry.save}
						textBridge={entry.bridge}
					/>
					<button type="button" onClick={() => setKey("post-2")}>
						Switch entry
					</button>
				</>
			);
		}
		const screen = await render(
			<QueryWrapper>
				<Host />
			</QueryWrapper>,
		);
		const title = screen.getByLabelText("SEO Title");
		await userEvent.clear(title);
		await userEvent.type(title, "Unsaved first");

		await userEvent.click(screen.getByRole("button", { name: "Switch entry" }));

		await expect.element(title).toHaveValue("For the second entry");
		await vi.waitFor(() =>
			expect(savesToSecond).toHaveBeenCalledWith({
				title: "For the second entry",
				description: null,
				canonical: null,
				noIndex: false,
			}),
		);
		expect(savesToFirst.mock.calls).toEqual([
			[{ title: "Unsaved first", description: null, canonical: null, noIndex: false }],
		]);
		expect(entries["post-1"].bridge.text.title).toBe("Unsaved first");
	});
});
