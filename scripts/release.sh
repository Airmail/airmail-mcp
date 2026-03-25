#!/bin/bash
set -euo pipefail

BUMP=${1:-patch}

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./scripts/release.sh [patch|minor|major]"
  exit 1
fi

# Verify we're on main
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently on $BRANCH)"
  exit 1
fi

echo "==> Syncing tools..."
npm run sync-tools

echo "==> Building..."
npm run build

echo "==> Bumping version ($BUMP)..."
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)

echo "==> Committing..."
git add package.json manifest.json scripts/ src/ .github/
git commit -m "Release $NEW_VERSION"

echo "==> Pushing..."
git push origin main

echo "==> Creating GitHub release..."
gh release create "$NEW_VERSION" --title "$NEW_VERSION" --generate-notes

echo "==> Done! $NEW_VERSION will be published to npm by GitHub Actions."
