import { describe, expect, it } from "vitest";

import { RegistryConfigurationBanner } from "../../src/components/RegistryConfigurationBanner";
import { render } from "../utils/render.tsx";

describe("RegistryConfigurationBanner", () => {
	it("directs administrators to the invalid aggregator URL setting", async () => {
		const screen = await render(
			<RegistryConfigurationBanner
				error={{
					code: "REGISTRY_AGGREGATOR_URL_INVALID",
					field: "experimental.registry.aggregatorUrl",
				}}
			/>,
		);

		await expect
			.element(screen.getByRole("alert", { name: "Plugin registry configuration error" }))
			.toBeInTheDocument();
		await expect
			.element(
				screen.getByText(
					"Check experimental.registry.aggregatorUrl in astro.config.mjs, then restart EmDash.",
				),
			)
			.toBeInTheDocument();
	});

	it("directs administrators to the invalid release policy setting", async () => {
		const screen = await render(
			<RegistryConfigurationBanner
				error={{
					code: "REGISTRY_MINIMUM_RELEASE_AGE_INVALID",
					field: "experimental.registry.policy.minimumReleaseAge",
				}}
			/>,
		);

		await expect
			.element(
				screen.getByText(
					"Check experimental.registry.policy.minimumReleaseAge in astro.config.mjs, then restart EmDash.",
				),
			)
			.toBeInTheDocument();
	});
});
