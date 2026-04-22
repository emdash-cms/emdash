import { readCmsData } from '$lib/server/cms-store';

function dateAtStart(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function dateAtEnd(value: string): Date {
  return new Date(`${value}T23:59:59`);
}

export async function load() {
  const cms = await readCmsData();
  const now = new Date();

  const bannerPost = cms.posts.find((post) => {
    if (!post.bannerEnabled || !post.bannerStartDate || !post.bannerEndDate) return false;
    const start = dateAtStart(post.bannerStartDate);
    const end = dateAtEnd(post.bannerEndDate);
    return start <= now && now <= end;
  });

  return {
    banner: bannerPost
      ? {
          slug: bannerPost.slug,
          title: bannerPost.title,
          excerpt: bannerPost.excerpt,
          startDate: bannerPost.bannerStartDate,
          endDate: bannerPost.bannerEndDate
        }
      : null
  };
}
