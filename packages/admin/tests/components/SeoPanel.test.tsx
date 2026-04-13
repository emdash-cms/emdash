import * as React from "react";
import { userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SeoPanel } from "../../src/components/SeoPanel";

describe("SeoPanel", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("debounces text field saves", async () => {
		const onChange = vi.fn();

		const screen = await render(
			<SeoPanel
				contentKey="post-1"
				seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
				onChange={onChange}
			/>,
		);

		const titleInput = screen.getByLabelText("SEO Title");
		await userEvent.type(titleInput, "SEO title");

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(onChange).not.toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(onChange).toHaveBeenCalledTimes(1);
		}, 1500);
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
			<SeoPanel
				contentKey="post-1"
				seo={{ title: "", description: null, image: null, canonical: null, noIndex: false }}
				onChange={onChange}
			/>,
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

		const screen = await render(<Host />);
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

		const screen = await render(<Host />);
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

		const screen = await render(<Host />);
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
