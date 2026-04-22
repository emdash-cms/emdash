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
  <path d="M5 11a7 7 0 0 1 14 0v6a2 2 0 0 1-2 2h-2"></path>
  <path d="M5 13h2a1.5 1.5 0 0 1 1.5 1.5V16A1.5 1.5 0 0 1 7 17H5z"></path>
  <path d="M19 13h-2a1.5 1.5 0 0 0-1.5 1.5V16A1.5 1.5 0 0 0 17 17h2z"></path>
  <path d="M9 19h6"></path>
</svg>
