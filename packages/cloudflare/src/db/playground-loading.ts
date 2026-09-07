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
    --step-size: 28px;
    --step-gap: 14px;
    --step-ring-idle: #363634;
    --step-core-idle: #454542;
    --step-orange: #d9784f;
    --step-orange-light: #ffb17f;
    --step-green: #168c58;
    --step-green-ring: #163b2e;
    --connector-track: #30302e;
    --connector-fill: #565652;
    --label: #e3e3de;
    --label-muted: #777773;
    --label-complete: #78c99e;

    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 32px;
  }

  .pg-logo {
    align-self: flex-start;
    display: flex;
    align-items: center;
    justify-content: flex-start;
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

  .pg-message {
    display: grid;
    font-size: 17px;
    font-weight: 500;
    color: #888;
    line-height: 1.5;
    text-align: left;
  }

  .pg-message > span {
    grid-area: 1 / 1;
  }

  .pg-message-measure {
    visibility: hidden;
  }

  .pg-steps {
    display: flex;
    flex-direction: column;
    gap: var(--step-gap);
    margin-top: 18px;
    text-align: left;
  }

  .pg-step {
    position: relative;
    display: grid;
    grid-template-columns: var(--step-size) minmax(0, 1fr);
    column-gap: 10px;
    min-width: 0;
    align-items: center;
  }

  .pg-step-marker {
    position: relative;
    z-index: 1;
    display: grid;
    width: var(--step-size);
    height: var(--step-size);
    place-items: center;
  }

  .pg-ring {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .pg-ring-track,
  .pg-ring-progress {
    fill: none;
    stroke-width: 10;
  }

  .pg-ring-track {
    stroke: var(--step-ring-idle);
  }

  .pg-ring-progress {
    stroke: var(--step-orange-light);
    stroke-linecap: butt;
    stroke-dasharray: 14 86;
    opacity: 0;
    transform: rotate(-90deg);
    transform-origin: center;
    transition: opacity 250ms ease-in;
  }

  .pg-step.active .pg-ring,
  .pg-step.completing .pg-ring {
    animation: pg-ring-spin 800ms linear infinite;
  }

  .pg-step.active .pg-ring-progress,
  .pg-step.completing .pg-ring-progress,
  .pg-step.done .pg-ring-progress {
    opacity: 1;
  }

  .pg-step.completing .pg-ring-progress {
    stroke: var(--step-green-ring);
    stroke-dasharray: 100 0;
    transition:
      stroke 400ms ease,
      stroke-dasharray 400ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .pg-step.done .pg-ring-progress {
    stroke: var(--step-green-ring);
    stroke-dasharray: 100 0;
  }

  .pg-step-core {
    position: relative;
    display: grid;
    width: 64%;
    height: 64%;
    place-items: center;
    border-radius: 999px;
    background: var(--step-core-idle);
    transition: background-color 220ms ease;
  }

  .pg-step.active .pg-step-core {
    background: var(--step-orange);
  }

  .pg-step.completing .pg-step-core {
    background: var(--step-green);
    transition-duration: 400ms;
  }

  .pg-step.done .pg-step-core {
    background: var(--step-green);
  }

  .pg-check {
    width: 52%;
    height: 52%;
    fill: none;
    stroke: white;
    stroke-width: 3.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0;
    transform: scale(0.35);
    transition:
      opacity 400ms cubic-bezier(0.16, 1, 0.3, 1),
      transform 400ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .pg-step.completing .pg-check,
  .pg-step.done .pg-check {
    opacity: 1;
    transform: scale(1);
  }

  .pg-connector {
    position: absolute;
    z-index: 0;
    top: calc(var(--step-size) + 3px);
    left: calc(var(--step-size) / 2 - 1px);
    width: 2px;
    height: calc(var(--step-gap) - 6px);
    overflow: hidden;
    border-radius: 999px;
    background: var(--connector-track);
  }

  .pg-connector-fill {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    background: var(--connector-fill);
    transform: scaleY(0);
    transform-origin: center top;
  }

  .pg-step.completing .pg-connector-fill {
    transform: scaleY(1);
    transition: transform 300ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  .pg-step.done .pg-connector-fill {
    transform: scaleY(1);
  }

  .pg-step-label {
    color: var(--label-muted);
    font-size: 15px;
    font-weight: 500;
    line-height: 1.35;
    transition: color 220ms ease;
  }

  .pg-step.active .pg-step-label {
    color: var(--label);
  }

  .pg-step.completing .pg-step-label,
  .pg-step.done .pg-step-label {
    color: var(--label-complete);
    transition-duration: 400ms;
  }

  @keyframes pg-ring-spin {
    to { transform: rotate(360deg); }
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

  @media (prefers-reduced-motion: reduce) {
    .pg-step.active .pg-ring,
    .pg-step.completing .pg-ring {
      animation: none;
    }

    .pg-ring-progress,
    .pg-step.completing .pg-ring-progress,
    .pg-step-core,
    .pg-step.completing .pg-step-core,
    .pg-check,
    .pg-connector-fill,
    .pg-step.completing .pg-connector-fill,
    .pg-step-label,
    .pg-step.completing .pg-step-label {
      transition: none;
    }
  }
</style>
</head>
<body>
<div class="pg-loading">
  <div class="pg-logo"><svg viewBox="0 0 75 75" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="69" height="69" rx="10.518" stroke="url(#pl-b)" stroke-width="6"/><rect x="18" y="34" width="39.366" height="6.561" fill="url(#pl-d)"/><defs><linearGradient id="pl-b" x1="-43" y1="124" x2="92.42" y2="-41.75" gradientUnits="userSpaceOnUse"><stop stop-color="#0F006B"/><stop offset=".08" stop-color="#281A81"/><stop offset=".17" stop-color="#5D0C83"/><stop offset=".25" stop-color="#911475"/><stop offset=".33" stop-color="#CE2F55"/><stop offset=".42" stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/><stop offset=".58" stop-color="#FBAD41"/><stop offset=".67" stop-color="#FFCD89"/><stop offset=".75" stop-color="#FFE9CB"/><stop offset=".83" stop-color="#FFF7EC"/><stop offset=".92" stop-color="#FFF8EE"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="pl-d" x1="91.5" y1="27.5" x2="28.12" y2="54.18" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset=".13" stop-color="#FFF8EE"/><stop offset=".62" stop-color="#FBAD41"/><stop offset=".85" stop-color="#F6821F"/><stop offset="1" stop-color="#FF6633"/></linearGradient></defs></svg>EmDash</div>

  <div>
    <div class="pg-message" role="status" aria-live="polite" aria-atomic="true">
      <span id="pg-message">Creating your playground&hellip;</span>
      <span class="pg-message-measure" aria-hidden="true">Creating your playground&hellip;</span>
    </div>
    <div class="pg-steps" id="pg-steps">
      <div class="pg-step active" id="step-db">
        <span class="pg-connector" aria-hidden="true"><span class="pg-connector-fill"></span></span>
        <span class="pg-step-marker" aria-hidden="true">
          <svg class="pg-ring" viewBox="0 0 80 80">
            <circle class="pg-ring-track" cx="40" cy="40" r="35" />
            <circle class="pg-ring-progress" cx="40" cy="40" r="35" pathLength="100" />
          </svg>
          <span class="pg-step-core">
            <svg class="pg-check" viewBox="0 0 24 24"><path d="m5 12.5 4.25 4.25L19 7" /></svg>
          </span>
        </span>
        <span class="pg-step-label">Setting up database</span>
      </div>
      <div class="pg-step" id="step-content">
        <span class="pg-connector" aria-hidden="true"><span class="pg-connector-fill"></span></span>
        <span class="pg-step-marker" aria-hidden="true">
          <svg class="pg-ring" viewBox="0 0 80 80">
            <circle class="pg-ring-track" cx="40" cy="40" r="35" />
            <circle class="pg-ring-progress" cx="40" cy="40" r="35" pathLength="100" />
          </svg>
          <span class="pg-step-core">
            <svg class="pg-check" viewBox="0 0 24 24"><path d="m5 12.5 4.25 4.25L19 7" /></svg>
          </span>
        </span>
        <span class="pg-step-label">Loading demo content</span>
      </div>
      <div class="pg-step" id="step-ready">
        <span class="pg-step-marker" aria-hidden="true">
          <svg class="pg-ring" viewBox="0 0 80 80">
            <circle class="pg-ring-track" cx="40" cy="40" r="35" />
            <circle class="pg-ring-progress" cx="40" cy="40" r="35" pathLength="100" />
          </svg>
          <span class="pg-step-core">
            <svg class="pg-check" viewBox="0 0 24 24"><path d="m5 12.5 4.25 4.25L19 7" /></svg>
          </span>
        </span>
        <span class="pg-step-label">Almost ready</span>
      </div>
    </div>
  </div>

  <div class="pg-error" id="pg-error">
    <div class="pg-error-message" id="pg-error-message" role="alert"></div>
    <button class="pg-retry-btn" id="pg-retry">Try again</button>
  </div>
</div>

<script>
(function() {
  var steps = ["step-db", "step-content", "step-ready"];
  var stepTimers = [];
  var completionDuration = 400;
  var nextStepDelay = 150;

  function setStepState(index, state) {
    var step = document.getElementById(steps[index]);
    if (step) step.className = "pg-step" + (state ? " " + state : "");
  }

  function clearStepTimers() {
    stepTimers.forEach(function(timer) { clearTimeout(timer); });
    stepTimers = [];
  }

  function completeStep(index, nextIndex) {
    setStepState(index, "completing");

    if (nextIndex !== undefined) {
      stepTimers.push(setTimeout(function() {
        setStepState(nextIndex, "active");
      }, nextStepDelay));
    }
    stepTimers.push(setTimeout(function() {
      setStepState(index, "done");
    }, completionDuration));
  }

  function showReady() {
    clearStepTimers();
    setStepState(0, "done");
    setStepState(1, "done");
    setStepState(2, "completing");
    document.getElementById("pg-message").textContent = "Ready!";
    stepTimers.push(setTimeout(function() {
      setStepState(2, "done");
      location.replace("/_emdash/admin");
    }, completionDuration));
  }

  function showError(message) {
    document.getElementById("pg-message").textContent = "Something went wrong";
    document.getElementById("pg-steps").style.display = "none";
    var errorEl = document.getElementById("pg-error");
    var errorMsg = document.getElementById("pg-error-message");
    if (errorEl) errorEl.className = "pg-error visible";
    if (errorMsg) errorMsg.textContent = message;
  }

  function init() {
    clearStepTimers();
    steps.forEach(function(_, index) {
      setStepState(index, index === 0 ? "active" : "");
    });
    document.getElementById("pg-message").textContent = "Creating your playground\\u2026";
    document.getElementById("pg-steps").style.display = "";
    var errorEl = document.getElementById("pg-error");
    if (errorEl) errorEl.className = "pg-error";

    stepTimers.push(setTimeout(function() { completeStep(0, 1); }, 800));
    stepTimers.push(setTimeout(function() { completeStep(1, 2); }, 2000));

    fetch("/_playground/init", { method: "POST", credentials: "same-origin" })
      .then(function(response) {
        if (!response.ok) {
          return response.json().then(function(body) {
            throw new Error(body.error?.message || "Initialization failed");
          });
        }
        return response.json();
      })
      .then(showReady)
      .catch(function(err) {
        clearStepTimers();
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
