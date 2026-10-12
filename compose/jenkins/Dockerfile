# =============================================================================
# Jenkins Controller — LTS with Docker CLI, Compose, buildctl and JCasC
# =============================================================================

FROM jenkins/jenkins:2.580.1-lts-jdk21

USER root

# renovate: datasource=github-releases depName=moby/buildkit
ARG BUILDKIT_VERSION=v0.34.0

# Install Docker CLI + Compose plugin
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg jq && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      docker-ce-cli docker-compose-plugin && \
    arch="$(dpkg --print-architecture)" && \
    curl -fsSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${arch}.tar.gz" \
      | tar -xz -C /usr/local bin/buildctl && \
    rm -rf /var/lib/apt/lists/*

USER jenkins

# Install plugins
COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

# JCasC fragments are bind-mounted, not baked in; CASC_JENKINS_CONFIG is set in
# compose. That keeps config out of the image and out of the jenkins-home volume.
# notifyCommit without a token, but only to trigger polling: how Forgejo tells
# Jenkins about a push, over platform-internal (Traefik does not route it).
ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false -Dhudson.plugins.git.GitStatus.NOTIFY_COMMIT_ACCESS_CONTROL=disabled-for-polling"
