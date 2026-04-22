export type BusinessHoursEntry = {
  label: string;
  opens: string;
  closes: string;
  closed: boolean;
};

export type SiteSettings = {
  title: string;
  tagline: string;
  phone: string;
  email: string;
  address: string;
  hours: BusinessHoursEntry[];
  facebookUrl: string;
  instagramUrl: string;
};

export type Post = {
  slug: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  body: string;
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string;
  seoNoIndex: boolean;
  bannerEnabled: boolean;
  bannerStartDate: string;
  bannerEndDate: string;
};

export type Page = {
  slug: string;
  title: string;
  body: string;
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string;
  seoNoIndex: boolean;
};

export type CmsData = {
  site: SiteSettings;
  posts: Post[];
  pages: Page[];
};

export const defaultWeeklyHours: BusinessHoursEntry[] = [
  { label: 'Monday', opens: '11:00', closes: '21:00', closed: false },
  { label: 'Tuesday', opens: '11:00', closes: '21:00', closed: false },
  { label: 'Wednesday', opens: '11:00', closes: '21:00', closed: false },
  { label: 'Thursday', opens: '11:00', closes: '21:00', closed: false },
  { label: 'Friday', opens: '11:00', closes: '22:00', closed: false },
  { label: 'Saturday', opens: '11:00', closes: '22:00', closed: false },
  { label: 'Sunday', opens: '10:00', closes: '20:00', closed: false }
];

export const defaultCmsData: CmsData = {
  site: {
    title: 'Symballo Brasserie',
    tagline: 'Regional ingredients. Memorable evenings.',
    phone: '(555) 123-4567',
    email: 'hello@symballo.agency',
    address: '123 Main Street, Your Town, ST 00000',
    hours: defaultWeeklyHours,
    facebookUrl: 'https://facebook.com',
    instagramUrl: 'https://instagram.com'
  },
  posts: [
    {
      slug: 'welcome',
      title: 'Welcome to Symballo Brasserie',
      excerpt: 'A quick intro to the template and how to update it.',
      publishedAt: '2026-04-21',
      body: 'Replace this post content with your business updates, events, or announcements.',
      seoTitle: 'Welcome to Symballo Brasserie',
      seoDescription: 'A quick intro to the template and how to update it.',
      seoKeywords: 'local business, brasserie, restaurant',
      seoNoIndex: false,
      bannerEnabled: false,
      bannerStartDate: '',
      bannerEndDate: ''
    }
  ],
  pages: [
    {
      slug: 'contact',
      title: 'Contact',
      body: 'Add your booking details, map, and contact form instructions here.',
      seoTitle: 'Contact',
      seoDescription: 'Get in touch and plan your next visit.',
      seoKeywords: 'contact, reservations, location',
      seoNoIndex: false
    }
  ]
};
