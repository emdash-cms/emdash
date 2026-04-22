<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';

  import '../styles.css';

  let { data, children } = $props();
  let dismissed = false;

  const banner = $derived(data.banner);
  const bannerStorageKey = $derived(
    banner ? `symballo:banner:${banner.slug}:${banner.startDate}:${banner.endDate}` : ''
  );
  const inAdmin = $derived(page.url.pathname.startsWith('/admin'));
  const showBanner = $derived(Boolean(banner) && !dismissed && !inAdmin);

  onMount(() => {
    if (!bannerStorageKey) return;
    dismissed = localStorage.getItem(bannerStorageKey) === '1';
  });

  function dismissBanner() {
    if (!bannerStorageKey) return;
    dismissed = true;
    localStorage.setItem(bannerStorageKey, '1');
  }
</script>

{#if showBanner && banner}
  <aside class="site-banner" role="status" aria-live="polite">
    <a class="banner-link" href={`/posts/${banner.slug}`}>
      <strong>{banner.title}</strong>
      {#if banner.excerpt}<span>{banner.excerpt}</span>{/if}
    </a>
    <button class="banner-close" onclick={dismissBanner} aria-label="Dismiss banner">Dismiss</button>
  </aside>
{/if}

{@render children()}

<style>
  .site-banner {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.7rem 1rem;
    background: #1d5fd0;
    color: #f4f8ff;
    border-bottom: 1px solid rgba(255, 255, 255, 0.25);
  }

  .banner-link {
    color: inherit;
    text-decoration: none;
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    flex-wrap: wrap;
  }

  .banner-link span {
    opacity: 0.9;
    font-size: 0.92rem;
  }

  .banner-close {
    border: 1px solid rgba(255, 255, 255, 0.45);
    background: transparent;
    color: #fff;
    border-radius: 6px;
    padding: 0.35rem 0.6rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  @media (max-width: 680px) {
    .site-banner {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
