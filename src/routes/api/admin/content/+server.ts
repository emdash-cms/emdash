import { json } from "@sveltejs/kit";
import type { CmsData } from "$lib/cms-schema";

import { readCmsData, writeCmsData } from "$lib/server/cms-store";

export async function GET() {
  return json(await readCmsData());
}

export async function PUT({ request }) {
  const payload = (await request.json()) as CmsData;

  if (!Array.isArray(payload.site?.hours) || payload.site.hours.length < 7) {
    return json({ ok: false, error: "Hours must include at least 7 days." }, { status: 400 });
  }

  for (const post of payload.posts ?? []) {
    if (!post.bannerEnabled) continue;

    if (!post.bannerStartDate || !post.bannerEndDate) {
      return json(
        { ok: false, error: `Banner dates are required for "${post.title || post.slug}".` },
        { status: 400 },
      );
    }

    if (post.bannerEndDate < post.bannerStartDate) {
      return json(
        {
          ok: false,
          error: `Banner end date must be on or after start date for "${post.title || post.slug}".`,
        },
        { status: 400 },
      );
    }
  }

  await writeCmsData(payload);
  return json({ ok: true });
}
