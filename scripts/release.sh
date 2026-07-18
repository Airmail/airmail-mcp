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
NEW_VERSION_NUMBER=${NEW_VERSION#v}

echo "==> Syncing manifest version..."
node -e "const fs=require('fs'); const manifest=JSON.parse(fs.readFileSync('manifest.json','utf8')); manifest.version=process.argv[1]; fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');" "$NEW_VERSION_NUMBER"

echo "==> Rebuilding package..."
npm run build

echo "==> Committing..."
git add package.json package-lock.json manifest.json tool-metadata.json README.md scripts/ src/ .github/
git commit -m "Release $NEW_VERSION" -m "Sync generated MCP metadata, package metadata, and build output for the npm/GitHub release."

echo "==> Pushing..."
git push origin main

echo "==> Creating GitHub release..."
gh release create "$NEW_VERSION" --title "$NEW_VERSION" --generate-notes

echo "==> Done! $NEW_VERSION will be published to npm by GitHub Actions."
