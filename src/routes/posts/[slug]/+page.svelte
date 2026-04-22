<script lang="ts">
  let { data } = $props();

  const seoTitle = $derived(data.post.seoTitle?.trim() || data.post.title);
  const seoDescription = $derived(data.post.seoDescription?.trim() || data.post.excerpt || '');
  const seoKeywords = $derived(data.post.seoKeywords?.trim() || '');
  const robots = $derived(data.post.seoNoIndex ? 'noindex, nofollow' : 'index, follow');
</script>

<svelte:head>
  <title>{seoTitle}</title>
  {#if seoDescription}<meta name="description" content={seoDescription} />{/if}
  {#if seoKeywords}<meta name="keywords" content={seoKeywords} />{/if}
  <meta name="robots" content={robots} />
  <meta property="og:title" content={seoTitle} />
  {#if seoDescription}<meta property="og:description" content={seoDescription} />{/if}
  <meta property="og:type" content="article" />
</svelte:head>

<article class="content-wrap text-[var(--site-text-light)]">
  <h1 class="mb-2 text-4xl font-semibold tracking-tight">{data.post.title}</h1>
  <p class="mb-8 text-sm uppercase tracking-[0.12em] text-white/60">{data.post.publishedAt}</p>
  <p class="max-w-3xl whitespace-pre-wrap text-lg leading-relaxed text-white/90">{data.post.body}</p>
</article>
