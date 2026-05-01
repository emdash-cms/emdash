/**
 * Playground Toolbar
 *
 * A floating pill injected by the playground middleware into HTML responses.
 * Shows edit toggle, time remaining, reset button, and deploy CTA.
 * No dependencies -- plain HTML string with inline styles and a <script> tag.
 *
 * The edit toggle sets the emdash-edit-mode cookie, same as the normal
 * visual editing toolbar. The data-edit-mode attribute on the toolbar div
 * activates the hover outlines on [data-emdash-ref] elements via CSS :has().
 */

export interface PlaygroundToolbarConfig {
	/** When the playground was created (ISO string) */
	createdAt: string;
	/** TTL in seconds */
	ttl: number;
	/** Whether edit mode is currently active */
	editMode: boolean;
}

const RE_AMP = /&/g;
const RE_QUOT = /"/g;
const RE_LT = /</g;
const RE_GT = />/g;

export function renderPlaygroundToolbar(config: PlaygroundToolbarConfig): string {
	const { createdAt, ttl, editMode } = config;

	return `
<!-- EmDash Playground Toolbar -->
<div id="emdash-playground-toolbar" data-created-at="${escapeAttr(createdAt)}" data-ttl="${ttl}" data-edit-mode="${editMode}">
  <div class="ec-pg-inner">
    <span class="ec-pg-badge">Playground</span>

    <div class="ec-pg-divider"></div>

    <label class="ec-pg-toggle" title="Toggle visual editing">
      <input type="checkbox" id="ec-pg-edit-toggle" ${editMode ? "checked" : ""} />
      <span class="ec-pg-toggle-track">
        <span class="ec-pg-toggle-thumb"></span>
      </span>
      <span class="ec-pg-toggle-label">Edit</span>
    </label>

    <div class="ec-pg-divider"></div>

    <span class="ec-pg-status" id="ec-pg-status"></span>

    <div class="ec-pg-divider"></div>

    <button class="ec-pg-btn ec-pg-btn--reset" id="ec-pg-reset" title="Reset playground">
      <svg class="ec-pg-icon" id="ec-pg-reset-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    </button>

    <a class="ec-pg-btn ec-pg-btn--deploy" href="https://github.com/emdash-cms/emdash" target="_blank" rel="noopener">
      Deploy your own
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    </a>

    <button class="ec-pg-btn ec-pg-close" id="ec-pg-dismiss" title="Dismiss toolbar">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>
</div>

<style>
  #emdash-playground-toolbar {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1;
    -webkit-font-smoothing: antialiased;
  }

  @media (max-width: 639px) {
    #emdash-playground-toolbar {
      max-width: calc(100vw - 2rem);
      width: 100%;
    }
  }

  #emdash-playground-toolbar.ec-pg-hidden {
    display: none;
  }

  .ec-pg-inner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px 8px 16px;
    background: #1a1a1a;
    color: #e0e0e0;
    border-radius: 999px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.08);
    white-space: nowrap;
    user-select: none;
  }

  @media (max-width: 639px) {
    .ec-pg-inner {
      flex-wrap: wrap;
      justify-content: center;
      border-radius: .75rem;
    }
  }

  .ec-pg-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    background: rgba(234,179,8,0.2);
    color: #facc15;
  }

  .ec-pg-divider {
    width: 1px;
    height: 16px;
    background: rgba(255,255,255,0.15);
  }

  /* Edit toggle */
  .ec-pg-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .ec-pg-toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .ec-pg-toggle-track {
    position: relative;
    width: 28px;
    height: 16px;
    border-radius: 999px;
    background: rgba(255,255,255,0.15);
    transition: background 0.15s;
  }

  .ec-pg-toggle input:checked + .ec-pg-toggle-track {
    background: #3b82f6;
  }

  .ec-pg-toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s;
  }

  .ec-pg-toggle input:checked + .ec-pg-toggle-track .ec-pg-toggle-thumb {
    transform: translateX(12px);
  }

  .ec-pg-toggle-label {
    font-size: 12px;
    font-weight: 500;
    color: #999;
    transition: color 0.15s;
  }

  .ec-pg-toggle input:checked ~ .ec-pg-toggle-label {
    color: #e0e0e0;
  }

  .ec-pg-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #999;
  }

  .ec-pg-status--warning {
    color: #fbbf24;
  }

  .ec-pg-status--expired {
    color: #f87171;
  }

  .ec-pg-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
    font-family: inherit;
    text-decoration: none;
  }

  .ec-pg-btn:hover {
    color: #fff;
    background: rgba(255,255,255,0.08);
  }

  .ec-pg-btn--deploy {
    gap: 5px;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 500;
    color: #facc15;
    background: rgba(234,179,8,0.12);
    border-radius: 999px;
  }

  .ec-pg-btn--deploy:hover {
    background: rgba(234,179,8,0.22);
    color: #fde047;
  }

  .ec-pg-icon {
    transition: transform 0.3s;
  }

  .ec-pg-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ec-pg-btn:disabled:hover {
    color: #888;
    background: none;
  }

  @keyframes ec-pg-spin {
    to { transform: rotate(360deg); }
  }

  .ec-pg-spinning .ec-pg-icon {
    animation: ec-pg-spin 0.8s linear infinite;
  }

  /* Edit mode: editable hover styles (mirrors the visual editing toolbar CSS) */
  body:has(#emdash-playground-toolbar[data-edit-mode="true"]) [data-emdash-ref] {
    transition: box-shadow 0.15s, background-color 0.15s;
  }

  body:has(#emdash-playground-toolbar[data-edit-mode="true"]) [data-emdash-ref]:hover {
    box-shadow: 0 0 0 2px rgba(59,130,246,0.5);
    border-radius: 4px;
    background-color: rgba(59,130,246,0.04);
    cursor: text;
  }
</style>

<script>
(function() {
  var toolbar = document.getElementById("emdash-playground-toolbar");
  var statusEl = document.getElementById("ec-pg-status");
  var resetBtn = document.getElementById("ec-pg-reset");
  var dismissBtn = document.getElementById("ec-pg-dismiss");
  var editToggle = document.getElementById("ec-pg-edit-toggle");
  if (!toolbar || !statusEl || !resetBtn || !dismissBtn || !editToggle) return;

  var createdAt = toolbar.getAttribute("data-created-at");
  var ttl = parseInt(toolbar.getAttribute("data-ttl") || "3600", 10);

  function getRemaining() {
    if (!createdAt) return 0;
    var created = new Date(createdAt).getTime();
    var expiresAt = created + ttl * 1000;
    return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  }

  function formatRemaining(seconds) {
    if (seconds <= 0) return "Expired";
    var m = Math.floor(seconds / 60);
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + "h " + m + "m";
    }
    return m + "m remaining";
  }

  function updateStatus() {
    var remaining = getRemaining();
    statusEl.textContent = formatRemaining(remaining);
    if (remaining <= 0) {
      statusEl.className = "ec-pg-status ec-pg-status--expired";
    } else if (remaining < 300) {
      statusEl.className = "ec-pg-status ec-pg-status--warning";
    } else {
      statusEl.className = "ec-pg-status";
    }
  }

  updateStatus();
  // Update every 30s -- no seconds shown so no need for frequent updates
  var interval = setInterval(updateStatus, 30000);

  // Edit mode toggle -- sets cookie and reloads.
  // Use location.reload() rather than location.replace(location.href): the
  // latter can be served from cache or the bfcache without re-running the
  // server, so the new cookie value never round-trips. Skipping the same-
  // document view-transition wrapper avoids a race against the document
  // unload that can cancel the navigation in some browsers. See #878.
  editToggle.addEventListener("change", function() {
    if (editToggle.checked) {
      document.cookie = "emdash-edit-mode=true;path=/;samesite=lax";
      toolbar.setAttribute("data-edit-mode", "true");
    } else {
      document.cookie = "emdash-edit-mode=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT";
      toolbar.setAttribute("data-edit-mode", "false");
    }
    location.reload();
  });

  resetBtn.addEventListener("click", function() {
    resetBtn.disabled = true;
    resetBtn.classList.add("ec-pg-spinning");
    statusEl.className = "ec-pg-status";
    statusEl.textContent = "Resetting\\u2026";
    location.href = "/_playground/reset";
  });

  dismissBtn.addEventListener("click", function() {
    toolbar.classList.add("ec-pg-hidden");
    clearInterval(interval);
  });
})();
</script>
`;
}

function escapeAttr(str: string): string {
	return str
		.replace(RE_AMP, "&amp;")
		.replace(RE_QUOT, "&quot;")
		.replace(RE_LT, "&lt;")
		.replace(RE_GT, "&gt;");
}
