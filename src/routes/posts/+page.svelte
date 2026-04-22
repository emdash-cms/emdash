<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>Posts</title>
</svelte:head>

<div class="content-wrap text-[var(--site-text-light)]">
  <h1 class="mb-6 text-3xl font-semibold tracking-tight">Posts</h1>
  <ul class="grid gap-3">
    {#each data.posts as post}
      <li class="rounded-lg border border-white/15 bg-white/5 px-4 py-3">
        <a class="text-lg font-medium hover:text-[var(--site-accent)]" href={`/posts/${post.slug}`}>{post.title}</a>
        <p class="mt-1 text-sm text-white/70">{post.publishedAt}</p>
      </li>
    {/each}
  </ul>
</div>
