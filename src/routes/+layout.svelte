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
  <aside
    class="sticky top-0 z-50 flex flex-col gap-2 border-b border-white/25 bg-[#1d5fd0] px-4 py-3 text-[#f4f8ff] sm:flex-row sm:items-center sm:justify-between"
    role="status"
    aria-live="polite"
  >
    <a class="flex flex-wrap items-baseline gap-2 no-underline" href={`/posts/${banner.slug}`}>
      <strong>{banner.title}</strong>
      {#if banner.excerpt}<span class="text-sm opacity-90">{banner.excerpt}</span>{/if}
    </a>
    <button
      class="inline-flex items-center rounded-md border border-white/45 bg-transparent px-2.5 py-1 text-xs uppercase tracking-[0.04em] text-white"
      onclick={dismissBanner}
      aria-label="Dismiss banner"
    >
      Dismiss
    </button>
  </aside>
{/if}

{@render children()}
