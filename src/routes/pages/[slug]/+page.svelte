<script lang="ts">
  let { data } = $props();

  const seoTitle = $derived(data.page.seoTitle?.trim() || data.page.title);
  const seoDescription = $derived(data.page.seoDescription?.trim() || '');
  const seoKeywords = $derived(data.page.seoKeywords?.trim() || '');
  const robots = $derived(data.page.seoNoIndex ? 'noindex, nofollow' : 'index, follow');
</script>

<svelte:head>
  <title>{seoTitle}</title>
  {#if seoDescription}<meta name="description" content={seoDescription} />{/if}
  {#if seoKeywords}<meta name="keywords" content={seoKeywords} />{/if}
  <meta name="robots" content={robots} />
  <meta property="og:title" content={seoTitle} />
  {#if seoDescription}<meta property="og:description" content={seoDescription} />{/if}
  <meta property="og:type" content="website" />
</svelte:head>

<article class="content-wrap text-[var(--site-text-light)]">
  <h1 class="mb-6 text-4xl font-semibold tracking-tight">{data.page.title}</h1>
  <p class="max-w-3xl whitespace-pre-wrap text-lg leading-relaxed text-white/90">{data.page.body}</p>
</article>
