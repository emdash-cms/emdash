---
"emdash": patch
---

Fixes the `Embed` component rendering unrelated links as YouTube or Vimeo players when they contain a video URL in their path or query string, or use a lookalike hostname. Video detection now recognizes only `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`, `vimeo.com`, and `www.vimeo.com`; other hosts remain links unless the block supplies HTML or an explicit audio/video provider.
