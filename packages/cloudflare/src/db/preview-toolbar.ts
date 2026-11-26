/**
 * Preview Toolbar
 *
 * A floating pill injected by the preview middleware into HTML responses.
 * Shows preview status, snapshot age, reload button, and errors.
 * No dependencies — plain HTML string with inline styles and a <script> tag.
 */

export interface PreviewToolbarConfig {
	/** When the snapshot was generated (ISO string) */
	generatedAt?: string;
	/** Source site URL */
	source?: string;
	/** Error message if snapshot failed */
	error?: string;
}

const RE_AMP = /&/g;
const RE_QUOT = /"/g;
const RE_LT = /</g;
const RE_GT = />/g;

export function renderPreviewToolbar(config: PreviewToolbarConfig): string {
	const { generatedAt, source, error } = config;

	const generatedAtAttr = generatedAt ? ` data-generated-at="${escapeAttr(generatedAt)}"` : "";
	const sourceAttr = source ? ` data-source="${escapeAttr(source)}"` : "";
	const errorAttr = error ? ` data-error="${escapeAttr(error)}"` : "";

	return `
<!-- EmDash Preview Toolbar -->
<div id="emdash-preview-toolbar"${generatedAtAttr}${sourceAttr}${errorAttr}>
  <div class="ec-ptb-inner">
    <span class="ec-ptb-badge">Preview</span>

    <div class="ec-ptb-divider"></div>

    <span class="ec-ptb-status" id="ec-ptb-status"></span>

    <button class="ec-ptb-btn" id="ec-ptb-reload" title="Reload snapshot">
      <svg class="ec-ptb-icon" id="ec-ptb-reload-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    </button>

    <button class="ec-ptb-btn ec-ptb-close" id="ec-ptb-dismiss" title="Dismiss toolbar">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>
</div>

<style>
  #emdash-preview-toolbar {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: calc(100% - 2rem);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1;
    -webkit-font-smoothing: antialiased;
  }

  #emdash-preview-toolbar.ec-ptb-hidden {
    display: none;
  }

  .ec-ptb-inner {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
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
    .ec-ptb-inner {
      border-radius: .75rem;
    }
  }

  .ec-ptb-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    background: rgba(139,92,246,0.2);
    color: #a78bfa;
  }

  .ec-ptb-divider {
    width: 1px;
    height: 16px;
    background: rgba(255,255,255,0.15);
  }

  .ec-ptb-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #999;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .ec-ptb-status--error {
    color: #f87171;
  }

  .ec-ptb-btn {
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
  }

  .ec-ptb-btn:hover {
    color: #fff;
    background: rgba(255,255,255,0.08);
  }

  .ec-ptb-icon {
    transition: transform 0.3s;
  }

  .ec-ptb-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ec-ptb-btn:disabled:hover {
    color: #888;
    background: none;
  }

  @keyframes ec-ptb-spin {
    to { transform: rotate(360deg); }
  }

  .ec-ptb-spinning .ec-ptb-icon {
    animation: ec-ptb-spin 0.8s linear infinite;
  }
</style>

<script>
(function() {
  var toolbar = document.getElementById("emdash-preview-toolbar");
  var statusEl = document.getElementById("ec-ptb-status");
  var reloadBtn = document.getElementById("ec-ptb-reload");
  var dismissBtn = document.getElementById("ec-ptb-dismiss");
  if (!toolbar || !statusEl || !reloadBtn || !dismissBtn) return;

  var generatedAt = toolbar.getAttribute("data-generated-at");
  var source = toolbar.getAttribute("data-source");
  var error = toolbar.getAttribute("data-error");

  function formatAge(isoString) {
    if (!isoString) return null;
    var then = new Date(isoString).getTime();
    var now = Date.now();
    var seconds = Math.floor((now - then) / 1000);
    if (seconds < 60) return "just now";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  }

  function updateStatus() {
    if (error) {
      statusEl.className = "ec-ptb-status ec-ptb-status--error";
      statusEl.textContent = error;
      return;
    }
    var age = formatAge(generatedAt);
    statusEl.className = "ec-ptb-status";
    statusEl.textContent = age ? "Snapshot " + age : "Preview mode";
  }

  updateStatus();

  // Update age display every 30s
  var ageInterval = setInterval(updateStatus, 30000);

  // Reload: hit the server endpoint which clears the httpOnly session cookie
  // and redirects back with the original signed params for a fresh snapshot.
  reloadBtn.addEventListener("click", function() {
    reloadBtn.disabled = true;
    reloadBtn.classList.add("ec-ptb-spinning");
    statusEl.className = "ec-ptb-status";
    statusEl.textContent = "Reloading\u2026";
    location.href = "/_preview/reload";
  });

  // Dismiss
  dismissBtn.addEventListener("click", function() {
    toolbar.classList.add("ec-ptb-hidden");
    clearInterval(ageInterval);
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
