#!/usr/bin/env bash
# Creates separate Git worktrees so Codex and Claude Code can work in parallel.
#
#   feature/ai-backend  -> ../<repo>-codex   (Codex)
#   feature/clinical-ui -> ../<repo>-claude  (Claude Code)
#
# Usage: scripts/setup-worktrees.sh [--base <branch>] [--dir <parent-dir>] [--install] [--dry-run]
#
# Safety: never resets, checks out over, stashes, deletes or force-pushes anything.
# It is safe to run more than once: existing branches and worktrees are reused or skipped.
set -euo pipefail

BASE=""
PARENT=""
INSTALL=0
DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --dir) PARENT="$2"; shift 2 ;;
    --install) INSTALL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

run() { if [[ $DRY -eq 1 ]]; then echo "[dry-run] $*"; else "$@"; fi; }
info() { echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not inside a Git repository." >&2; exit 1; }
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
REPO_NAME="$(basename "$ROOT")"
PARENT="${PARENT:-$(dirname "$ROOT")}"

# 1. Empty repository: create an initial commit WITHOUT touching the index or working tree.
if ! git rev-parse --verify --quiet HEAD >/dev/null; then
  info "Repository has no commits yet; creating an empty root commit (your files are left untouched)."
  EMPTY_TREE="$(git hash-object -t tree /dev/null)"
  if [[ $DRY -eq 0 ]]; then
    COMMIT="$(git commit-tree "$EMPTY_TREE" -m "chore: initialize repository")"
    git update-ref HEAD "$COMMIT"
  else
    echo "[dry-run] git commit-tree <empty-tree> && git update-ref HEAD <commit>"
  fi
fi

# 2. Pick the base branch.
if [[ -z "$BASE" ]]; then
  if git show-ref --verify --quiet refs/heads/main; then BASE="main"; else BASE="$(git symbolic-ref --short HEAD)"; fi
fi
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { [[ $DRY -eq 1 ]] || { echo "Base '$BASE' not found." >&2; exit 1; }; }
info "Base branch: $BASE"

if [[ -n "$(git status --porcelain)" ]]; then
  warn "The main checkout has uncommitted changes. They stay here and are NOT copied into the new worktrees."
fi

# 3. Create each worktree.
create_worktree() {
  local branch="$1" path="$2" owner="$3"
  info "$owner: $branch -> $path"

  if [[ -e "$path" ]]; then
    if git worktree list --porcelain | grep -qx "worktree $(cd "$path" 2>/dev/null && pwd -P)"; then
      echo "    already exists, skipping"
    else
      warn "$path exists and is not a worktree of this repo; skipping (nothing touched)."
    fi
    return
  fi

  if git worktree list --porcelain | grep -qx "branch refs/heads/$branch"; then
    warn "$branch is already checked out in another worktree; skipping."
    return
  fi

  if git show-ref --verify --quiet "refs/heads/$branch"; then
    run git worktree add "$path" "$branch"
  elif git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    run git worktree add --track -b "$branch" "$path" "origin/$branch"
  else
    run git worktree add -b "$branch" "$path" "$BASE"
  fi

  if [[ $INSTALL -eq 1 && $DRY -eq 0 && -f "$path/package-lock.json" ]]; then
    (cd "$path" && npm ci)
  fi
}

create_worktree "feature/ai-backend" "$PARENT/$REPO_NAME-codex" "Codex"
create_worktree "feature/clinical-ui" "$PARENT/$REPO_NAME-claude" "Claude Code"

info "Done. Current worktrees:"
git worktree list
cat <<MSG

Next steps:
  Codex:  cd "$PARENT/$REPO_NAME-codex"  && npm ci && cp .env.example .env.local
  Claude: cd "$PARENT/$REPO_NAME-claude" && npm ci && cp .env.example .env.local
Push with: git push -u origin <branch>. Merge through pull requests only.
MSG
