<script lang="ts">
  import { onMount } from 'svelte';
  import type { CmsData } from '$lib/cms-schema';

  type AdminView = 'dashboard' | 'site' | 'posts' | 'pages';

  let draft: CmsData | null = null;
  let saving = false;
  let status = '';
  let view: AdminView = 'dashboard';
  let selectedPostIndex = 0;
  let selectedPageIndex = 0;
  let darkMode = false;

  async function loadContent() {
    const response = await fetch('/api/admin/content');
    draft = (await response.json()) as CmsData;
    selectedPostIndex = 0;
    selectedPageIndex = 0;
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
    status = response.ok ? 'All changes saved.' : 'Save failed. Try again.';
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
    selectedPostIndex = draft.posts.length - 1;
    view = 'posts';
  }

  function addPage() {
    if (!draft) return;

    draft.pages = [...draft.pages, { slug: `page-${Date.now()}`, title: 'New Page', body: '' }];
    selectedPageIndex = draft.pages.length - 1;
    view = 'pages';
  }

  function removePost(index: number) {
    if (!draft) return;

    draft.posts = draft.posts.filter((_, i) => i !== index);
    selectedPostIndex = Math.max(0, Math.min(selectedPostIndex, draft.posts.length - 1));
  }

  function removePage(index: number) {
    if (!draft) return;

    draft.pages = draft.pages.filter((_, i) => i !== index);
    selectedPageIndex = Math.max(0, Math.min(selectedPageIndex, draft.pages.length - 1));
  }

  onMount(loadContent);
</script>

<svelte:head>
  <title>Admin</title>
</svelte:head>

