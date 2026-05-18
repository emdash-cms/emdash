import { error } from "@sveltejs/kit";

import { readCmsData } from "$lib/server/cms-store";

export async function load({ params }) {
  const cms = await readCmsData();
  const page = cms.pages.find((entry) => entry.slug === params.slug);

  if (!page) {
    throw error(404, "Page not found");
  }

  return { page };
}
