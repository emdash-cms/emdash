import type { ja } from './ja';

export const en: Record<keyof typeof ja, string> = {
  // Site
  'site.title': 'RGB Animation',
  'site.description': 'Anime / 3DCG / VFX Production Studio',

  // Navigation — Primary (content categories)
  'nav.film': 'Movies',
  'nav.game': 'Games',
  'nav.video': 'Videos',
  'nav.background': 'Backgrounds',
  'nav.character': 'Characters',
  'nav.tvc': 'TVCs',

  // Navigation — Secondary (corporate)
  'nav.store': 'Stores',
  'nav.recruit': 'Recruitment',
  'nav.contact': 'Contact',

  // Common
  'common.search': 'Search',
  'common.search.placeholder': 'Enter keyword...',
  'common.language': 'Language',
  'common.language.ja': 'JP',
  'common.language.en': 'EN',
  'common.scrollToTop': 'Back to Top',
  'common.loading': 'Loading...',
  'common.viewMore': 'View More',
  'common.viewDetails': 'View Details',
  'common.close': 'Close',
  'common.menu': 'Menu',
  'common.backToTop': 'TOP OF PAGE',

  // Homepage sections
  'home.hero.title': 'Coloring the World with Creative Power',
  'home.works.title': 'Works',
  'home.works.subtitle': 'Our Production',
  'home.carousel.title': 'Project Images',
  'home.carousel.subtitle': 'Project Gallery',
  'home.projects.title': 'Company Projects',
  'home.projects.subtitle': 'Original Projects',
  'home.outsourced.title': 'Outsourced Works',
  'home.outsourced.subtitle': 'Commissioned Production',

  // Footer
  'footer.sitemap': 'SITEMAP',
  'footer.company.name.ja': 'RGB Animation Inc.',
  'footer.company.name.en': 'RGB Animation Inc.',
  'footer.copyright': '© {year} RGB Animation.',
  'footer.copyright.sub': 'Copyright reserved.',
  'footer.news': 'NEWS',
  'footer.news.all': 'All',
  'footer.projects': 'PROJECTS',
  'footer.projects.all': 'All',
  'footer.projects.movies': 'Movies',
  'footer.projects.videos': 'Videos',
  'footer.company': 'COMPANY',
  'footer.company.info': 'Company Information',
  'footer.contact': 'CONTACT',
  'footer.contact.us': 'Contact Us',
  'footer.recruit': 'RECRUITMENT',
  'footer.privacy': 'PRIVACY POLICY',

  // 404
  'error.404.title': 'Page Not Found',
  'error.404.back': 'Back to Home',
};