{#if !draft}
  <div class="content-wrap"><p>Loading admin...</p></div>
{:else}
  <div class="admin-shell" class:dark={darkMode}>
    <header class="chrome-bar">
      <div class="chrome-left">
        <strong>Symballo CMS</strong>
        <a href="/" target="_blank" rel="noreferrer">View Site</a>
      </div>
      <div class="chrome-right">
        <button class="mode-toggle" on:click={() => (darkMode = !darkMode)}>
          {darkMode ? 'Light' : 'Dark'} Mode
        </button>
        <button class="save top-save" on:click={saveContent} disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button>
      </div>
    </header>

    <aside class="sidebar">
      <div class="brand">
        <p class="brand-kicker">Symballo</p>
        <strong>Site Admin</strong>
      </div>

      <nav class="nav">
        <button class:active={view === 'dashboard'} on:click={() => (view = 'dashboard')}>Dashboard</button>
        <button class:active={view === 'site'} on:click={() => (view = 'site')}>Site Details</button>
        <button class:active={view === 'posts'} on:click={() => (view = 'posts')}>Posts</button>
        <button class:active={view === 'pages'} on:click={() => (view = 'pages')}>Pages</button>
      </nav>

      <div class="sidebar-actions">
        <button on:click={addPost}>+ New Post</button>
        <button on:click={addPage}>+ New Page</button>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar panel">
        <div>
          <h1>Dashboard</h1>
          <p>Manage business details, pages, and posts from one place.</p>
        </div>
        <div class="topbar-actions">
          {#if status}<span class="status">{status}</span>{/if}
          <button class="save" on:click={saveContent} disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button>
        </div>
      </header>

      {#if view === 'dashboard'}
        <section class="panel dashboard-grid">
          <article class="stat-card">
            <p>Total Posts</p>
            <strong>{draft.posts.length}</strong>
          </article>
          <article class="stat-card">
            <p>Total Pages</p>
            <strong>{draft.pages.length}</strong>
          </article>
          <article class="stat-card">
            <p>Business Name</p>
            <strong>{draft.site.title}</strong>
          </article>
          <article class="stat-card">
            <p>Primary Contact</p>
            <strong>{draft.site.email}</strong>
          </article>
        </section>

        <section class="panel quick-actions">
          <h2>Quick Actions</h2>
          <div class="quick-grid">
            <button on:click={() => (view = 'site')}>Edit Site Details</button>
            <button on:click={() => (view = 'posts')}>Manage Posts</button>
            <button on:click={() => (view = 'pages')}>Manage Pages</button>
          </div>
        </section>
      {/if}

      {#if view === 'site'}
        <section class="panel">
          <h2>Site Details</h2>
          <div class="form-grid">
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
      {/if}

      {#if view === 'posts'}
        <section class="panel split-layout">
          <div class="list-pane">
            <div class="pane-head">
              <h2>Posts</h2>
              <button on:click={addPost}>+ Add</button>
            </div>
            <ul class="item-list">
              {#each draft.posts as post, i}
                <li>
                  <button class="item-row" class:selected={selectedPostIndex === i} on:click={() => (selectedPostIndex = i)}>
                    <span>{post.title || 'Untitled'}</span>
                    <small>{post.slug}</small>
                  </button>
                </li>
              {/each}
            </ul>
          </div>

          <div class="editor-pane">
            {#if draft.posts.length === 0}
              <p>No posts yet. Add one to begin.</p>
            {:else}
              {@const post = draft.posts[selectedPostIndex]}
              <div class="pane-head">
                <h3>Edit Post</h3>
                <button class="danger" on:click={() => removePost(selectedPostIndex)}>Delete</button>
              </div>
              <div class="form-grid">
                <label>Slug<input bind:value={post.slug} /></label>
                <label>Title<input bind:value={post.title} /></label>
                <label>Date<input type="date" bind:value={post.publishedAt} /></label>
                <label>Excerpt<input bind:value={post.excerpt} /></label>
              </div>
              <label>Body<textarea class="large" bind:value={post.body}></textarea></label>
            {/if}
          </div>
        </section>
      {/if}

      {#if view === 'pages'}
        <section class="panel split-layout">
          <div class="list-pane">
            <div class="pane-head">
              <h2>Pages</h2>
              <button on:click={addPage}>+ Add</button>
            </div>
            <ul class="item-list">
              {#each draft.pages as page, i}
                <li>
                  <button class="item-row" class:selected={selectedPageIndex === i} on:click={() => (selectedPageIndex = i)}>
                    <span>{page.title || 'Untitled'}</span>
                    <small>{page.slug}</small>
                  </button>
                </li>
              {/each}
            </ul>
          </div>

          <div class="editor-pane">
            {#if draft.pages.length === 0}
              <p>No pages yet. Add one to begin.</p>
            {:else}
              {@const page = draft.pages[selectedPageIndex]}
              <div class="pane-head">
                <h3>Edit Page</h3>
                <button class="danger" on:click={() => removePage(selectedPageIndex)}>Delete</button>
              </div>
              <div class="form-grid">
                <label>Slug<input bind:value={page.slug} /></label>
                <label>Title<input bind:value={page.title} /></label>
              </div>
              <label>Body<textarea class="large" bind:value={page.body}></textarea></label>
            {/if}
          </div>
        </section>
      {/if}
    </main>
  </div>
{/if}

<style>
  .admin-shell {
    display: grid;
    grid-template-columns: 240px 1fr;
    grid-template-rows: 56px 1fr;
    min-height: 100vh;
    background: #eef2f8;
    color: #5a6b84;
    --chrome-bg: linear-gradient(90deg, #2f5ea9, #3b6ab2);
    --sidebar-bg: #ffffff;
    --sidebar-border: #d8deea;
    --panel-bg: #f8fbff;
    --panel-border: #dbe3f0;
    --text-strong: #6a7f98;
    --text-soft: #8ca0b8;
    --btn-bg: #3f6fd3;
    --btn-border: #3f6fd3;
    --btn-text: #ffffff;
    --active-nav-bg: #e9f0ff;
    --active-nav-border: #bfd0f6;
    --field-bg: #ffffff;
    --field-border: #cad6eb;
    --field-text: #4e5f77;
  }

  .admin-shell.dark {
    background: #0f141c;
    color: #e8edf6;
    --chrome-bg: linear-gradient(90deg, #25467e, #274d8b);
    --sidebar-bg: #111923;
    --sidebar-border: #283142;
    --panel-bg: #131b27;
    --panel-border: #2a3447;
    --text-strong: #d6deec;
    --text-soft: #9fb0cb;
    --btn-bg: #c56642;
    --btn-border: #c56642;
    --btn-text: #ffffff;
    --active-nav-bg: #1a2433;
    --active-nav-border: #3a4b69;
    --field-bg: #0d1420;
    --field-border: #35445e;
    --field-text: #e8edf6;
  }

  .chrome-bar {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 1rem;
    background: var(--chrome-bg);
    color: #eef4ff;
  }

  .chrome-left,
  .chrome-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .chrome-left a {
    color: #eef4ff;
    text-decoration: none;
    font-size: 0.9rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.35);
  }

  .mode-toggle {
    border: 1px solid rgba(255, 255, 255, 0.45);
    background: transparent;
    color: #fff;
    border-radius: 999px;
    padding: 0.35rem 0.7rem;
    font-size: 0.8rem;
  }

  .top-save {
    font-size: 0.85rem;
    padding: 0.45rem 0.75rem;
  }

  .sidebar {
    border-right: 1px solid var(--sidebar-border);
    background: var(--sidebar-bg);
    padding: 1rem;
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: 1rem;
  }

  .brand-kicker {
    margin: 0;
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-soft);
  }

  .brand strong {
    font-size: 1.1rem;
    color: var(--text-strong);
  }

  .nav {
    display: grid;
    gap: 0.35rem;
  }

  .nav button {
    text-align: left;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-strong);
    padding: 0.55rem 0.65rem;
    border-radius: 6px;
  }

  .nav button:hover,
  .nav button.active {
    border-color: var(--active-nav-border);
    background: var(--active-nav-bg);
  }

  .sidebar-actions {
    display: grid;
    gap: 0.55rem;
  }

  .sidebar-actions button {
    border: 1px solid var(--btn-border);
    background: transparent;
    color: var(--text-strong);
    border-radius: 6px;
    padding: 0.5rem;
  }

  .workspace {
    padding: 1.25rem;
    display: grid;
    gap: 1rem;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
    padding: 1rem 1.15rem;
  }

  .topbar h1 {
    margin: 0;
    font-size: 2rem;
    font-weight: 500;
    color: var(--text-strong);
  }

  .topbar p {
    margin: 0.2rem 0 0;
    color: var(--text-soft);
    font-size: 0.88rem;
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }

  .status {
    font-size: 0.85rem;
    color: #4bbf87;
  }

  .save {
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--btn-text);
    border-radius: 6px;
    padding: 0.55rem 0.9rem;
  }

  .panel {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 1rem;
  }

  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.8rem;
  }

  .stat-card {
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 0.85rem;
    background: rgba(255, 255, 255, 0.35);
    min-height: 150px;
    display: grid;
    align-content: center;
    justify-items: center;
    text-align: center;
  }

  .stat-card p {
    margin: 0;
    color: var(--text-soft);
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .stat-card strong {
    display: block;
    margin-top: 0.35rem;
    font-size: 2.3rem;
    color: #3f6fd3;
  }

  .quick-actions h2,
  .panel h2 {
    margin-top: 0;
  }

  .quick-grid {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .quick-grid button,
  .pane-head button,
  .editor-pane button {
    border: 1px solid var(--panel-border);
    background: transparent;
    color: var(--text-strong);
    border-radius: 6px;
    padding: 0.45rem 0.7rem;
  }

  .split-layout {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 1rem;
  }

  .list-pane {
    border-right: 1px solid var(--panel-border);
    padding-right: 1rem;
  }

  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.7rem;
  }

  .pane-head h2,
  .pane-head h3 {
    margin: 0;
  }

  .item-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.4rem;
  }

  .item-row {
    width: 100%;
    text-align: left;
    display: grid;
    gap: 0.1rem;
    border: 1px solid var(--field-border);
    background: var(--field-bg);
    color: var(--field-text);
    border-radius: 7px;
    padding: 0.55rem 0.65rem;
  }

  .item-row small {
    color: var(--text-soft);
  }

  .item-row.selected,
  .item-row:hover {
    border-color: #8ea8d9;
    background: var(--active-nav-bg);
  }

  .editor-pane {
    display: grid;
    gap: 0.8rem;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.9rem;
    color: var(--text-strong);
  }

  input,
  textarea {
    width: 100%;
    border: 1px solid var(--field-border);
    background: var(--field-bg);
    color: var(--field-text);
    border-radius: 6px;
    padding: 0.6rem 0.65rem;
  }

  textarea {
    min-height: 5.8rem;
    resize: vertical;
  }

  textarea.large {
    min-height: 15rem;
  }

  .danger {
    border-color: #c96f6f;
    color: #b04747;
    background: #fff5f5;
  }

  @media (max-width: 1080px) {
    .dashboard-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .split-layout {
      grid-template-columns: 1fr;
    }

    .list-pane {
      border-right: 0;
      border-bottom: 1px solid #2b3344;
      padding-right: 0;
      padding-bottom: 1rem;
    }
  }

  @media (max-width: 840px) {
    .admin-shell {
      grid-template-columns: 1fr;
      grid-template-rows: auto auto 1fr;
    }

    .sidebar {
      border-right: 0;
      border-bottom: 1px solid var(--sidebar-border);
    }

    .form-grid {
      grid-template-columns: 1fr;
    }

    .topbar {
      flex-direction: column;
      align-items: flex-start;
    }

    .chrome-bar {
      flex-direction: column;
      align-items: flex-start;
      padding: 0.65rem 0.9rem;
      gap: 0.45rem;
    }
  }
</style>
