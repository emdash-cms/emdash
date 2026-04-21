<script lang="ts">
  import { onMount } from 'svelte';
  import type { CmsData } from '$lib/cms-schema';

  let draft: CmsData | null = null;
  let saving = false;
  let status = '';

  async function loadContent() {
    const response = await fetch('/api/admin/content');
    draft = (await response.json()) as CmsData;
  }

  async function saveContent() {
    if (!draft) return;
    saving = true;
    status = '';

    const response = await fetch('/api/admin/content', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft)
    });

    saving = false;
    status = response.ok ? 'Saved.' : 'Save failed.';
  }

  function addPost() {
    if (!draft) return;
    draft.posts = [
      ...draft.posts,
      {
        slug: `post-${Date.now()}`,
        title: 'New Post',
        excerpt: '',
        publishedAt: new Date().toISOString().slice(0, 10),
        body: ''
      }
    ];
  }

  function addPage() {
    if (!draft) return;
    draft.pages = [...draft.pages, { slug: `page-${Date.now()}`, title: 'New Page', body: '' }];
  }

  function removePost(index: number) {
    if (!draft) return;
    draft.posts = draft.posts.filter((_, i) => i !== index);
  }

  function removePage(index: number) {
    if (!draft) return;
    draft.pages = draft.pages.filter((_, i) => i !== index);
  }

  onMount(loadContent);
</script>

<svelte:head>
  <title>Admin</title>
</svelte:head>

{#if !draft}
  <div class="content-wrap"><p>Loading admin...</p></div>
{:else}
  <div class="admin-wrap">
    <div class="admin-header">
      <h1>Symballo Admin</h1>
      <button class="save" on:click={saveContent} disabled={saving}>{saving ? 'Saving...' : 'Save All Changes'}</button>
    </div>
    {#if status}<p class="status">{status}</p>{/if}

    <section class="panel">
      <h2>Site Details</h2>
      <div class="grid two">
        <label>Business Name<input bind:value={draft.site.title} /></label>
        <label>Tagline<input bind:value={draft.site.tagline} /></label>
        <label>Phone<input bind:value={draft.site.phone} /></label>
        <label>Email<input bind:value={draft.site.email} /></label>
        <label>Address<input bind:value={draft.site.address} /></label>
        <label>Hours<textarea bind:value={draft.site.hours}></textarea></label>
        <label>Facebook URL<input bind:value={draft.site.facebookUrl} /></label>
        <label>Instagram URL<input bind:value={draft.site.instagramUrl} /></label>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Posts</h2>
        <button on:click={addPost}>Add Post</button>
      </div>
      {#each draft.posts as post, i}
        <div class="card">
          <div class="card-head">
            <strong>Post {i + 1}</strong>
            <button class="danger" on:click={() => removePost(i)}>Delete</button>
          </div>
          <div class="grid two">
            <label>Slug<input bind:value={post.slug} /></label>
            <label>Title<input bind:value={post.title} /></label>
            <label>Published At<input type="date" bind:value={post.publishedAt} /></label>
            <label>Excerpt<input bind:value={post.excerpt} /></label>
          </div>
          <label>Body<textarea bind:value={post.body}></textarea></label>
        </div>
      {/each}
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Pages</h2>
        <button on:click={addPage}>Add Page</button>
      </div>
      {#each draft.pages as page, i}
        <div class="card">
          <div class="card-head">
            <strong>Page {i + 1}</strong>
            <button class="danger" on:click={() => removePage(i)}>Delete</button>
          </div>
          <div class="grid two">
            <label>Slug<input bind:value={page.slug} /></label>
            <label>Title<input bind:value={page.title} /></label>
          </div>
          <label>Body<textarea bind:value={page.body}></textarea></label>
        </div>
      {/each}
    </section>
  </div>
{/if}

<style>
  .admin-wrap { max-width: 1100px; margin: 0 auto; padding: 2rem 1rem 4rem; }
  .admin-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .panel { background: #11161e; border: 1px solid #2b3342; padding: 1rem; margin-top: 1rem; }
  .panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.8rem; }
  .grid { display: grid; gap: 0.75rem; }
  .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  label { display: grid; gap: 0.35rem; font-size: 0.9rem; }
  input, textarea { width: 100%; padding: 0.6rem; border: 1px solid #3a4150; background: #0a0f15; color: #e8edf6; }
  textarea { min-height: 5rem; resize: vertical; }
  .card { border: 1px solid #2a313f; padding: 0.8rem; margin-top: 0.8rem; }
  .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.7rem; }
  button { border: 1px solid #c56642; background: transparent; color: #f0f4fb; padding: 0.45rem 0.7rem; }
  .save { background: #c56642; color: #fff; }
  .danger { border-color: #a24343; color: #ffb3b3; }
  .status { color: #8dd99b; }
  @media (max-width: 840px) { .grid.two { grid-template-columns: 1fr; } }
</style>
