<script lang="ts">
  let { className = '' } = $props<{ className?: string }>();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden="true"
>
  <circle cx="12" cy="12" r="9"></circle>
  <path d="M9.8 9.2a2.2 2.2 0 1 1 3.6 2l-1 1"></path>
  <path d="M12 16.4h.01"></path>
</svg>
