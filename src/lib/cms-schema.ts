export type SiteSettings = {
  title: string;
  tagline: string;
  phone: string;
  email: string;
  address: string;
  hours: string;
  facebookUrl: string;
  instagramUrl: string;
};

export type Post = {
  slug: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  body: string;
};

export type Page = {
  slug: string;
  title: string;
  body: string;
};

export type CmsData = {
  site: SiteSettings;
  posts: Post[];
  pages: Page[];
};

export const defaultCmsData: CmsData = {
  site: {
    title: 'Symballo Brasserie',
    tagline: 'Regional ingredients. Memorable evenings.',
    phone: '(555) 123-4567',
    email: 'hello@symballo.agency',
    address: '123 Main Street, Your Town, ST 00000',
    hours: 'Mon-Thu: 11:00 AM - 9:00 PM\\nFri-Sat: 11:00 AM - 10:00 PM\\nSun: 10:00 AM - 8:00 PM',
    facebookUrl: 'https://facebook.com',
    instagramUrl: 'https://instagram.com'
  },
  posts: [
    {
      slug: 'welcome',
      title: 'Welcome to Symballo Brasserie',
      excerpt: 'A quick intro to the template and how to update it.',
      publishedAt: '2026-04-21',
      body: 'Replace this post content with your business updates, events, or announcements.'
    }
  ],
  pages: [
    {
      slug: 'contact',
      title: 'Contact',
      body: 'Add your booking details, map, and contact form instructions here.'
    }
  ]
};
