import { error } from '@sveltejs/kit';
import { pages } from '$lib/content';

export function load({ params }) {
  const page = pages.find((entry) => entry.slug === params.slug);

  if (!page) {
    throw error(404, 'Page not found');
  }

  return { page };
}
