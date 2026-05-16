#!/bin/bash
#
# Syncs agent skills and AGENTS.md into each template directory.
# Creates .claude/skills symlink and CLAUDE.md symlink for Claude Code compatibility.
#
# Usage: ./scripts/sync-template-skills.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SKILLS_DIR="$ROOT_DIR/skills"
TEMPLATES_DIR="$ROOT_DIR/templates"
AGENTS_BASE="$SCRIPT_DIR/agents-base.md"

# Skills to sync into templates
SKILLS=(
	"building-emdash-site"
	"creating-plugins"
	"emdash-cli"
)

sync_skills() {
	local template_dir="$1"
	local template_name="$(basename "$template_dir")"
	local agents_dir="$template_dir/.agents/skills"
	local claude_dir="$template_dir/.claude"

	echo "Syncing skills -> $template_name"

	for skill in "${SKILLS[@]}"; do
		local src="$SKILLS_DIR/$skill"
		local dest="$agents_dir/$skill"

		if [[ ! -d "$src" ]]; then
			echo "  Skipping: $skill (not found in skills/)"
			continue
		fi

		# Remove existing copy
		if [[ -d "$dest" ]]; then
			rm -rf "$dest"
		fi

		mkdir -p "$agents_dir"
		cp -r "$src" "$dest"
		echo "  Copied: $skill"
	done

	# Create .claude/skills symlink
	mkdir -p "$claude_dir"
	local symlink="$claude_dir/skills"
	if [[ -L "$symlink" ]]; then
		rm "$symlink"
	elif [[ -e "$symlink" ]]; then
		rm -rf "$symlink"
	fi
	ln -s ../.agents/skills "$symlink"
	echo "  Linked: .claude/skills -> ../.agents/skills"

	# Generate AGENTS.md = shared base + per-template body.
	# Per-template body lives in AGENTS-template.md inside the template (or in the
	# base variant for *-cloudflare templates, which don't carry their own body).
	if [[ -f "$AGENTS_BASE" ]]; then
		local template_body="$template_dir/AGENTS-template.md"
		if [[ ! -f "$template_body" ]]; then
			# Fall back to the base template body for *-cloudflare variants.
			local base_name="${template_name%-cloudflare}"
			if [[ "$base_name" != "$template_name" ]]; then
				template_body="$TEMPLATES_DIR/$base_name/AGENTS-template.md"
			fi
		fi

		if [[ -f "$template_body" ]]; then
			cat "$AGENTS_BASE" > "$template_dir/AGENTS.md"
			printf "\n" >> "$template_dir/AGENTS.md"
			cat "$template_body" >> "$template_dir/AGENTS.md"
			echo "  Generated: AGENTS.md (base + $(basename "$(dirname "$template_body")")/AGENTS-template.md)"
		else
			cp "$AGENTS_BASE" "$template_dir/AGENTS.md"
			echo "  Generated: AGENTS.md (base only, no AGENTS-template.md)"
		fi

		# Create CLAUDE.md symlink
		local claude_md="$template_dir/CLAUDE.md"
		if [[ -L "$claude_md" ]]; then
			rm "$claude_md"
		elif [[ -f "$claude_md" ]]; then
			rm "$claude_md"
		fi
		ln -s AGENTS.md "$claude_md"
		echo "  Linked: CLAUDE.md -> AGENTS.md"
	fi
}

echo "Syncing agent skills to templates..."
echo ""

for template_dir in "$TEMPLATES_DIR"/*/; do
	# Skip if not a directory
	[[ -d "$template_dir" ]] || continue
	sync_skills "$template_dir"
	echo ""
done

echo "Done!"
