#!/usr/bin/env sh
set -eu
# pandacode-preview: http://localhost:4321/rss.xml
# Keep Astro in this terminal when it detects an agent session.
export ASTRO_DEV_BACKGROUND=1
exec pnpm --dir demos/simple dev --host localhost --port 4321
