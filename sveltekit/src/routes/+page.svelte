<script lang="ts">
  import { site } from '$lib/content';

  const phoneHref = `tel:${site.phone.replace(/[^\d+]/g, '')}`;
</script>

<svelte:head>
  <title>{site.title}</title>
  <meta name="description" content={site.tagline} />
</svelte:head>

<section class="hero">
  <div class="hero-overlay"></div>
  <div class="hero-inner">
    <header class="hero-nav">
      <a class="ghost-button" href="#experience">Menu</a>
      <div class="brand">
        <p class="brand-kicker">Brasserie</p>
        <h1>{site.title}</h1>
        <p class="brand-sub">{site.tagline}</p>
      </div>
      <a class="ghost-button" href="/pages/contact">Reserve</a>
    </header>

    <div class="hero-copy">
      <p class="eyebrow">Regional Ingredients, Elevated</p>
      <h2>Enjoy Signature Flavors Crafted For Your Next Evening Out</h2>
      <a class="cta-button" href="/pages/contact">Book A Table</a>
    </div>

    <div class="hero-social">
      <span>Follow us</span>
      <a href={site.facebookUrl}>Facebook</a>
      <a href={site.instagramUrl}>Instagram</a>
    </div>
  </div>
</section>

<section class="intro" id="experience">
  <p class="eyebrow">Welcome to</p>
  <h3>{site.title}</h3>
  <p>
    Thoughtful plates, warm hospitality, and a lively room designed for lunch meetings, date nights, and
    weekend catchups. Keep this copy simple and update it for each business handoff.
  </p>
</section>

<section class="service-grid">
  <article class="service-card">
    <div class="card-image lunch"></div>
    <div class="card-body">
      <h4>Lunch</h4>
      <a href="/pages/contact">View Lunch Menu</a>
    </div>
  </article>
  <article class="service-card">
    <div class="card-image dinner"></div>
    <div class="card-body">
      <h4>Dinner</h4>
      <a href="/pages/contact">View Dinner Menu</a>
    </div>
  </article>
  <article class="service-card">
    <div class="card-image drinks"></div>
    <div class="card-body">
      <h4>Drinks</h4>
      <a href="/pages/contact">View Drinks Menu</a>
    </div>
  </article>
</section>

<footer class="landing-footer">
  <div>
    <strong>{site.title}</strong>
    <p>{site.address}</p>
    <p><a href={phoneHref}>{site.phone}</a></p>
    <p><a href={`mailto:${site.email}`}>{site.email}</a></p>
  </div>
  <div>
    <strong>Hours</strong>
    <p style="white-space: pre-line">{site.hours}</p>
  </div>
  <div>
    <strong>Plan Your Visit</strong>
    <p>Use this as your service-first homepage and publish updates in your posts section.</p>
    <a class="footer-cta" href="/pages/contact">Reserve Now</a>
    <a class="admin-cta" href="/admin">Edit Site Content</a>
  </div>
</footer>
