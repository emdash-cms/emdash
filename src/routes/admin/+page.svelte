<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { CmsData } from '$lib/cms-schema';
  import GuideIcon from '$lib/icons/GuideIcon.svelte';
  import SupportIcon from '$lib/icons/SupportIcon.svelte';
  import OpenSiteIcon from '$lib/icons/OpenSiteIcon.svelte';

  type AdminView = 'profile' | 'pages' | 'posts' | 'promotions' | 'appearance';

  let draft = $state<CmsData | null>(null);
  let savedSnapshot = $state('');
  let saving = $state(false);
  let status = $state('');
  let toastMessage = $state('');
  let showToast = $state(false);
  let view = $state<AdminView>('profile');
  let selectedPostIndex = $state(0);
  let selectedPageIndex = $state(0);
  let darkMode = $state(true);
  const themeStorageKey = 'symballo:admin:theme';
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function dismissToast() {
    showToast = false;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function showSuccessToast(message: string) {
    dismissToast();
    toastMessage = message;
    showToast = true;
    toastTimer = setTimeout(() => {
      showToast = false;
      toastTimer = null;
    }, 3500);
  }

  function snapshot(data: CmsData | null) {
    return data ? JSON.stringify(data) : '';
  }

  async function loadContent() {
    const response = await fetch('/api/admin/content');
    draft = (await response.json()) as CmsData;
    savedSnapshot = snapshot(draft);
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
      status = '';
      showSuccessToast('Changes saved.');
      savedSnapshot = snapshot(draft);
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
        seoTitle: '',
        seoDescription: '',
        seoKeywords: '',
        seoNoIndex: false,
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

    draft.pages = [
      ...draft.pages,
      { slug: `page-${Date.now()}`, title: 'New Page', body: '', seoTitle: '', seoDescription: '', seoKeywords: '', seoNoIndex: false }
    ];
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

  onMount(() => {
    const storedTheme = localStorage.getItem(themeStorageKey);
    if (storedTheme === 'light') darkMode = false;
    if (storedTheme === 'dark') darkMode = true;
    void loadContent();
  });

  onDestroy(() => {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  });

  $effect(() => {
    localStorage.setItem(themeStorageKey, darkMode ? 'dark' : 'light');
  });

  const currentEntityTitle = $derived.by(() => {
    if (!draft) return 'Content';
    if (view === 'profile') return 'Site Profile';
    if (view === 'posts' && draft.posts[selectedPostIndex]) return draft.posts[selectedPostIndex].title || 'Untitled post';
    if (view === 'promotions' && draft.posts[selectedPostIndex]) return draft.posts[selectedPostIndex].title || 'Post promotion';
    if (view === 'pages' && draft.pages[selectedPageIndex]) return draft.pages[selectedPageIndex].title || 'Untitled page';
    if (view === 'appearance') return 'Appearance';
    return 'Content';
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
    if (view === 'profile') return 'Business info, contact details, and hours';
    if (view === 'promotions') return 'Sitewide banner settings linked to posts';
    if (view === 'appearance') return 'Brand tokens and visual defaults';
    return 'Content';
  });

  const currentSectionName = $derived.by(() => {
    if (view === 'profile') return 'Site Profile';
    if (view === 'pages') return 'Pages';
    if (view === 'posts') return 'Posts';
    if (view === 'promotions') return 'Promotions';
    return 'Appearance';
  });

  const currentSectionBlurb = $derived.by(() => {
    if (view === 'profile') return 'Update core business details first. This is what visitors need most.';
    if (view === 'pages') return 'Manage evergreen content like About, Contact, and service pages.';
    if (view === 'posts') return 'Publish updates, news, announcements, events, and sermons.';
    if (view === 'promotions') return 'Control optional sitewide banners and campaign dates.';
    return 'Adjust reusable brand tokens before developer handoff.';
  });

  const hasUnsavedChanges = $derived.by(() => {
    if (!draft) return false;
    return snapshot(draft) !== savedSnapshot;
  });

  const primaryTabBase =
    'border-b-2 border-transparent bg-transparent px-0.5 py-2 text-sm font-medium transition text-[var(--admin-text-soft)]';
  const primaryTabActive = 'border-[var(--admin-text-strong)] text-[var(--admin-text-strong)]';
</script>

<svelte:head>
  <title>Admin</title>
</svelte:head>

{#if !draft}
  <div class="content-wrap text-[var(--site-text-light)]"><p>Loading admin...</p></div>
{:else}
  <div class="admin-theme p-4 md:p-8" class:is-dark={darkMode}>
      {#if showToast}
        <aside class="pointer-events-none fixed right-4 top-4 z-[70] sm:right-6 sm:top-6" role="status" aria-live="polite">
          <div
            class="pointer-events-auto flex items-center gap-3 rounded-xl border px-4 py-2.5 shadow-lg"
            style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg); color: var(--admin-text-strong);`}
          >
            <p class="m-0 text-sm font-medium">{toastMessage}</p>
            <button class="admin-pill-ghost !min-h-0 !px-2 !py-1 !text-xs" onclick={dismissToast}>Dismiss</button>
          </div>
        </aside>
      {/if}

      <div class="admin-sticky">
        <header class="flex flex-wrap items-center justify-between gap-3 px-1 pb-3">
          <div
            class="relative inline-flex h-10.5 w-[176px] items-center rounded-full bg-neutral-700 dark:bg-neutral-400 border p-1"
            style={`border-color: var(--admin-panel-border);`}
            role="group"
            aria-label="Theme mode"
          >
            <span
              class={`pointer-events-none absolute top-1 h-8 w-[84px] rounded-full transition-transform duration-300 ease-out ${
                darkMode
                  ? 'translate-x-[84px] bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]'
                  : 'translate-x-0 bg-[linear-gradient(180deg,#2ad6ff,#1282ff)] shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]'
              }`}
            ></span>
            <button
              class={`relative z-10 inline-flex h-8 w-[84px] items-center justify-center gap-1.5 rounded-full px-2 text-sm font-medium transition ${
                !darkMode ? 'text-white' : 'text-white/75'
              }`}
              aria-pressed={!darkMode}
              onclick={() => (darkMode = false)}
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="12" cy="12" r="4"></circle>
                <path d="M12 2v2"></path>
                <path d="M12 20v2"></path>
                <path d="m4.93 4.93 1.41 1.41"></path>
                <path d="m17.66 17.66 1.41 1.41"></path>
                <path d="M2 12h2"></path>
                <path d="M20 12h2"></path>
                <path d="m6.34 17.66-1.41 1.41"></path>
                <path d="m19.07 4.93-1.41 1.41"></path>
              </svg>
              <span>Light</span>
            </button>
            <button
              class={`relative z-10 inline-flex h-8 w-[84px] items-center justify-center gap-1.5 rounded-full px-2 text-sm font-medium transition ${
                darkMode ? 'text-[#0b1423]' : 'text-white/75'
              }`}
              aria-pressed={darkMode}
              onclick={() => (darkMode = true)}
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M21 12.8A8.8 8.8 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path>
              </svg>
              <span>Dark</span>
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <button class="admin-pill-ghost">
              <GuideIcon className="h-4 w-4 shrink-0" />
              <span class="ml-1.5">Guide</span>
            </button>
            <button class="admin-pill-ghost">
              <SupportIcon className="h-4 w-4 shrink-0" />
              <span class="ml-1.5">Support</span>
            </button>
            <a
              class="admin-pill-ghost text-sm no-underline"
              href="/"
              target="_blank"
              rel="noreferrer"
            >
              <OpenSiteIcon className="h-4 w-4 shrink-0" />
              <span class="ml-1.5">Open site</span>
            </a>
          </div>
        </header>

        <header class="grid items-end gap-4 px-1 py-6 lg:grid-cols-[minmax(300px,1fr)_minmax(280px,0.95fr)]">
          <h1 class="m-0 text-[clamp(2.55rem,4.7vw,4.9rem)] font-medium leading-[0.94] tracking-[-0.02em] text-[var(--admin-text-strong)]">
            {currentSectionName}
          </h1>
          <p
            class="m-0 justify-self-start text-right text-[clamp(1.9rem,2.2vw,3.15rem)] font-light leading-[0.92] tracking-[-0.02em] text-[var(--admin-text-soft)] opacity-55 lg:justify-self-end"
          >
            {currentSectionBlurb}
          </p>
        </header>

        <div class="flex flex-wrap items-end justify-between gap-3 border-b pb-0.5" style={`border-color: var(--admin-panel-border);`}>
          <nav class="flex flex-wrap items-center gap-3">
            <button
              class={`${primaryTabBase} ${view === 'profile' ? primaryTabActive : ''}`}
              onclick={() => (view = 'profile')}
            >
              Site Profile
            </button>
            <button class={`${primaryTabBase} ${view === 'pages' ? primaryTabActive : ''}`} onclick={() => (view = 'pages')}>
              Pages
            </button>
            <button class={`${primaryTabBase} ${view === 'posts' ? primaryTabActive : ''}`} onclick={() => (view = 'posts')}>
              Posts
            </button>
            <button class={`${primaryTabBase} ${view === 'promotions' ? primaryTabActive : ''}`} onclick={() => (view = 'promotions')}>
              Promotions
            </button>
            <button class={`${primaryTabBase} ${view === 'appearance' ? primaryTabActive : ''}`} onclick={() => (view = 'appearance')}>
              Appearance
            </button>
          </nav>
          <button
            class={hasUnsavedChanges ? 'admin-pill' : 'admin-pill-ghost opacity-70'}
            onclick={saveContent}
            disabled={!hasUnsavedChanges || saving}
          >
            {saving ? 'Saving...' : hasUnsavedChanges ? 'Save Changes' : 'Saved'}
          </button>
        </div>
      </div>

      <header class="grid items-center gap-4 pt-1">
        <div class="flex items-center gap-3">

          <div>
            <h2 class="m-0 text-3xl font-semibold text-[var(--admin-text-strong)]">{currentEntityMeta}</h2>
          </div>
        </div>
      </header>

      <div class="flex flex-wrap items-center gap-2">
        {#if view === 'posts' || view === 'promotions'}
          <button class="admin-pill-ghost" onclick={addPost}>+ New Post</button>
        {/if}
        {#if view === 'pages'}
          <button class="admin-pill-ghost" onclick={addPage}>+ New Page</button>
        {/if}
      </div>

      {#if status}<p class="m-0 text-sm text-[#d86f6f]">{status}</p>{/if}

      {#if view === 'profile'}
        <section class="admin-panel">
          <h2 class="mt-0 text-2xl text-[var(--admin-text-strong)]">Site Details</h2>
          <div class="grid gap-3 md:grid-cols-2">
            <label class="admin-label">Business Name<input class="admin-input" bind:value={draft.site.title} /></label>
            <label class="admin-label">Tagline<input class="admin-input" bind:value={draft.site.tagline} /></label>
            <label class="admin-label">Phone<input class="admin-input" bind:value={draft.site.phone} /></label>
            <label class="admin-label">Email<input class="admin-input" bind:value={draft.site.email} /></label>
            <label class="admin-label">Address<input class="admin-input" bind:value={draft.site.address} /></label>
            <label class="admin-label">Facebook URL<input class="admin-input" bind:value={draft.site.facebookUrl} /></label>
            <label class="admin-label md:col-span-2"
              >Instagram URL<input class="admin-input" bind:value={draft.site.instagramUrl} /></label
            >
          </div>

          <div class="mt-4 grid gap-3 rounded-lg border p-3" style={`border-color: var(--admin-panel-border);`}>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="m-0 text-xl text-[var(--admin-text-strong)]">Business Hours</h3>
              <button class="admin-pill-ghost" onclick={addHoursRow}>+ Add Day</button>
            </div>
            <p class="m-0 text-sm text-[var(--admin-text-soft)]">
              Keep at least 7 entries so every weekday is covered. Add extra rows for holidays.
            </p>
            <div class="grid gap-2.5">
              {#each draft.site.hours as row, i}
                <div
                  class="grid gap-2 rounded-lg border p-2 md:grid-cols-[1.4fr_1fr_1fr_auto_auto] md:items-end"
                  style={`border-color: var(--admin-field-border); background: var(--admin-field-bg);`}
                >
                  <label class="admin-label">Day/Event<input class="admin-input" bind:value={row.label} /></label>
                  <label class="admin-label">Open<input class="admin-input" type="time" bind:value={row.opens} disabled={row.closed} /></label>
                  <label class="admin-label">Close<input class="admin-input" type="time" bind:value={row.closes} disabled={row.closed} /></label>
                  <label class="admin-label inline-flex min-h-10 items-center gap-2.5">
                    <input class="h-4 w-4" type="checkbox" bind:checked={row.closed} />
                    Closed
                  </label>
                  <button
                    class="inline-flex items-center rounded-md border border-[#8f4545] bg-[#8f454526] px-3 py-2 text-sm text-[#d86f6f]"
                    disabled={draft.site.hours.length <= 7}
                    onclick={() => removeHoursRow(i)}
                  >
                    Remove
                  </button>
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/if}

      {#if view === 'posts'}
        <section class="admin-panel grid gap-4 lg:grid-cols-[280px_1fr]">
          <div class="border-b pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4" style={`border-color: var(--admin-panel-border);`}>
            <div class="mb-3 flex items-center justify-between gap-2">
              <h2 class="m-0 text-2xl text-[var(--admin-text-strong)]">Posts</h2>
              <button class="admin-pill-ghost" onclick={addPost}>+ Add</button>
            </div>
            <ul class="m-0 grid list-none gap-1.5 p-0">
              {#each draft.posts as post, i}
                <li>
                  <button
                    class="admin-list-item"
                    class:active={selectedPostIndex === i}
                    onclick={() => (selectedPostIndex = i)}
                  >
                    <span>{post.title || 'Untitled'}</span>
                    <small class="text-[var(--admin-text-soft)]">{post.slug}</small>
                  </button>
                </li>
              {/each}
            </ul>
          </div>

          <div class="grid gap-3">
            {#if draft.posts.length === 0}
              <p class="m-0 text-[var(--admin-text-soft)]">No posts yet. Add one to begin.</p>
            {:else}
              {@const post = draft.posts[selectedPostIndex]}
              <div class="mb-1 flex items-center justify-between gap-2">
                <h3 class="m-0 text-xl text-[var(--admin-text-strong)]">Edit Post</h3>
                <button class="inline-flex items-center rounded-md border border-[#8f4545] bg-[#8f454526] px-3 py-2 text-sm text-[#d86f6f]" onclick={() => removePost(selectedPostIndex)}>
                  Delete
                </button>
              </div>
              <div class="grid gap-3 md:grid-cols-2">
                <label class="admin-label">Slug<input class="admin-input" bind:value={post.slug} /></label>
                <label class="admin-label">Title<input class="admin-input" bind:value={post.title} /></label>
                <label class="admin-label">Date<input class="admin-input" type="date" bind:value={post.publishedAt} /></label>
                <label class="admin-label">Excerpt<input class="admin-input" bind:value={post.excerpt} /></label>
              </div>
              <div class="grid gap-3 rounded-lg border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg);`}>
                <h4 class="m-0 text-base font-semibold text-[var(--admin-text-strong)]">SEO</h4>
                <p class="m-0 text-sm text-[var(--admin-text-soft)]">Optional search metadata (similar to Yoast-style fields).</p>
                <div class="grid gap-3 md:grid-cols-2">
                  <label class="admin-label md:col-span-2">SEO Title<input class="admin-input" bind:value={post.seoTitle} placeholder={post.title || 'Post title'} /></label>
                  <label class="admin-label md:col-span-2"
                    >Meta Description
                    <textarea class="admin-textarea min-h-24 resize-y" bind:value={post.seoDescription} placeholder={post.excerpt || 'Short summary for search results'}></textarea></label
                  >
                  <label class="admin-label md:col-span-2"
                    >Keywords
                    <input class="admin-input" bind:value={post.seoKeywords} placeholder="example: bakery, downtown bakery, fresh bread" /></label
                  >
                  <label class="admin-label inline-flex min-h-10 items-center gap-2.5 md:col-span-2">
                    <input class="h-4 w-4" type="checkbox" bind:checked={post.seoNoIndex} />
                    Hide this post from search engines (`noindex`)
                  </label>
                </div>
              </div>
              <div
                class="grid gap-2 rounded-lg border p-3"
                style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg);`}
              >
                <label class="admin-label inline-flex min-h-10 items-center gap-2.5">
                  <input class="h-4 w-4" type="checkbox" bind:checked={post.bannerEnabled} />
                  Show sitewide banner linked to this post
                </label>
                {#if post.bannerEnabled}
                  <div class="grid gap-3 md:grid-cols-2">
                    <label class="admin-label"
                      >Banner Start Date<input class="admin-input" type="date" bind:value={post.bannerStartDate} required /></label
                    >
                    <label class="admin-label"
                      >Banner End Date<input class="admin-input" type="date" bind:value={post.bannerEndDate} required /></label
                    >
                  </div>
                {/if}
              </div>
              <label class="admin-label">Body<textarea class="admin-textarea min-h-60 resize-y" bind:value={post.body}></textarea></label>
            {/if}
          </div>
        </section>
      {/if}

      {#if view === 'pages'}
        <section class="admin-panel grid gap-4 lg:grid-cols-[280px_1fr]">
          <div class="border-b pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4" style={`border-color: var(--admin-panel-border);`}>
            <div class="mb-3 flex items-center justify-between gap-2">
              <h2 class="m-0 text-2xl text-[var(--admin-text-strong)]">Pages</h2>
              <button class="admin-pill-ghost" onclick={addPage}>+ Add</button>
            </div>
            <ul class="m-0 grid list-none gap-1.5 p-0">
              {#each draft.pages as page, i}
                <li>
                  <button
                    class="admin-list-item"
                    class:active={selectedPageIndex === i}
                    onclick={() => (selectedPageIndex = i)}
                  >
                    <span>{page.title || 'Untitled'}</span>
                    <small class="text-[var(--admin-text-soft)]">{page.slug}</small>
                  </button>
                </li>
              {/each}
            </ul>
          </div>

          <div class="grid gap-3">
            {#if draft.pages.length === 0}
              <p class="m-0 text-[var(--admin-text-soft)]">No pages yet. Add one to begin.</p>
            {:else}
              {@const page = draft.pages[selectedPageIndex]}
              <div class="mb-1 flex items-center justify-between gap-2">
                <h3 class="m-0 text-xl text-[var(--admin-text-strong)]">Edit Page</h3>
                <button class="inline-flex items-center rounded-md border border-[#8f4545] bg-[#8f454526] px-3 py-2 text-sm text-[#d86f6f]" onclick={() => removePage(selectedPageIndex)}>
                  Delete
                </button>
              </div>
              <div class="grid gap-3 md:grid-cols-2">
                <label class="admin-label">Slug<input class="admin-input" bind:value={page.slug} /></label>
                <label class="admin-label">Title<input class="admin-input" bind:value={page.title} /></label>
              </div>
              <div class="grid gap-3 rounded-lg border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg);`}>
                <h4 class="m-0 text-base font-semibold text-[var(--admin-text-strong)]">SEO</h4>
                <p class="m-0 text-sm text-[var(--admin-text-soft)]">Optional search metadata (similar to Yoast-style fields).</p>
                <div class="grid gap-3 md:grid-cols-2">
                  <label class="admin-label md:col-span-2">SEO Title<input class="admin-input" bind:value={page.seoTitle} placeholder={page.title || 'Page title'} /></label>
                  <label class="admin-label md:col-span-2"
                    >Meta Description
                    <textarea class="admin-textarea min-h-24 resize-y" bind:value={page.seoDescription} placeholder="Short summary for search results"></textarea></label
                  >
                  <label class="admin-label md:col-span-2"
                    >Keywords
                    <input class="admin-input" bind:value={page.seoKeywords} placeholder="example: church, sunday service, community" /></label
                  >
                  <label class="admin-label inline-flex min-h-10 items-center gap-2.5 md:col-span-2">
                    <input class="h-4 w-4" type="checkbox" bind:checked={page.seoNoIndex} />
                    Hide this page from search engines (`noindex`)
                  </label>
                </div>
              </div>
              <label class="admin-label">Body<textarea class="admin-textarea min-h-60 resize-y" bind:value={page.body}></textarea></label>
            {/if}
          </div>
        </section>
      {/if}

      {#if view === 'promotions'}
        <section class="admin-panel grid gap-4 lg:grid-cols-[280px_1fr]">
          <div class="border-b pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4" style={`border-color: var(--admin-panel-border);`}>
            <div class="mb-3 flex items-center justify-between gap-2">
              <h2 class="m-0 text-2xl text-[var(--admin-text-strong)]">Promotions</h2>
              <button class="admin-pill-ghost" onclick={addPost}>+ Add Post</button>
            </div>
            <ul class="m-0 grid list-none gap-1.5 p-0">
              {#each draft.posts as post, i}
                <li>
                  <button
                    class="admin-list-item"
                    class:active={selectedPostIndex === i}
                    onclick={() => (selectedPostIndex = i)}
                  >
                    <span>{post.title || 'Untitled'}</span>
                    <small class="text-[var(--admin-text-soft)]">
                      {post.bannerEnabled ? 'Banner enabled' : 'No banner'} | {post.slug}
                    </small>
                  </button>
                </li>
              {/each}
            </ul>
          </div>

          <div class="grid gap-3">
            {#if draft.posts.length === 0}
              <p class="m-0 text-[var(--admin-text-soft)]">No posts available. Create one first.</p>
            {:else}
              {@const post = draft.posts[selectedPostIndex]}
              <h3 class="m-0 text-xl text-[var(--admin-text-strong)]">{post.title || 'Untitled post'}</h3>
              <p class="m-0 text-sm text-[var(--admin-text-soft)]">
                Link a sitewide banner to this post. Start and end dates are required when enabled.
              </p>
              <div class="grid gap-2 rounded-lg border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg);`}>
                <label class="admin-label inline-flex min-h-10 items-center gap-2.5">
                  <input class="h-4 w-4" type="checkbox" bind:checked={post.bannerEnabled} />
                  Show sitewide banner linked to this post
                </label>
                <div class="grid gap-3 md:grid-cols-2">
                  <label class="admin-label"
                    >Banner Start Date<input class="admin-input" type="date" bind:value={post.bannerStartDate} disabled={!post.bannerEnabled} required /></label
                  >
                  <label class="admin-label"
                    >Banner End Date<input class="admin-input" type="date" bind:value={post.bannerEndDate} disabled={!post.bannerEnabled} required /></label
                  >
                </div>
              </div>
            {/if}
          </div>
        </section>
      {/if}

      {#if view === 'appearance'}
        <section class="admin-panel grid gap-4">
          <div>
            <h2 class="m-0 text-2xl text-[var(--admin-text-strong)]">Appearance</h2>
            <p class="mt-2 text-sm text-[var(--admin-text-soft)]">
              Keep this starter simple: developers set brand visuals once, then clients manage content.
            </p>
          </div>
          <div class="grid gap-3 md:grid-cols-2">
            <article class="rounded-lg border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg);`}>
              <p class="m-0 text-xs uppercase tracking-[0.08em] text-[var(--admin-text-soft)]">Primary Font</p>
              <p class="mt-1 text-lg text-[var(--admin-text-strong)]">Onest</p>
            </article>
            <article class="rounded-lg border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg);`}>
              <p class="m-0 text-xs uppercase tracking-[0.08em] text-[var(--admin-text-soft)]">Display Font</p>
              <p class="mt-1 text-lg text-[var(--admin-text-strong)]">Bebas Neue</p>
            </article>
            <article class="rounded-lg border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg);`}>
              <p class="m-0 text-xs uppercase tracking-[0.08em] text-[var(--admin-text-soft)]">Accent Color</p>
              <div class="mt-2 flex items-center gap-2">
                <span class="h-6 w-6 rounded border" style="background: var(--site-accent); border-color: var(--admin-panel-border);"></span>
                <code class="text-sm text-[var(--admin-text-strong)]">--site-accent</code>
              </div>
            </article>
            <article class="rounded-lg border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-panel-bg);`}>
              <p class="m-0 text-xs uppercase tracking-[0.08em] text-[var(--admin-text-soft)]">Token Source</p>
              <p class="mt-1 text-sm text-[var(--admin-text-strong)]">`src/styles.css` (`:root` and `.admin-theme.is-dark`)</p>
            </article>
          </div>
        </section>
      {/if}

  </div>
{/if}
