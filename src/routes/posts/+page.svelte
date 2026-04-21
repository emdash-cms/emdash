<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>Posts</title>
</svelte:head>

<div class="content-wrap">
  <h1>Posts</h1>
  <ul>
    {#each data.posts as post}
      <li><a href={`/posts/${post.slug}`}>{post.title}</a> - {post.publishedAt}</li>
    {/each}
  </ul>
</div>
