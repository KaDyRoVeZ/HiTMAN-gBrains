#!/usr/bin/env bash
# scripts/ubicloud/build-ci-image.sh — build or refresh the `gbrain-ci`
# Ubicloud machine image, which `ci:ubicloud --image gbrain-ci@latest` (or
# UBI_CI_IMAGE) boots instead of stock Ubuntu so setup skips apt.
#
#   UBI_OWNER=gbra40 bash scripts/ubicloud/build-ci-image.sh [-l LOCATION] [-n IMAGE]
#
# Boots a stock Ubuntu 24.04 VM (standard-2 with 40 GiB, the largest disk a
# machine image accepts), runs `PREPARE_IMAGE=1 setup-ci-vm.sh` (the apt
# packages and both database images, nothing from the checkout), stops it and
# captures it as a new version of IMAGE, which becomes IMAGE@latest. The
# source VM is destroyed after capture. Rerun it when setup-ci-vm.sh's package
# list or images change; setup still pulls the floating image tags on every
# VM, so a stale image costs time, not correctness. To delete the image,
# destroy each version (`ubi-runner.sh cli mi LOCATION/IMAGE destroy-version
# -f VERSION`), then the image (`... destroy -f`).
set -euo pipefail

cd "$(dirname "$0")/../.."
RUNNER=scripts/ubicloud/ubi-runner.sh
location=${UBI_LOCATION:-eu-central-h1}
image=gbrain-ci
while [ $# -gt 0 ]; do
  case $1 in
    -l|--location) location=$2; shift 2 ;;
    -n|--name) image=$2; shift 2 ;;
    *) echo "build-ci-image: unknown option $1" >&2; exit 2 ;;
  esac
done

name=$(bash "$RUNNER" up -s standard-2 -S 40 -l "$location" | tail -1)
# Capture destroys the source VM; down confirms it is gone either way.
trap '[ -z "${name:-}" ] || bash "$RUNNER" down "$name" -l "$location"' EXIT
bash "$RUNNER" ssh "$name" 'PREPARE_IMAGE=1 bash -s' <scripts/ubicloud/setup-ci-vm.sh
bash "$RUNNER" cli vm "$location/$name" stop >/dev/null
for _ in $(seq 1 120); do
  [ "$(bash "$RUNNER" cli vm "$location/$name" show | sed -n 's/^state: //p')" = stopped ] && break
  sleep 3
done
if bash "$RUNNER" cli mi list | awk -v l="$location" -v n="$image" '$1 == l && $2 == n { found = 1 } END { exit !found }'; then
  bash "$RUNNER" cli mi "$location/$image" create-version -d "$name"
else
  bash "$RUNNER" cli mi "$location/$image" create -d "$name"
fi
for _ in $(seq 1 200); do
  versions=$(bash "$RUNNER" cli mi "$location/$image" list-versions)
  if awk '$NF == "true" && $3 == "ready" { found = 1 } END { exit !found }' <<<"$versions"; then
    echo "$versions"
    echo "build-ci-image: $location/$image@latest is ready"
    exit 0
  fi
  sleep 6
done
echo "build-ci-image: $location/$image did not become ready; check: $RUNNER cli mi $location/$image list-versions" >&2
exit 1
