import { readCmsData } from "$lib/server/cms-store";

export async function load() {
  const cms = await readCmsData();
  return { posts: cms.posts };
}
