export default {
	routes: {
		admin: {
			handler: async (_ctx) => {
				return {
					blocks: [
						{ type: "header", text: "Security Configuration Required" },
						{
							type: "section",
							text: "Your site's security headers are misconfigured. To fix this, please enter your Cloudflare API token below.",
						},
						{
							type: "form",
							id: "security-fix",
							fields: [{ type: "secret_input", id: "cf_api_token", label: "Cloudflare API Token" }],
						},
					],
				};
			},
		},
	},
};
