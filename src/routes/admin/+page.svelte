<script lang="ts">
  import { onMount } from 'svelte';
  import type { CmsData } from '$lib/cms-schema';

  type AdminView = 'dashboard' | 'site' | 'posts' | 'pages';

  let draft = $state<CmsData | null>(null);
  let saving = $state(false);
  let status = $state('');
  let view = $state<AdminView>('dashboard');
  let selectedPostIndex = $state(0);
  let selectedPageIndex = $state(0);
  let darkMode = $state(false);
  const editorTabs = ['Basic info', 'Author', 'Publisher', 'Files', 'More info'];

  async function loadContent() {
    const response = await fetch('/api/admin/content');
    draft = (await response.json()) as CmsData;
    selectedPostIndex = 0;
    selectedPageIndex = 0;
  }

  async function saveContent() {
    if (!draft) return;
    const invalidBannerPost = draft.posts.find(
      (post) => post.bannerEnabled && (!post.bannerStartDate || !post.bannerEndDate)
    );

    if (invalidBannerPost) {
      status = `Banner dates are required for "${invalidBannerPost.title || invalidBannerPost.slug}".`;
      return;
    }

    const badDateRangePost = draft.posts.find(
      (post) => post.bannerEnabled && post.bannerStartDate && post.bannerEndDate && post.bannerEndDate < post.bannerStartDate
    );

    if (badDateRangePost) {
      status = `Banner end date must be on or after start date for "${badDateRangePost.title || badDateRangePost.slug}".`;
      return;
    }

    saving = true;
    status = '';

    const response = await fetch('/api/admin/content', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft)
    });

    saving = false;
    if (response.ok) {
      status = 'All changes saved.';
    } else {
      const body = (await response.json()) as { error?: string };
      status = body.error || 'Save failed. Try again.';
    }
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
        body: '',
        bannerEnabled: false,
        bannerStartDate: '',
        bannerEndDate: ''
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

  function addHoursRow() {
    if (!draft) return;
    draft.site.hours = [...draft.site.hours, { label: 'Holiday', opens: '11:00', closes: '17:00', closed: false }];
  }

  function removeHoursRow(index: number) {
    if (!draft) return;
    if (draft.site.hours.length <= 7) return;
    draft.site.hours = draft.site.hours.filter((_, i) => i !== index);
  }

  onMount(loadContent);

  const currentEntityTitle = $derived.by(() => {
    if (!draft) return 'Content';
    if (view === 'posts' && draft.posts[selectedPostIndex]) return draft.posts[selectedPostIndex].title || 'Untitled post';
    if (view === 'pages' && draft.pages[selectedPageIndex]) return draft.pages[selectedPageIndex].title || 'Untitled page';
    if (view === 'site') return draft.site.title || 'Site settings';
    return 'Dashboard';
  });

  const currentEntityMeta = $derived.by(() => {
    if (!draft) return '';
    if (view === 'posts' && draft.posts[selectedPostIndex]) {
      const post = draft.posts[selectedPostIndex];
      return `${post.slug} | ${post.publishedAt}`;
    }
    if (view === 'pages' && draft.pages[selectedPageIndex]) {
      const page = draft.pages[selectedPageIndex];
      return `${page.slug} | Page`;
    }
    if (view === 'site') return 'Business profile';
    return 'Overview';
  });
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
        <button class="icon-btn" aria-label="Toggle navigation">☰</button>
        <label class="search-pill">
          <span>◌</span>
          <input type="text" placeholder="Search" />
        </label>
      </div>
      <div class="chrome-right">
        <button class="pill ghost">Guide</button>
        <button class="pill ghost">Support</button>
        <a class="view-site-link" href="/" target="_blank" rel="noreferrer">Open site</a>
        <button class="mode-toggle" onclick={() => (darkMode = !darkMode)}>
          {darkMode ? 'Light' : 'Dark'} Mode
        </button>
        <button class="pill save top-save" onclick={saveContent} disabled={saving}>{saving ? 'Saving...' : 'Publish'}</button>
      </div>
    </header>

    <aside class="sidebar">
      <div class="brand">
        <span class="brand-dot"></span>
        <div>
          <p class="brand-kicker">Symballo</p>
          <strong>Untitled CMS</strong>
        </div>
      </div>

      <nav class="nav stack">
        <button class:active={view === 'dashboard'} onclick={() => (view = 'dashboard')}>
          <span class="nav-icon">◧</span>Dashboard
        </button>
        <button class:active={view === 'site'} onclick={() => (view = 'site')}>
          <span class="nav-icon">⌘</span>Site Details
        </button>
      </nav>

      <div class="nav-group">
        <p class="group-label">Content</p>
        <nav class="nav">
          <button class:active={view === 'posts'} onclick={() => (view = 'posts')}>
            <span class="nav-icon">◫</span>Posts
          </button>
          <button class:active={view === 'pages'} onclick={() => (view = 'pages')}>
            <span class="nav-icon">☰</span>Pages
          </button>
        </nav>
        <div class="subnav">
          <button class="sub-item">View all <span>{draft.posts.length}</span></button>
          <button class="sub-item">Recent <span>{Math.min(draft.posts.length, 8)}</span></button>
          <button class="sub-item">Scheduled <span>{draft.posts.filter((p) => p.bannerEnabled).length}</span></button>
        </div>
      </div>

      <div class="sidebar-actions">
        <button onclick={addPost}>+ New Post</button>
        <button onclick={addPage}>+ New Page</button>
      </div>
    </aside>

    <main class="workspace">
      <div class="workspace-sticky">
        <header class="topbar">
          <div class="record-head">
            <div class="record-art">{currentEntityTitle.slice(0, 1)}</div>
            <div>
              <h1>{currentEntityTitle}</h1>
              <p>{currentEntityMeta}</p>
            </div>
          </div>
          <div class="topbar-note">Customize content to make your storefront stand out.</div>
          <div class="topbar-actions">
            <button class="pill ghost">Copy link</button>
            <button class="pill ghost">Save draft</button>
            <button class="pill save" onclick={saveContent} disabled={saving}>{saving ? 'Saving...' : 'Publish'}</button>
          </div>
        </header>
        <div class="tabs-line">
          <div class="tabs panel">
            {#each editorTabs as tab, i}
              <button class="tab" class:active={i === 0}>{tab}</button>
            {/each}
          </div>
        </div>
        {#if status}<p class="status-inline">{status}</p>{/if}
      </div>

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
            <button onclick={() => (view = 'site')}>Edit Site Details</button>
            <button onclick={() => (view = 'posts')}>Manage Posts</button>
            <button onclick={() => (view = 'pages')}>Manage Pages</button>
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
            <label>Facebook URL<input bind:value={draft.site.facebookUrl} /></label>
            <label>Instagram URL<input bind:value={draft.site.instagramUrl} /></label>
          </div>
          <div class="hours-panel">
            <div class="pane-head">
              <h3>Business Hours</h3>
              <button onclick={addHoursRow}>+ Add Day</button>
            </div>
            <p class="hours-note">Keep at least 7 entries so every weekday is covered. Add extra rows for holidays.</p>
            <div class="hours-grid">
              {#each draft.site.hours as row, i}
                <div class="hours-row">
                  <label>Day/Event<input bind:value={row.label} /></label>
                  <label>Open<input type="time" bind:value={row.opens} disabled={row.closed} /></label>
                  <label>Close<input type="time" bind:value={row.closes} disabled={row.closed} /></label>
                  <label class="check-row">
                    <input type="checkbox" bind:checked={row.closed} />
                    Closed
                  </label>
                  <button class="danger" disabled={draft.site.hours.length <= 7} onclick={() => removeHoursRow(i)}>
                    Remove
                  </button>
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/if}

      {#if view === 'posts'}
        <section class="panel split-layout">
          <div class="list-pane">
            <div class="pane-head">
              <h2>Posts</h2>
              <button onclick={addPost}>+ Add</button>
            </div>
            <ul class="item-list">
              {#each draft.posts as post, i}
                <li>
                  <button class="item-row" class:selected={selectedPostIndex === i} onclick={() => (selectedPostIndex = i)}>
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
                <button class="danger" onclick={() => removePost(selectedPostIndex)}>Delete</button>
              </div>
              <div class="form-grid">
                <label>Slug<input bind:value={post.slug} /></label>
                <label>Title<input bind:value={post.title} /></label>
                <label>Date<input type="date" bind:value={post.publishedAt} /></label>
                <label>Excerpt<input bind:value={post.excerpt} /></label>
              </div>
              <div class="banner-box">
                <label class="check-row">
                  <input type="checkbox" bind:checked={post.bannerEnabled} />
                  Show sitewide banner linked to this post
                </label>
                {#if post.bannerEnabled}
                  <div class="form-grid">
                    <label>Banner Start Date<input type="date" bind:value={post.bannerStartDate} required /></label>
                    <label>Banner End Date<input type="date" bind:value={post.bannerEndDate} required /></label>
                  </div>
                {/if}
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
              <button onclick={addPage}>+ Add</button>
            </div>
            <ul class="item-list">
              {#each draft.pages as page, i}
                <li>
                  <button class="item-row" class:selected={selectedPageIndex === i} onclick={() => (selectedPageIndex = i)}>
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
                <button class="danger" onclick={() => removePage(selectedPageIndex)}>Delete</button>
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
    grid-template-columns: 248px 1fr;
    grid-template-rows: 56px 1fr;
    min-height: 100vh;
    background: #eceff4;
    color: #5a677a;
    --shell-bg: #eceff4;
    --chrome-bg: linear-gradient(90deg, #f8fafc, #f2f5f9);
    --chrome-border: #d9e0ea;
    --sidebar-bg: radial-gradient(circle at 25% -10%, rgba(110, 132, 170, 0.18), transparent 45%), #f8fafc;
    --sidebar-border: #d9e0ea;
    --panel-bg: #ffffff;
    --panel-border: #d9e0ea;
    --text-strong: #162034;
    --text-soft: #6f7f96;
    --btn-bg: #2a3a51;
    --btn-border: #2a3a51;
    --btn-text: #ffffff;
    --active-nav-bg: #eaf0fa;
    --active-nav-border: #ccd7ea;
    --field-bg: #f8fafd;
    --field-border: #d2dbea;
    --field-text: #23324a;
  }

  .admin-shell.dark {
    background: #060a10;
    color: #dfe7f6;
    --shell-bg: #060a10;
    --chrome-bg: linear-gradient(90deg, #040a13, #080e17);
    --chrome-border: #1c2738;
    --sidebar-bg: radial-gradient(circle at 50% -20%, rgba(100, 125, 173, 0.15), transparent 42%), #0d141f;
    --sidebar-border: #1f2c40;
    --panel-bg: #090f18;
    --panel-border: #1d2a3d;
    --text-strong: #f2f6ff;
    --text-soft: #8f9db4;
    --btn-bg: #1f2a3b;
    --btn-border: #303f58;
    --btn-text: #ffffff;
    --active-nav-bg: #1a2536;
    --active-nav-border: #2d3f5a;
    --field-bg: #0f1723;
    --field-border: #26364f;
    --field-text: #f2f6ff;
  }

  .chrome-bar {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 1rem;
    background: var(--chrome-bg);
    color: var(--text-strong);
    border-bottom: 1px solid var(--chrome-border);
  }

  .chrome-left,
  .chrome-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .icon-btn {
    width: 38px;
    height: 38px;
    border-radius: 999px;
    border: 1px solid var(--panel-border);
    background: var(--panel-bg);
    color: var(--text-strong);
    font-size: 0.96rem;
  }

  .search-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border: 1px solid var(--panel-border);
    background: var(--panel-bg);
    border-radius: 999px;
    padding: 0.36rem 0.7rem;
    min-width: 190px;
  }

  .search-pill span {
    color: var(--text-soft);
    font-size: 0.9rem;
  }

  .search-pill input {
    border: 0;
    background: transparent;
    color: var(--text-strong);
    width: 100%;
    padding: 0;
    outline: none;
  }

  .view-site-link {
    color: var(--text-soft);
    text-decoration: none;
    font-size: 0.86rem;
  }

  .mode-toggle {
    border: 1px solid var(--panel-border);
    background: transparent;
    color: var(--text-soft);
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
    padding: 1rem 0.95rem;
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

  .brand {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }

  .brand-dot {
    width: 11px;
    height: 11px;
    border-radius: 999px;
    background: linear-gradient(180deg, #7b8ca8, #44526b);
    flex: 0 0 auto;
  }

  .brand strong {
    font-size: 1.06rem;
    color: var(--text-strong);
  }

  .nav {
    display: grid;
    gap: 0.45rem;
    justify-items: start;
    align-content: start;
  }

  .nav.stack {
    margin-top: 0.4rem;
  }

  .nav-icon {
    font-size: 0.9rem;
    color: var(--text-soft);
    flex: 0 0 auto;
  }

  .nav button {
    text-align: left;
    display: inline-flex;
    align-items: center;
    gap: 0.48rem;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-strong);
    padding: 0.55rem 0.65rem;
    border-radius: 6px;
    width: 168px;
    font-weight: 500;
  }

  .nav button:hover,
  .nav button.active {
    border-color: var(--active-nav-border);
    background: var(--active-nav-bg);
  }

  .sidebar-actions {
    display: grid;
    gap: 0.55rem;
    justify-items: start;
    margin-top: auto;
  }

  .sidebar-actions button {
    border: 1px solid var(--btn-border);
    background: transparent;
    color: var(--text-strong);
    border-radius: 6px;
    padding: 0.5rem;
    width: 168px;
    font-weight: 600;
  }

  .nav-group {
    border-top: 1px solid var(--sidebar-border);
    padding-top: 0.9rem;
    display: grid;
    gap: 0.65rem;
  }

  .group-label {
    margin: 0;
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-soft);
  }

  .subnav {
    display: grid;
    gap: 0.35rem;
    margin-top: 0.2rem;
  }

  .sub-item {
    width: 168px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-soft);
    padding: 0.48rem 0.58rem;
    border-radius: 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.86rem;
  }

  .sub-item span {
    min-width: 20px;
    text-align: center;
    border-radius: 999px;
    border: 1px solid var(--panel-border);
    padding: 0.1rem 0.34rem;
    font-size: 0.74rem;
  }

  .workspace {
    padding: 0.8rem 1.5rem 1.4rem;
    display: grid;
    gap: 0.75rem;
    background: var(--shell-bg);
  }

  .workspace-sticky {
    position: sticky;
    top: 56px;
    z-index: 12;
    background: var(--shell-bg);
    padding-top: 0.4rem;
    border-bottom: 1px solid var(--panel-border);
    margin-bottom: 0.45rem;
  }

  .topbar {
    display: grid;
    grid-template-columns: 1.4fr 1fr auto;
    gap: 1rem;
    align-items: start;
    padding: 0.45rem 0.05rem 0.55rem;
  }

  .record-head {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .record-art {
    width: 40px;
    height: 56px;
    border-radius: 9px;
    border: 1px solid var(--panel-border);
    background: linear-gradient(180deg, #f6cf70, #d48a3f 60%, #79321f);
    color: #fff;
    display: grid;
    place-items: center;
    font-weight: 700;
    text-transform: uppercase;
  }

  .topbar h1 {
    margin: 0;
    font-size: 3.02rem;
    font-weight: 500;
    color: var(--text-strong);
    line-height: 0.95;
  }

  .topbar p {
    margin: 0.2rem 0 0;
    color: var(--text-soft);
    font-size: 0.88rem;
  }

  .topbar-note {
    color: var(--text-soft);
    font-size: 1.05rem;
    line-height: 1.2;
    max-width: 320px;
    justify-self: end;
    padding-top: 0.35rem;
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    justify-self: end;
    padding-top: 0.3rem;
  }

  .status-inline {
    margin: 0.1rem 0 0.45rem;
    color: #4bbf87;
    font-size: 0.85rem;
  }

  .pill {
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--btn-text);
    border-radius: 999px;
    padding: 0.5rem 0.95rem;
    font-size: 0.88rem;
    line-height: 1;
  }

  .pill.ghost {
    background: transparent;
    color: var(--text-soft);
    border-color: var(--panel-border);
  }

  .save {
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--btn-text);
  }

  .panel {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    padding: 1rem;
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.18rem 0;
    background: transparent;
    border: 0;
    border-radius: 0;
  }

  .tabs-line {
    border-top: 1px solid transparent;
    border-bottom: 1px solid var(--panel-border);
    margin-bottom: 0.2rem;
  }

  .tab {
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-soft);
    border-radius: 8px;
    padding: 0.48rem 0.72rem;
    font-size: 0.88rem;
  }

  .tab.active {
    color: var(--text-strong);
    border-color: var(--active-nav-border);
    background: rgba(116, 141, 183, 0.2);
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

  .hours-panel {
    margin-top: 1rem;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 0.8rem;
    display: grid;
    gap: 0.7rem;
  }

  .hours-note {
    margin: 0;
    color: var(--text-soft);
    font-size: 0.82rem;
  }

  .hours-grid {
    display: grid;
    gap: 0.55rem;
  }

  .hours-row {
    display: grid;
    grid-template-columns: 1.4fr 1fr 1fr auto auto;
    gap: 0.5rem;
    align-items: end;
    border: 1px solid var(--field-border);
    border-radius: 8px;
    padding: 0.55rem;
    background: var(--field-bg);
  }

  .check-row {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 38px;
  }

  .check-row input[type='checkbox'] {
    width: 16px;
    height: 16px;
  }

  .banner-box {
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 0.75rem;
    background: rgba(63, 111, 211, 0.06);
    display: grid;
    gap: 0.6rem;
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
    border-color: #8f4545;
    color: #d86f6f;
    background: rgba(143, 69, 69, 0.15);
  }

  @media (max-width: 1080px) {
    .topbar {
      grid-template-columns: 1fr;
      gap: 0.6rem;
    }

    .topbar-note,
    .topbar-actions {
      justify-self: start;
      max-width: none;
      padding-top: 0;
    }

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

    .hours-row {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .chrome-bar {
      padding: 0.45rem 0.6rem;
      gap: 0.4rem;
      flex-wrap: wrap;
      height: auto;
      min-height: 56px;
    }

    .workspace-sticky {
      top: 72px;
    }

    .search-pill {
      min-width: 130px;
    }
  }
</style>
