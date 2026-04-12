#!/bin/bash
#
# Syncs shared files from base templates to their cloudflare variants.
# Run this after making changes to template src/, seed/, or tsconfig.json.
#
# Usage: ./scripts/sync-cloudflare-templates.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$ROOT_DIR/templates"

# Files/directories to sync from base template to cloudflare variant
SYNC_ITEMS=(
	"src"
	"public"
	"seed"
	"tsconfig.json"
	"emdash-env.d.ts"
	".gitignore"
)

# Template pairs: base -> cloudflare variant
TEMPLATE_PAIRS=(
	"blog:blog-cloudflare"
	"marketing:marketing-cloudflare"
	"portfolio:portfolio-cloudflare"
	"starter:starter-cloudflare"
)

sync_template() {
	local base="$1"
	local variant="$2"
	local base_dir="$TEMPLATES_DIR/$base"
	local variant_dir="$TEMPLATES_DIR/$variant"

	if [[ ! -d "$base_dir" ]]; then
		echo "  Skipping: $base (base not found)"
		return
	fi

	if [[ ! -d "$variant_dir" ]]; then
		echo "  Skipping: $variant (variant not found)"
		return
	fi

	echo "Syncing $base -> $variant"

	for item in "${SYNC_ITEMS[@]}"; do
		local src="$base_dir/$item"
		local dest="$variant_dir/$item"

		if [[ ! -e "$src" ]]; then
			continue
		fi

		if [[ -d "$src" ]]; then
			# Clean up if dest exists but isn't a directory
			if [[ -L "$dest" || ( -e "$dest" && ! -d "$dest" ) ]]; then
				rm "$dest"
			fi
			mkdir -p "$dest"
			rsync -a --delete \
				--exclude="worker.ts" \
				"$src/" "$dest/"
			echo "  Synced directory: $item"
		else
			if [[ -L "$dest" ]]; then
				rm "$dest"
			elif [[ -f "$dest" ]]; then
				rm "$dest"
			fi
			cp "$src" "$dest"
			echo "  Copied file: $item"
		fi
	done
}

echo "Syncing cloudflare template variants..."
echo ""

for pair in "${TEMPLATE_PAIRS[@]}"; do
	IFS=':' read -r base variant <<< "$pair"
	sync_template "$base" "$variant"
	echo ""
done

echo "Done!"
