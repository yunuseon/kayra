#!/usr/bin/env bash
# =============================================================================
# record-release.sh <app> <images.env> <sha> — note what an app just shipped.
#
# One file per deploy: $JENKINS_HOME/releases/<app>/<UTC time>-<sha>.env,
# holding the images.env that was deployed. The rollback job offers these as
# targets; registry-gc.sh keeps every image the newest records reference.
#
# Runs on the controller at the end of an app's deploy stage.
# =============================================================================
set -euo pipefail

app="${1:?Usage: record-release.sh <app> <images.env> <sha>}"
images="${2:?}"
sha="${3:?}"

dir="${JENKINS_HOME:?}/releases/${app}"
mkdir -p "$dir"
cp "$images" "${dir}/$(date -u +%Y%m%dT%H%M%SZ)-${sha}.env"
