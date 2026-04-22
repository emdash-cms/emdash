<script lang="ts">
  let { data } = $props();
  const site = $derived(data.site);
  const phoneHref = $derived(`tel:${site.phone.replace(/[^\d+]/g, '')}`);
  const hoursLines = $derived(
    (site.hours ?? []).map((entry) =>
      entry.closed ? `${entry.label}: Closed` : `${entry.label}: ${entry.opens} - ${entry.closes}`
    )
  );
</script>

<svelte:head>
  <title>{site.title}</title>
  <meta name="description" content={site.tagline} />
</svelte:head>

<section
  class="relative min-h-[86vh] bg-[url('https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1800&q=80')] bg-cover bg-center"
>
  <div class="absolute inset-0 bg-gradient-to-b from-[rgba(7,10,15,0.2)] to-[rgba(6,8,12,0.82)]"></div>
  <div class="absolute inset-0 bg-[radial-gradient(circle_at_10%_40%,rgba(204,94,54,0.24),transparent_35%)]"></div>

  <div class="relative z-10 grid min-h-[86vh] grid-rows-[auto_1fr_auto] px-5 py-8 sm:px-10">
    <header class="flex flex-wrap items-start justify-center gap-4 sm:justify-between">
      <a class="site-button-ghost" href="#experience">Menu</a>
      <div class="text-center">
        <p class="text-eyebrow">Brasserie</p>
        <h1 class="m-1 font-display text-[clamp(2.1rem,4vw,3.2rem)] tracking-[0.04em] text-[#ef7f54]">
          {site.title}
        </h1>
        <p class="text-eyebrow">{site.tagline}</p>
      </div>
      <a class="site-button-ghost" href="/pages/contact">Reserve</a>
    </header>

    <div class="mx-auto grid max-w-5xl content-center text-center">
      <p class="text-eyebrow">Regional Ingredients, Elevated</p>
      <h2
        class="mx-0 mb-6 mt-4 font-display text-[clamp(2.3rem,7vw,5rem)] leading-[1.03] uppercase tracking-[0.05em]"
      >
        Enjoy Signature Flavors Crafted For Your Next Evening Out
      </h2>
      <a class="site-button-cta justify-self-center" href="/pages/contact">Book A Table</a>
    </div>

    <div class="flex items-center justify-center gap-3 text-xs uppercase tracking-[0.12em] sm:justify-self-end">
      <span>Follow us</span>
      <a class="border-b border-white/35 no-underline" href={site.facebookUrl}>Facebook</a>
      <a class="border-b border-white/35 no-underline" href={site.instagramUrl}>Instagram</a>
    </div>
  </div>
</section>

<section class="bg-[var(--site-paper)] px-5 pb-10 pt-16 text-center text-[#141414] sm:px-8" id="experience">
  <p class="text-eyebrow">Welcome to</p>
  <h3
    class="m-0 mb-4 mt-2 font-display text-[clamp(2rem,5vw,3rem)] uppercase tracking-[0.08em] text-[var(--site-accent)]"
  >
    {site.title}
  </h3>
  <p class="mx-auto max-w-3xl">
    Thoughtful plates, warm hospitality, and a lively room designed for lunch meetings, date nights, and
    weekend catchups. Keep this copy simple and update it for each business handoff.
  </p>
</section>

<section class="grid gap-5 bg-[var(--site-paper)] px-4 pb-20 sm:grid-cols-3 sm:px-8">
  <article class="border border-[#231c1829] bg-[#f4efe6] text-[#111]">
    <div
      class="aspect-[5/4] bg-cover bg-center"
      style="background-image: linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.72)), url('https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?auto=format&fit=crop&w=900&q=80')"
    ></div>
    <div class="px-4 pb-6 pt-5 text-center">
      <h4 class="mb-20 mt-[-4.9rem] font-display text-[clamp(1.5rem,3.5vw,2.2rem)] uppercase tracking-[0.08em] text-white">
        Lunch
      </h4>
      <a class="site-button-outline" href="/pages/contact">View Lunch Menu</a>
    </div>
  </article>
  <article class="border border-[#231c1829] bg-[#f4efe6] text-[#111]">
    <div
      class="aspect-[5/4] bg-cover bg-center"
      style="background-image: linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.72)), url('https://images.unsplash.com/photo-1551183053-bf91a1d81141?auto=format&fit=crop&w=900&q=80')"
    ></div>
    <div class="px-4 pb-6 pt-5 text-center">
      <h4 class="mb-20 mt-[-4.9rem] font-display text-[clamp(1.5rem,3.5vw,2.2rem)] uppercase tracking-[0.08em] text-white">
        Dinner
      </h4>
      <a class="site-button-outline" href="/pages/contact">View Dinner Menu</a>
    </div>
  </article>
  <article class="border border-[#231c1829] bg-[#f4efe6] text-[#111]">
    <div
      class="aspect-[5/4] bg-cover bg-center"
      style="background-image: linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.72)), url('https://images.unsplash.com/photo-1514361892635-6d5c17b7f63c?auto=format&fit=crop&w=900&q=80')"
    ></div>
    <div class="px-4 pb-6 pt-5 text-center">
      <h4 class="mb-20 mt-[-4.9rem] font-display text-[clamp(1.5rem,3.5vw,2.2rem)] uppercase tracking-[0.08em] text-white">
        Drinks
      </h4>
      <a class="site-button-outline" href="/pages/contact">View Drinks Menu</a>
    </div>
  </article>
</section>

<footer class="grid gap-6 border-t border-white/10 bg-[#101214] px-5 py-8 sm:grid-cols-3 sm:px-8">
  <div>
    <strong class="mb-2 block uppercase tracking-[0.11em]">{site.title}</strong>
    <p class="my-1 text-[#d8d6d1]">{site.address}</p>
    <p class="my-1 text-[#d8d6d1]"><a href={phoneHref}>{site.phone}</a></p>
    <p class="my-1 text-[#d8d6d1]"><a href={`mailto:${site.email}`}>{site.email}</a></p>
  </div>
  <div>
    <strong class="mb-2 block uppercase tracking-[0.11em]">Hours</strong>
    <p class="my-1 whitespace-pre-line text-[#d8d6d1]">{hoursLines.join('\n')}</p>
  </div>
  <div>
    <strong class="mb-2 block uppercase tracking-[0.11em]">Plan Your Visit</strong>
    <p class="my-1 text-[#d8d6d1]">Use this as your service-first homepage and publish updates in your posts section.</p>
    <a class="mt-3 inline-block border-b border-[var(--site-accent)] text-xs font-bold uppercase tracking-[0.1em] no-underline" href="/pages/contact"
      >Reserve Now</a
    >
    <a class="mt-4 block w-fit bg-[var(--site-accent)] px-4 py-2.5 text-xs font-bold uppercase tracking-[0.1em] text-white no-underline" href="/admin"
      >Edit Site Content</a
    >
  </div>
</footer>
