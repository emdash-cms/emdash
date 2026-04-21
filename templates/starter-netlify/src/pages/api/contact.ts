import type { APIRoute } from "astro";

export const prerender = false;

function badRequest(message: string) {
	return new Response(message, { status: 400 });
}

export const POST: APIRoute = async ({ request, redirect }) => {
	const form = await request.formData();
	const name = String(form.get("name") ?? "").trim();
	const email = String(form.get("email") ?? "").trim();
	const phone = String(form.get("phone") ?? "").trim();
	const message = String(form.get("message") ?? "").trim();
	const honeypot = String(form.get("company") ?? "").trim();

	if (honeypot) {
		return redirect("/contact?status=success", 303);
	}

	if (name.length < 2 || name.length > 120) {
		return badRequest("Invalid name");
	}

	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
		return badRequest("Invalid email");
	}

	if (message.length < 10 || message.length > 5000) {
		return badRequest("Invalid message");
	}

	const payload = {
		name,
		email,
		phone,
		message,
		timestamp: new Date().toISOString(),
	};

	const webhookUrl = process.env.CONTACT_WEBHOOK_URL;
	if (webhookUrl) {
		try {
			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!response.ok) {
				return redirect("/contact?status=error", 303);
			}
		} catch {
			return redirect("/contact?status=error", 303);
		}
	} else {
		console.info("[contact] CONTACT_WEBHOOK_URL missing; received contact submission", payload);
	}

	return redirect("/contact?status=success", 303);
};
