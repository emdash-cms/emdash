import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  defaultCmsData,
  defaultWeeklyHours,
  type BusinessHoursEntry,
  type CmsData,
  type Page,
  type Post,
} from "$lib/cms-schema";

const cmsPath = resolve(process.cwd(), "data", "cms.json");

function normalizeHours(value: unknown): BusinessHoursEntry[] {
  if (!Array.isArray(value)) {
    return defaultWeeklyHours.map((entry) => ({ ...entry }));
  }

  const parsed = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Partial<BusinessHoursEntry>;
      return {
        label: typeof row.label === "string" ? row.label : "Day",
        opens: typeof row.opens === "string" ? row.opens : "",
        closes: typeof row.closes === "string" ? row.closes : "",
        closed: Boolean(row.closed),
      };
    })
    .filter((entry): entry is BusinessHoursEntry => entry !== null);

  const fallback = defaultWeeklyHours.map((entry) => ({ ...entry }));

  if (parsed.length >= 7) {
    return parsed;
  }

  return [...parsed, ...fallback.slice(parsed.length)];
}

function normalizePosts(value: unknown): Post[] {
  if (!Array.isArray(value)) return [...defaultCmsData.posts];

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const post = entry as Partial<Post>;

      return {
        slug: typeof post.slug === "string" ? post.slug : `post-${Date.now()}`,
        title: typeof post.title === "string" ? post.title : "Untitled",
        excerpt: typeof post.excerpt === "string" ? post.excerpt : "",
        publishedAt:
          typeof post.publishedAt === "string"
            ? post.publishedAt
            : new Date().toISOString().slice(0, 10),
        body: typeof post.body === "string" ? post.body : "",
        seoTitle: typeof post.seoTitle === "string" ? post.seoTitle : "",
        seoDescription: typeof post.seoDescription === "string" ? post.seoDescription : "",
        seoKeywords: typeof post.seoKeywords === "string" ? post.seoKeywords : "",
        seoNoIndex: Boolean(post.seoNoIndex),
        bannerEnabled: Boolean(post.bannerEnabled),
        bannerStartDate: typeof post.bannerStartDate === "string" ? post.bannerStartDate : "",
        bannerEndDate: typeof post.bannerEndDate === "string" ? post.bannerEndDate : "",
      };
    })
    .filter((entry): entry is Post => entry !== null);
}

function normalizePages(value: unknown): Page[] {
  if (!Array.isArray(value)) return [...defaultCmsData.pages];

  const parsed = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const page = entry as Partial<Page>;
      if (typeof page.slug !== "string" || typeof page.title !== "string") return null;

      return {
        slug: page.slug,
        title: page.title,
        body: typeof page.body === "string" ? page.body : "",
        seoTitle: typeof page.seoTitle === "string" ? page.seoTitle : "",
        seoDescription: typeof page.seoDescription === "string" ? page.seoDescription : "",
        seoKeywords: typeof page.seoKeywords === "string" ? page.seoKeywords : "",
        seoNoIndex: Boolean(page.seoNoIndex),
      };
    })
    .filter((entry): entry is Page => entry !== null);

  return parsed.length > 0 ? parsed : [...defaultCmsData.pages];
}

function normalizeCmsData(raw: unknown): CmsData {
  if (!raw || typeof raw !== "object") {
    return structuredClone(defaultCmsData);
  }

  const data = raw as Partial<CmsData>;
  const site = (data.site ?? {}) as Record<string, unknown>;

  return {
    site: {
      title: typeof site.title === "string" ? site.title : defaultCmsData.site.title,
      tagline: typeof site.tagline === "string" ? site.tagline : defaultCmsData.site.tagline,
      phone: typeof site.phone === "string" ? site.phone : defaultCmsData.site.phone,
      email: typeof site.email === "string" ? site.email : defaultCmsData.site.email,
      address: typeof site.address === "string" ? site.address : defaultCmsData.site.address,
      hours: normalizeHours(site.hours),
      facebookUrl:
        typeof site.facebookUrl === "string" ? site.facebookUrl : defaultCmsData.site.facebookUrl,
      instagramUrl:
        typeof site.instagramUrl === "string"
          ? site.instagramUrl
          : defaultCmsData.site.instagramUrl,
    },
    posts: normalizePosts(data.posts),
    pages: normalizePages(data.pages),
  };
}

export async function readCmsData(): Promise<CmsData> {
  try {
    const raw = await readFile(cmsPath, "utf8");
    return normalizeCmsData(JSON.parse(raw));
  } catch {
    return structuredClone(defaultCmsData);
  }
}

export async function writeCmsData(data: CmsData): Promise<void> {
  await mkdir(dirname(cmsPath), { recursive: true });
  await writeFile(cmsPath, JSON.stringify(normalizeCmsData(data), null, 2), "utf8");
}
