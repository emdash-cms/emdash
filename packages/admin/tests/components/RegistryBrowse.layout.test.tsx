import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { RegistryClientConfig, RegistryPackageView } from "../../src/lib/api/registry";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, params, ...props }: any) => {
			let href = String(to ?? "");
			for (const [key, value] of Object.entries(params ?? {})) {
				href = href.replace(`$${key}`, String(value));
			}
			return (
				<a href={href} {...props}>
					{children}
				</a>
			);
		},
	};
});

const mockSearchRegistryPackages = vi.fn();

vi.mock("../../src/lib/api/registry", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/registry")>(
		"../../src/lib/api/registry",
	);
	return {
		...actual,
		searchRegistryPackages: (...args: unknown[]) => mockSearchRegistryPackages(...args),
		resolveDidToHandle: async () => ({ status: "missing" }),
	};
});

const { RegistryBrowse } = await import("../../src/components/RegistryBrowse");

const CONFIG: RegistryClientConfig = { aggregatorUrl: "https://aggregator.test" };

const PACKAGES = [
	["did:plc:xyraubanwc5fwemkduw3upi6", "marketplace-test"],
	["did:plc:n4mihg5idgr5ne4jigcmbh4k", "ai-search"],
	["did:plc:tsp7az5h6qsqjzqsgz37wonx", "freeform"],
	["did:plc:5htva5ewwisu7gfjou2o4mee", "emdash-cf-email-sending"],
] as const;

function packageView(did: string, slug: string): RegistryPackageView {
	return {
		uri: `at://${did}/com.emdashcms.experimental.package.profile/${slug}`,
		did,
		handle: "unverified.example",
		slug,
		labels: [],
		profile: {
			name: slug,
			description: `${slug} description`,
			license: "MIT",
			authors: [{ name: "Author" }],
			security: [],
			keywords: [],
		},
	} as unknown as RegistryPackageView;
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("RegistryBrowse layout", () => {
	it.each(["ltr", "rtl"] as const)(
		"keeps unresolved publisher identifiers inside their cards (%s)",
		async (dir) => {
			mockSearchRegistryPackages.mockResolvedValue({
				packages: PACKAGES.map(([did, slug]) => packageView(did, slug)),
			});
			await page.viewport(1280, 800);
			const screen = await render(
				<div dir={dir} data-testid="scroller" style={{ width: 760, overflow: "auto" }}>
					<RegistryBrowse config={CONFIG} />
				</div>,
			);

			await expect.element(screen.getByText("Handle unavailable").first()).toBeVisible();

			for (const [did, slug] of PACKAGES) {
				const identifier = screen.getByText(`${did}/${slug}`).element();
				const card = identifier.closest("a")!.getBoundingClientRect();
				const bounds = identifier.getBoundingClientRect();
				expect(bounds.left).toBeGreaterThanOrEqual(card.left);
				expect(bounds.right).toBeLessThanOrEqual(card.right);
			}
			const scroller = screen.getByTestId("scroller").element();
			expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
		},
	);
});
