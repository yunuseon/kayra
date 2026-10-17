# =============================================================================
# The builder — git, buildctl, jq, yq and node: it clones app repositories,
# builds their images through buildkitd and answers forge webhooks.
#
# Deliberately has NO docker CLI and no docker socket: it handles code from
# arbitrary commits, and the host's socket would make that host root. Images
# are built by buildkitd over TCP. No language toolchain either: apps build and
# test inside their Dockerfiles, so a new app never changes this image.
#
# Context: <platform_dir>/kayra, copied by the platform role (the deployer's
# code and the platform scripts).
# =============================================================================

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

# renovate: datasource=github-releases depName=moby/buildkit
ARG BUILDKIT_VERSION=v0.34.0
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=v4.54.1

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git jq && \
    arch="$(dpkg --print-architecture)" && \
    curl -fsSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${arch}.tar.gz" \
      | tar -xz -C /usr/local bin/buildctl && \
    curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${arch}" && \
    chmod +x /usr/local/bin/yq && \
    rm -rf /var/lib/apt/lists/* && \
    install -d -o node -g node /work

COPY --chmod=0755 kayra-deployer /usr/local/bin/kayra-deployer
COPY app /opt/kayra
# The code is ES modules, from either a checkout (.ts) or the package (.js).
RUN echo '{"type": "module"}' > /opt/kayra/package.json

USER node
ENTRYPOINT ["kayra-deployer"]
