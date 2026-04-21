<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>{data.post.title}</title>
</svelte:head>

<article class="content-wrap">
  <h1>{data.post.title}</h1>
  <p>{data.post.publishedAt}</p>
  <p>{data.post.body}</p>
</article>
