/**
 * Hono app instance -- separated from index.ts so tests can import it
 * without pulling in the Workflow export (which requires cloudflare:workers).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

import { authorRoutes } from "./routes/author.js";
import { devRoutes } from "./routes/dev.js";
import { imageRoutes } from "./routes/images.js";
import { publicRoutes } from "./routes/public.js";
import { reviewRoutes } from "./routes/reviews.js";
import { statsRoutes } from "./routes/stats.js";
import { themeRoutes } from "./routes/themes.js";

const app = new Hono<{ Bindings: Env }>();

app.use(
	"/api/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/v1", publicRoutes);
app.route("/api/v1", authorRoutes);
app.route("/api/v1", reviewRoutes);
app.route("/api/v1", themeRoutes);
app.route("/api/v1", statsRoutes);
app.route("/api/v1", imageRoutes);
app.route("/api/v1", devRoutes);

export default app;
