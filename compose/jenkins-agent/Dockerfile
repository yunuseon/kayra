# =============================================================================
# Jenkins Inbound Agent — git + buildctl + jq, nothing app-specific.
#
# Deliberately has NO docker CLI and no docker socket: it runs code from
# arbitrary branches, and the host's socket would make that host root. Images
# are built by buildkitd over TCP. No language toolchain either: apps build and
# test inside their Dockerfiles, so a new app never changes this image.
# =============================================================================

FROM jenkins/inbound-agent:3386.v353e57a_1b_ea_0-1-jdk21

USER root

# renovate: datasource=github-releases depName=moby/buildkit
ARG BUILDKIT_VERSION=v0.34.0

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl jq && \
    arch="$(dpkg --print-architecture)" && \
    curl -fsSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${arch}.tar.gz" \
      | tar -xz -C /usr/local bin/buildctl && \
    rm -rf /var/lib/apt/lists/*

USER jenkins
