/**
 * Playground Loading Page
 *
 * Rendered when a user first hits /playground. Shows an animated loading state
 * while the client-side JS calls /_playground/init to create the DO, run
 * migrations, and apply the seed. Once init completes, redirects to the admin.
 *
 * No dependencies -- plain HTML with inline styles and a <script> tag.
 */

export function renderPlaygroundLoadingPage(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>EmDash Playground</title>
<link rel="icon" href="data:image/svg+xml,<svg width='75' height='75' viewBox='0 0 75 75' fill='none' xmlns='http://www.w3.org/2000/svg'><rect x='3' y='3' width='69' height='69' rx='10.518' stroke='url(%23pb)' stroke-width='6'/><rect x='18' y='34' width='39.366' height='6.561' fill='url(%23pd)'/><defs><linearGradient id='pb' x1='-43' y1='124' x2='92.42' y2='-41.75' gradientUnits='userSpaceOnUse'><stop stop-color='%230F006B'/><stop offset='.08' stop-color='%23281A81'/><stop offset='.17' stop-color='%235D0C83'/><stop offset='.25' stop-color='%23911475'/><stop offset='.33' stop-color='%23CE2F55'/><stop offset='.42' stop-color='%23FF6633'/><stop offset='.5' stop-color='%23F6821F'/><stop offset='.58' stop-color='%23FBAD41'/><stop offset='.67' stop-color='%23FFCD89'/><stop offset='.75' stop-color='%23FFE9CB'/><stop offset='.83' stop-color='%23FFF7EC'/><stop offset='.92' stop-color='%23FFF8EE'/><stop offset='1' stop-color='white'/></linearGradient><linearGradient id='pd' x1='91.5' y1='27.5' x2='28.12' y2='54.18' gradientUnits='userSpaceOnUse'><stop stop-color='white'/><stop offset='.13' stop-color='%23FFF8EE'/><stop offset='.62' stop-color='%23FBAD41'/><stop offset='.85' stop-color='%23F6821F'/><stop offset='1' stop-color='%23FF6633'/></linearGradient></defs></svg>" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0a0a;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .pg-loading {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 32px;
  }

  .pg-logo {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #fff;
  }

  .pg-logo svg {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
  }

  .pg-spinner-wrap {
    position: relative;
    width: 48px;
    height: 48px;
  }

  .pg-spinner {
    width: 48px;
    height: 48px;
    border: 3px solid rgba(255, 255, 255, 0.08);
    border-top-color: #facc15;
    border-radius: 50%;
    animation: pg-spin 0.8s linear infinite;
  }

  @keyframes pg-spin {
    to { transform: rotate(360deg); }
  }

  .pg-message {
    font-size: 15px;
    color: #888;
    line-height: 1.5;
  }

  .pg-steps {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }

  .pg-step {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #555;
    transition: color 0.3s;
  }

  .pg-step.active {
    color: #ccc;
  }

  .pg-step.done {
    color: #4ade80;
  }

  .pg-step-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #333;
    flex-shrink: 0;
    transition: background 0.3s;
  }

  .pg-step.active .pg-step-dot {
    background: #facc15;
    box-shadow: 0 0 6px rgba(250, 204, 21, 0.4);
  }

  .pg-step.done .pg-step-dot {
    background: #4ade80;
  }

  .pg-error {
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .pg-error.visible {
    display: flex;
  }

  .pg-error-message {
    font-size: 14px;
    color: #f87171;
    max-width: 360px;
    line-height: 1.5;
  }

  .pg-retry-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    background: rgba(250, 204, 21, 0.12);
    color: #facc15;
    border: none;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }

  .pg-retry-btn:hover {
    background: rgba(250, 204, 21, 0.22);
  }
