#!/usr/bin/env bash

set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
browser=${1:-chrome}
version=$(node -p "JSON.parse(require('fs').readFileSync('$repo_dir/manifest.json', 'utf8')).version")
output_dir="$repo_dir/dist"
stage_dir=$(mktemp -d /tmp/bili-pilot-release.XXXXXX)

if [[ "$browser" != "chrome" && "$browser" != "firefox" ]]; then
  echo "Usage: $0 chrome|firefox" >&2
  exit 2
fi

if [[ "$browser" == "chrome" ]]; then
  artifact_name="Bili-Pilot-Chrome-$version.zip"
  stage_root="$stage_dir/bili-pilot"
else
  artifact_name="Bili-Pilot-Firefox-$version.xpi"
  stage_root="$stage_dir/firefox"
fi

cleanup() {
  if [[ -d "$stage_dir" ]]; then
    find "$stage_dir" -depth -delete
  fi
}
trap cleanup EXIT

mkdir -p "$output_dir" "$stage_root"

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
  cp "$repo_dir/$source_name" "$stage_root/$source_name"
done
cp -R "$repo_dir/_locales" "$stage_root/_locales"

if [[ "$browser" == "chrome" ]]; then
  stage_artifact="$stage_dir/$artifact_name"
  (
    cd "$stage_dir"
    zip -q -r -X "$stage_artifact" bili-pilot
  )
else
  : "${AMO_JWT_ISSUER:?Set AMO_JWT_ISSUER to sign the Firefox XPI}"
  : "${AMO_JWT_SECRET:?Set AMO_JWT_SECRET to sign the Firefox XPI}"
  signed_dir="$stage_dir/signed"
  mkdir -p "$signed_dir"
  npx --yes web-ext@10.5.0 sign \
    --source-dir "$stage_root" \
    --artifacts-dir "$signed_dir" \
    --channel unlisted \
    --api-key "$AMO_JWT_ISSUER" \
    --api-secret "$AMO_JWT_SECRET" \
    --no-input
  stage_artifact=$(find "$signed_dir" -maxdepth 1 -type f -name '*.xpi' -print -quit)
  if [[ -z "$stage_artifact" ]]; then
    echo "Mozilla signing completed without producing an XPI" >&2
    exit 1
  fi
fi

mv "$stage_artifact" "$output_dir/$artifact_name"
unzip -t "$output_dir/$artifact_name" >/dev/null
(
  cd "$output_dir"
  shasum -a 256 "$artifact_name" > "$artifact_name.sha256"
)

echo "$output_dir/$artifact_name"
echo "$output_dir/$artifact_name.sha256"
