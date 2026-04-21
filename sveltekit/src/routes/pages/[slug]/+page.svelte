<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>{data.page.title}</title>
</svelte:head>

<article class="content-wrap">
  <h1>{data.page.title}</h1>
  <p>{data.page.body}</p>
</article>