</style>
</head>
<body>
<div class="pg-loading">
  <div class="pg-logo"><svg viewBox="0 0 75 75" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="69" height="69" rx="10.518" stroke="url(#pl-b)" stroke-width="6"/><rect x="18" y="34" width="39.366" height="6.561" fill="url(#pl-d)"/><defs><linearGradient id="pl-b" x1="-43" y1="124" x2="92.42" y2="-41.75" gradientUnits="userSpaceOnUse"><stop stop-color="#0F006B"/><stop offset=".08" stop-color="#281A81"/><stop offset=".17" stop-color="#5D0C83"/><stop offset=".25" stop-color="#911475"/><stop offset=".33" stop-color="#CE2F55"/><stop offset=".42" stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/><stop offset=".58" stop-color="#FBAD41"/><stop offset=".67" stop-color="#FFCD89"/><stop offset=".75" stop-color="#FFE9CB"/><stop offset=".83" stop-color="#FFF7EC"/><stop offset=".92" stop-color="#FFF8EE"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="pl-d" x1="91.5" y1="27.5" x2="28.12" y2="54.18" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset=".13" stop-color="#FFF8EE"/><stop offset=".62" stop-color="#FBAD41"/><stop offset=".85" stop-color="#F6821F"/><stop offset="1" stop-color="#FF6633"/></linearGradient></defs></svg>EmDash</div>

  <div class="pg-spinner-wrap">
    <div class="pg-spinner" id="pg-spinner"></div>
  </div>

  <div>
    <div class="pg-message" id="pg-message">Creating your playground&hellip;</div>
    <div class="pg-steps" id="pg-steps">
      <div class="pg-step active" id="step-db">
        <span class="pg-step-dot"></span>
        Setting up database
      </div>
      <div class="pg-step" id="step-content">
        <span class="pg-step-dot"></span>
        Loading demo content
      </div>
      <div class="pg-step" id="step-ready">
        <span class="pg-step-dot"></span>
        Almost ready
      </div>
    </div>
  </div>

  <div class="pg-error" id="pg-error">
    <div class="pg-error-message" id="pg-error-message"></div>
    <button class="pg-retry-btn" id="pg-retry">Try again</button>
  </div>
</div>

<script>
(function() {
  var steps = ["step-db", "step-content", "step-ready"];
  var currentStep = 0;

  function setStep(index) {
    for (var i = 0; i < steps.length; i++) {
      var el = document.getElementById(steps[i]);
      if (!el) continue;
      el.className = "pg-step" + (i < index ? " done" : i === index ? " active" : "");
    }
    currentStep = index;
  }

  function showError(message) {
    document.getElementById("pg-spinner").style.display = "none";
    document.getElementById("pg-message").textContent = "Something went wrong";
    document.getElementById("pg-steps").style.display = "none";
    var errorEl = document.getElementById("pg-error");
    var errorMsg = document.getElementById("pg-error-message");
    if (errorEl) errorEl.className = "pg-error visible";
    if (errorMsg) errorMsg.textContent = message;
  }

  function init() {
    setStep(0);
    document.getElementById("pg-spinner").style.display = "";
    document.getElementById("pg-message").textContent = "Creating your playground\\u2026";
    document.getElementById("pg-steps").style.display = "";
    var errorEl = document.getElementById("pg-error");
    if (errorEl) errorEl.className = "pg-error";

    // Advance steps on a timer for visual feedback while init runs.
    // The actual init is a single server call -- these steps are cosmetic.
    var stepTimer = setTimeout(function() { setStep(1); }, 800);
    var stepTimer2 = setTimeout(function() { setStep(2); }, 2000);

    fetch("/_playground/init", { method: "POST", credentials: "same-origin" })
      .then(function(res) {
        clearTimeout(stepTimer);
        clearTimeout(stepTimer2);
        if (!res.ok) {
          return res.json().then(function(body) {
            throw new Error(body.error?.message || "Initialization failed");
          });
        }
        return res.json();
      })
      .then(function() {
        // Mark all steps done
        setStep(steps.length);
        document.getElementById("pg-message").textContent = "Ready!";
        // Brief pause so the user sees "Ready!" before navigating
        setTimeout(function() {
          location.replace("/_emdash/admin");
        }, 400);
      })
      .catch(function(err) {
        clearTimeout(stepTimer);
        clearTimeout(stepTimer2);
        showError(err.message || "Failed to create playground. Please try again.");
      });
  }

  document.getElementById("pg-retry").addEventListener("click", init);

  init();
})();
</script>
</body>
</html>`;
}
