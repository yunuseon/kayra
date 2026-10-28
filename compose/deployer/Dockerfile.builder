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

FROM node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a

# renovate: datasource=github-releases depName=moby/buildkit
ARG BUILDKIT_VERSION=v0.34.1
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
