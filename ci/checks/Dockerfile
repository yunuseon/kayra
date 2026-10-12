# =============================================================================
# The checks — linters, validators and CLAUDE.md's rules, as a build. The
# context is the engine (KAYRA_ROOT); a fleet comes as the named context
# `fleet`, and CHECKS says which parts run (run.sh --platform / --fleet).
#
# The checks bring their own toolchain: the repo's workflow builds this, and
# the last RUN is the check. A failure fails the build.
#
#   docker build -f ci/checks/Dockerfile .                       # the engine alone
#   docker build -f infrastructure/ci/checks/Dockerfile --build-context fleet=. \
#     --build-arg CHECKS="--platform --fleet /fleet" infrastructure      # with a fleet
# =============================================================================
# The kayra CLI's dependencies, from its lockfile; the checks need only node itself.
FROM node:24.21.0-trixie-slim AS cli
WORKDIR /cli
COPY cli/package.json cli/package-lock.json ./
RUN npm ci --ignore-scripts

FROM python:3.14.8-slim-trixie AS tools

# renovate: datasource=github-releases depName=koalaman/shellcheck
ARG SHELLCHECK_VERSION=v0.11.0
# renovate: datasource=github-releases depName=opentofu/opentofu
ARG TOFU_VERSION=v1.13.1
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=v4.54.1
# renovate: datasource=github-releases depName=docker/compose
ARG COMPOSE_VERSION=v5.6.0
# renovate: datasource=pypi depName=ansible-lint
ARG ANSIBLE_LINT_VERSION=26.9.0
# renovate: datasource=pypi depName=ansible-core
ARG ANSIBLE_CORE_VERSION=2.21.5
# renovate: datasource=pypi depName=yamllint
ARG YAMLLINT_VERSION=1.38.0

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git jq xz-utils && \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) sc=x86_64; go=amd64; dc=x86_64 ;; \
      arm64) sc=aarch64; go=arm64; dc=aarch64 ;; \
    esac; \
    curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/${SHELLCHECK_VERSION}/shellcheck-${SHELLCHECK_VERSION}.linux.${sc}.tar.xz" \
      | tar -xJ --strip-components=1 -C /usr/local/bin "shellcheck-${SHELLCHECK_VERSION}/shellcheck"; \
    curl -fsSL "https://github.com/opentofu/opentofu/releases/download/${TOFU_VERSION}/tofu_${TOFU_VERSION#v}_linux_${go}.tar.gz" \
      | tar -xz -C /usr/local/bin tofu; \
    curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${go}"; \
    curl -fsSL -o /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${dc}"; \
    chmod +x /usr/local/bin/yq /usr/local/bin/docker-compose

RUN pip install --no-cache-dir \
      "ansible-core==${ANSIBLE_CORE_VERSION}" \
      "ansible-lint==${ANSIBLE_LINT_VERSION}" \
      "yamllint==${YAMLLINT_VERSION}"

COPY ansible/requirements.yml /tmp/requirements.yml
RUN ansible-galaxy collection install -r /tmp/requirements.yml

COPY --from=cli /usr/local/bin/node /usr/local/bin/node

# Replaced by --build-context fleet=<dir>; empty when the engine is checked alone.
FROM scratch AS fleet

FROM tools AS checks
ARG CHECKS=--platform
WORKDIR /kayra
COPY . .
COPY --from=cli /cli/node_modules cli/node_modules
COPY --from=fleet / /fleet
# OpenTofu's providers kept between runs, so the checks do not hang on GitHub.
RUN --mount=type=cache,id=tofu-providers,target=/root/.cache/tofu-providers \
    TF_PLUGIN_CACHE_DIR=/root/.cache/tofu-providers bash ci/checks/run.sh $CHECKS
