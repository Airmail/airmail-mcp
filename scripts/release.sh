#!/bin/bash
set -e

BUMP=${1:-patch}

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./scripts/release.sh [patch|minor|major]"
  exit 1
fi

echo "==> Syncing tools..."
npm run sync-tools

echo "==> Building..."
npm run build

echo "==> Bumping version ($BUMP)..."
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)

echo "==> Committing..."
git add -A
git commit -m "Release $NEW_VERSION"

echo "==> Pushing..."
git push origin main

echo "==> Creating GitHub release..."
gh release create "$NEW_VERSION" --title "$NEW_VERSION" --generate-notes

echo "==> Done! $NEW_VERSION will be published to npm by GitHub Actions."
