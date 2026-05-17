<section class="admin-panel grid gap-0">
  <div class="flex items-start justify-between gap-3">

    <p class="admin-save-state m-0 mt-1 text-emerald-600">Saved</p>
  </div>

  <div class="flex items-end gap-5 border-b-transparent pb-0.5" style={`border-color: var(--admin-panel-border);`}>
    <button class="border-b-2 border-[var(--admin-text-strong)] bg-transparent px-0 py-3 text-base font-semibold text-[var(--admin-text-strong)]">
      Business Identity
    </button>
    <button class="border-b-2 border-transparent bg-transparent px-0 py-3 text-base font-semibold text-[var(--admin-text-soft)]">
      Hours
    </button>
  </div>

  <div class="rounded-xl border p-4" style={`border-color: var(--admin-panel-border);`}>
    <div class="grid gap-3 md:grid-cols-2">
      <label class="admin-label">Business Name *<input class="admin-input" value="Arthur's Hotdogs" /></label>
      <label class="admin-label">Phone<input class="admin-input" value="(555) 123-4567" /></label>
      <label class="admin-label">Tagline<input class="admin-input" value="Elevated American dining served with southern flair." /></label>
      <label class="admin-label">Email<input class="admin-input" value="info@arthurshotdogs.com" /></label>
      <label class="admin-label">Short Description<textarea class="admin-textarea min-h-28">Arthur's Hotdogs offers elevated American cuisine with a touch of Southern flair. Join us for an unforgettable dining experience.</textarea></label>
      <div class="grid gap-3">
        <label class="admin-label">Address<input class="admin-input" value="123 Main Street, Your City, ST 12345" /></label>
        <label class="admin-label">Facebook URL<input class="admin-input" value="https://facebook.com/arthurshotdogs" /></label>
        <label class="admin-label">Instagram URL<input class="admin-input" value="https://instagram.com/arthurshotdogs" /></label>
      </div>
    </div>

    <div class="mt-5 grid gap-3 md:grid-cols-2">
      <article class="rounded-xl border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-row-bg);`}>
        <p class="m-0 text-sm font-medium text-[var(--admin-text-strong)]">Logo</p>
        <div class="mt-2 flex items-center gap-3">
          <span class="inline-flex h-10 w-10 items-center justify-center rounded-full border text-xs" style={`border-color: var(--admin-panel-border);`}>LOGO</span>
          <div>
            <p class="m-0 text-sm text-[var(--admin-text-strong)]">arthurs-hotdogs-logo.png</p>
            <p class="m-0 text-xs text-[var(--admin-text-soft)]">120 KB</p>
          </div>
        </div>
        <div class="mt-3 flex gap-2">
          <button class="admin-pill-ghost !min-h-0 !px-3 !py-1.5 !text-xs">Replace</button>
          <button class="admin-pill-ghost !min-h-0 !px-3 !py-1.5 !text-xs">Remove</button>
        </div>
      </article>

      <article class="rounded-xl border p-3" style={`border-color: var(--admin-panel-border); background: var(--admin-row-bg);`}>
        <p class="m-0 text-sm font-medium text-[var(--admin-text-strong)]">Favicon</p>
        <div class="mt-2 flex items-center gap-3">
          <span class="inline-flex h-10 w-10 items-center justify-center rounded-full border text-xs" style={`border-color: var(--admin-panel-border);`}>ICO</span>
          <div>
            <p class="m-0 text-sm text-[var(--admin-text-strong)]">favicon.ico</p>
            <p class="m-0 text-xs text-[var(--admin-text-soft)]">8 KB</p>
          </div>
        </div>
        <div class="mt-3 flex gap-2">
          <button class="admin-pill-ghost !min-h-0 !px-3 !py-1.5 !text-xs">Replace</button>
          <button class="admin-pill-ghost !min-h-0 !px-3 !py-1.5 !text-xs">Remove</button>
        </div>
      </article>
    </div>
  </div>

  <div class="flex justify-end">
    <button class="admin-pill mt-6">Save Changes</button>
  </div>
</section>
