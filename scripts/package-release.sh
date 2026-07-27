#!/usr/bin/env bash

set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "JSON.parse(require('fs').readFileSync('$repo_dir/manifest.json', 'utf8')).version")
archive_name="Bili-Pilot-$version.zip"
output_dir="$repo_dir/dist"
stage_dir=$(mktemp -d /tmp/bili-pilot-release.XXXXXX)
stage_archive="$stage_dir/$archive_name"

cleanup() {
  if [[ -d "$stage_dir" ]]; then
    find "$stage_dir" -depth -delete
  fi
}
trap cleanup EXIT

mkdir -p "$output_dir" "$stage_dir/bili-pilot"

runtime_files=(
  LICENSE
  README.md
  README.zh-CN.md
  auto-probe-policy.js
  cached-xhr.js
  content.js
  core.js
  i18n.js
  manifest.json
  page-hook.js
  page-protocol.js
  prefetch-policy.js
  prefetch-runtime.js
  prefetch-store.js
  probe-core.js
  protocol.js
  ui-model.js
)

for source_name in "${runtime_files[@]}"; do
  cp "$repo_dir/$source_name" "$stage_dir/bili-pilot/$source_name"
done
cp -R "$repo_dir/_locales" "$stage_dir/bili-pilot/_locales"

# Package only public image assets that are tracked by Git. Local captures and
# marketing work may live under docs/images without leaking into a release ZIP.
while IFS= read -r -d '' image_path; do
  mkdir -p "$stage_dir/bili-pilot/$(dirname "$image_path")"
  cp "$repo_dir/$image_path" "$stage_dir/bili-pilot/$image_path"
done < <(git -C "$repo_dir" ls-files -z -- docs/images)

(
  cd "$stage_dir"
  zip -q -r -X "$stage_archive" bili-pilot
)

mv "$stage_archive" "$output_dir/$archive_name"
unzip -t "$output_dir/$archive_name" >/dev/null
(
  cd "$output_dir"
  shasum -a 256 "$archive_name" > "$archive_name.sha256"
)

echo "$output_dir/$archive_name"
echo "$output_dir/$archive_name.sha256"
