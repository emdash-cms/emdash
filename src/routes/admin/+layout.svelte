<script lang="ts">
  import { page } from '$app/state';
  import {
    LayoutDashboard,
    FileText,
    Megaphone,
    Clock3,
    UserCircle2,
    File,
    Palette,
    Menu,
    Search,
    User,
    CircleHelp,
    Headset,
    ExternalLink,
    Images,
    Plus
  } from 'lucide-svelte';

  let { children } = $props();

  const links = [
    { group: '', items: [{ href: '/admin', label: 'Dashboard', icon: LayoutDashboard }] },
    {
      group: 'Content',
      items: [
        { href: '/admin/posts', label: 'Posts', icon: FileText },
        { href: '/admin/promotions', label: 'Promotions', icon: Megaphone },
        { href: '/admin/menu', label: 'Menu', icon: Menu },
        { href: '/admin/hours', label: 'Hours', icon: Clock3 }
      ]
    },
    {
      group: 'Site',
      items: [
        { href: '/admin/site-profile', label: 'Site Profile', icon: UserCircle2 },
        { href: '/admin/pages', label: 'Pages', icon: File },
        { href: '/admin/appearance', label: 'Appearance', icon: Palette },
        { href: '/admin/media-library', label: 'Media Library', icon: Images },
        { href: '/admin/settings-seo', label: 'Settings & SEO', icon: Search }
      ]
    },
    {
      group: 'Workspace',
      items: [
        { href: '/admin/account', label: 'Account', icon: User },
        { href: '/admin/guide', label: 'Guide', icon: CircleHelp },
        { href: '/admin/support', label: 'Support', icon: Headset },
        { href: '/admin/open-site', label: 'Open site', icon: ExternalLink }
      ]
    }
  ];

  const currentPath = $derived(page.url.pathname);
  const routeTitle = $derived.by(() => {
    const hit = links.flatMap((g) => g.items).find((item) => item.href === currentPath);
    return hit?.label ?? 'Dashboard';
  });
  const newLabel = $derived.by(() => {
    if (currentPath === '/admin/posts') return 'New Post';
    if (currentPath === '/admin/promotions') return 'New Promotion';
    if (currentPath === '/admin/menu') return 'New Item';
    if (currentPath === '/admin/pages') return 'New Page';
    if (currentPath === '/admin/hours') return 'New Day';
    return 'New';
  });
</script>

<div class="admin-theme">
  <div class="grid h-screen w-full gap-0 lg:grid-cols-[230px_1fr]">
    <aside class="admin-sidebar">
      <div class="border-b-transparent px-5 pb-4 pt-6" style={`border-color: var(--admin-panel-border);`}>
        <p class="m-0 text-[24px] leading-[1.05] font-semibold text-[var(--admin-text-strong)]">Local Restaurant</p>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {#each links as group}
          {#if group.group}
            <p class="admin-side-label">{group.group}</p>
          {/if}
          <nav class="grid gap-1">
            {#each group.items as item}
              <a class={`admin-side-link no-underline ${currentPath === item.href ? 'active' : ''}`} href={item.href}>
                <item.icon class="admin-side-icon" />{item.label}
              </a>
            {/each}
          </nav>
        {/each}
      </div>
      <div class="px-4 pb-4">
        <button class="w-full rounded-2xl border p-3 text-left" style={`border-color: var(--admin-panel-border); background: #f0f2f6;`}>
          <p class="m-0 text-sm font-semibold text-[var(--admin-text-strong)]">Your Symballo Account</p>
          <p class="m-0 mt-1 text-sm text-[var(--admin-text-strong)]">Account Settings</p>
        </button>
      </div>
    </aside>

    <section class="admin-panel m-3 flex min-w-0 flex-col overflow-hidden p-0">
      <header class="flex items-center justify-between border-b px-5 py-3" style={`border-color: var(--admin-panel-border);`}>

        <h2 class="m-0 text-3xl font-semibold text-[var(--admin-text-strong)]">{routeTitle}</h2>
        <div class="flex items-center gap-2">
            <button class="admin-pill-ghost"><CircleHelp class="mr-2 inline-block h-4 w-4" />View Guide</button>
            {#if currentPath !== '/admin'}
              <button class="admin-pill"><Plus class="mr-2 inline-block h-4 w-4" />{newLabel}</button>
            {/if}
          </div>
      </header>

      <div class="min-h-0 flex-1 overflow-auto px-5 py-4">
        <header class="mb-4 flex flex-wrap items-start justify-between gap-3 border-b-transparent pb-4" style={`border-color: var(--admin-panel-border);`}>
          <div>
            <p class="mt-1 text-[18px] text-[var(--admin-text-soft)]">
           Update your business information
            </p>
          </div>

        </header>

        {@render children()}
      </div>
    </section>
  </div>
</div>
