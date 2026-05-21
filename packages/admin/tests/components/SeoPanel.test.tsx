import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { SeoPanel } from "../../src/components/SeoPanel";
import { render } from "../utils/render";

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
		screen.getByRole("button", { name: "Select OG image" });
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

		expect(onChange).toHaveBeenCalledWith({
			title: "SEO title",
			description: null,
			canonical: null,
			noIndex: false,
		});

		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
