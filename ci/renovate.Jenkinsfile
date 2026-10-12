// =============================================================================
// Platform — Renovate: opens PRs that bump pinned versions (images, Jenkins
// plugins, Ansible collections, OpenTofu providers, app dependencies) in this
// repo, as configured in renovate.json at its root.
//
// On the controller, like every platform job, but Renovate itself runs in its
// own container without the docker socket: it only needs the network and the
// token. Runs on each server with renovate_repositories in its vars.yml.
// =============================================================================
pipeline {
    agent { label 'built-in' }

    parameters {
        booleanParam(name: 'DRY_RUN', defaultValue: false, description: 'Log what would change, open no PRs')
    }

    options {
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 60, unit: 'MINUTES')
    }

    stages {
        stage('Renovate') {
            steps {
                withCredentials([string(credentialsId: 'renovate-token', variable: 'RENOVATE_TOKEN')]) {
                    // RENOVATE_REPOSITORIES (a JSON list), _PLATFORM, _ENDPOINT,
                    // _GIT_URL, _HOST_RULES and _GITHUB_COM_TOKEN come from the
                    // platform .env: the server's renovate_* vars. The optional
                    // ones only when set.
                    // On platform-internal, where a Forgejo on the same server is.
                    sh '''
                        docker run --rm --network platform-internal \
                            -e RENOVATE_TOKEN \
                            -e RENOVATE_PLATFORM \
                            ${RENOVATE_ENDPOINT:+-e RENOVATE_ENDPOINT} \
                            ${RENOVATE_GIT_URL:+-e RENOVATE_GIT_URL} \
                            ${RENOVATE_HOST_RULES:+-e RENOVATE_HOST_RULES} \
                            ${RENOVATE_GITHUB_COM_TOKEN:+-e RENOVATE_GITHUB_COM_TOKEN} \
                            -e RENOVATE_REPOSITORIES \
                            -e RENOVATE_DRY_RUN="$( [ "$DRY_RUN" = true ] && echo full || echo null )" \
                            -e LOG_LEVEL=info \
                            renovate/renovate:44.115.10
                    '''
                }
            }
        }
    }
}
