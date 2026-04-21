import { error } from '@sveltejs/kit';
import { posts } from '$lib/content';

export function load({ params }) {
  const post = posts.find((entry) => entry.slug === params.slug);

  if (!post) {
    throw error(404, 'Post not found');
  }

  return { post };
}
