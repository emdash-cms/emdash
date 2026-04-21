import vercel from "@astrojs/vercel";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local, s3 } from "emdash/astro";
import { postgres, sqlite } from "emdash/db";

const hasExternalDatabase = Boolean(process.env.DATABASE_URL);
const hasExternalStorage = Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET);

export default defineConfig({
	output: "server",
	adapter: vercel(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: hasExternalDatabase
				? postgres({ connectionString: process.env.DATABASE_URL, ssl: true })
				: sqlite({ url: "file:./data.db" }),
			storage: hasExternalStorage
				? s3({
						endpoint: process.env.S3_ENDPOINT,
						bucket: process.env.S3_BUCKET,
						accessKeyId: process.env.S3_ACCESS_KEY_ID,
						secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
						region: process.env.S3_REGION,
						publicUrl: process.env.S3_PUBLIC_URL,
					})
				: local({
						directory: "./uploads",
						baseUrl: "/_emdash/api/media/file",
					}),
		}),
	],
	devToolbar: { enabled: false },
});
