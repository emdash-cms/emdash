#!/bin/bash
#
# Sync demos that should match the blog templates exactly.
#
# Deliberately custom demos (not synced here):
# - demos/plugins-demo (plugin API/hook coverage)
#
# Demos with custom runtime/config but shared visual template:
# - demos/cloudflare (kitchen sink Cloudflare features, AI Search header)
# - demos/playground (playground-specific runtime wiring, bundled seed media)
# - demos/preview (preview DB workflow)
# - demos/postgres (Postgres adapter coverage)
#
# Usage: ./scripts/sync-blog-demos.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$ROOT_DIR/templates"
DEMOS_DIR="$ROOT_DIR/demos"

# Files/directories to sync from template to demo.
# Intentionally excludes package.json and astro.config.mjs so demo package
# identity/scripts and plugin wiring stay stable.
SYNC_ITEMS=(
	"src"
	"public"
	"seed"
	"tsconfig.json"
	"emdash-env.d.ts"
	".gitignore"
)

# Mapping of template -> demo for demos that should track templates verbatim.
DEMO_PAIRS=(
	"blog:simple"
)

# Mapping of template -> demo for demos that should share the template frontend
# while keeping runtime-specific config/entry files.
FRONTEND_PAIRS=(
	"blog-cloudflare:cloudflare"
	"blog-cloudflare:preview"
	"blog:playground"
	"blog:postgres"
)

# Demos that keep their own seed. The playground's seed references bundled
# media instead of the template's remote image URLs.
CUSTOM_SEED_DEMOS=(
	"playground"
)

sync_demo() {
	local template="$1"
	local demo="$2"
	local template_dir="$TEMPLATES_DIR/$template"
	local demo_dir="$DEMOS_DIR/$demo"

	if [[ ! -d "$template_dir" ]]; then
		echo "  Skipping: $template (template not found)"
		return
	fi

	if [[ ! -d "$demo_dir" ]]; then
		echo "  Skipping: $demo (demo not found)"
		return
	fi

	echo "Syncing $template -> $demo"

	for item in "${SYNC_ITEMS[@]}"; do
		local src="$template_dir/$item"
		local dest="$demo_dir/$item"

		if [[ ! -e "$src" ]]; then
			continue
		fi

		if [[ -L "$dest" ]]; then
			rm "$dest"
		elif [[ -d "$dest" ]]; then
			rm -rf "$dest"
		elif [[ -f "$dest" ]]; then
			rm "$dest"
		fi

		if [[ -d "$src" ]]; then
			cp -r "$src" "$dest"
			echo "  Copied directory: $item"
		else
			cp "$src" "$dest"
			echo "  Copied file: $item"
		fi
	done
}

sync_frontend() {
	local template="$1"
	local demo="$2"
	shift 2
	local template_dir="$TEMPLATES_DIR/$template"
	local demo_dir="$DEMOS_DIR/$demo"

	if [[ ! -d "$template_dir/src" ]]; then
		echo "  Skipping frontend sync: $template (template src not found)"
		return
	fi

	if [[ ! -d "$demo_dir/src" ]]; then
		echo "  Skipping frontend sync: $demo (demo src not found)"
		return
	fi

	echo "Syncing frontend $template -> $demo"

	local rsync_args=("-a" "--delete")
	for preserved in "$@"; do
		rsync_args+=("--exclude=$preserved")
	done

	rsync "${rsync_args[@]}" "$template_dir/src/" "$demo_dir/src/"

	if [[ -f "$template_dir/emdash-env.d.ts" ]]; then
		cp "$template_dir/emdash-env.d.ts" "$demo_dir/emdash-env.d.ts"
		echo "  Copied file: emdash-env.d.ts"
	fi

	if [[ " ${CUSTOM_SEED_DEMOS[*]} " == *" $demo "* ]]; then
		echo "  Kept custom seed"
	elif [[ -d "$template_dir/seed" && -d "$demo_dir/seed" ]]; then
		rsync -a --delete "$template_dir/seed/" "$demo_dir/seed/"
		echo "  Synced directory: seed"
	fi
}

echo "Syncing demos from templates..."
echo ""

for pair in "${DEMO_PAIRS[@]}"; do
	IFS=':' read -r template demo <<< "$pair"
	sync_demo "$template" "$demo"
	echo ""
done

for pair in "${FRONTEND_PAIRS[@]}"; do
	IFS=':' read -r template demo <<< "$pair"
	case "$demo" in
	cloudflare)
		# Base.astro and 404.astro open the AI Search modal instead of linking
		# to /search, which this demo doesn't have. Port template changes to
		# them by hand.
		sync_frontend "$template" "$demo" \
			"worker.ts" \
			"layouts/Base.astro" \
			"pages/404.astro" \
			"pages/search.astro" \
			"pages/api" \
			"pages/als-test.astro" \
			"pages/sandbox-test.astro" \
			"pages/sandbox-plugin-test.astro"
		;;
	playground)
		sync_frontend "$template" "$demo" "worker.ts"
		;;
	preview)
		sync_frontend "$template" "$demo" "worker.ts" "middleware.ts"
		;;
	postgres)
		sync_frontend "$template" "$demo"
		;;
	esac
	echo ""
done

echo "Done!"
