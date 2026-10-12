// =============================================================================
// appDeploy — the deploy pipeline of every app, defined by the platform.
//
//   Prepare (unprivileged agent): check out REF, plan images, build what is
//     missing, stash images.env + the compose files app.yml lists at REF.
//   Deploy (controller, the only node with the docker socket):
//     Admission — the resolved compose config must pass compose-policy.sh.
//     Up        — docker compose up --wait, then record the release.
//
// The compose files come from the commit being deployed, so what the policy
// checks is exactly what runs, and a rollback restores that commit's compose
// too. Hosts and secret names come from the job (operator-approved at
// `kayra apps`), never from the app's repo at REF.
//
//   app: [name, repo, ref, path, hosts, secrets]
// =============================================================================
def call(Map app) {
    def checked = null
    // Empty on a job's very first run (see appBuild).
    def ref = params.REF ?: app.ref
    def composeFiles = []

    pipeline {
        agent none

        parameters {
            string(name: 'REF', defaultValue: app.ref, description: 'Branch, tag or commit SHA to deploy')
        }

        options {
            timestamps()
            disableConcurrentBuilds()
            timeout(time: 20, unit: 'MINUTES')
        }

        stages {
            stage('Prepare') {
                agent { label 'buildkit' }
                steps {
                    script {
                        checked = appCheckout(app, ref)
                        currentBuild.displayName = "#${env.BUILD_NUMBER} ${checked.GIT_COMMIT.substring(0, 12)}"
                        currentBuild.description = ref
                        commitStatus(checked, 'jenkins/deploy', 'PENDING', 'Deploying')

                        // No "./" prefix for an app at its repo root: stash's Ant patterns
                        // would not match it.
                        composeFiles = readYaml(file: "${app.path}/app.yml").compose.collect { app.path == '.' ? it : "${app.path}/${it}" }
                        def plan = imagePlan(app)
                        writeFile file: 'images.env', text: plan.collect { "${it.var}=${it.ref}" }.join('\n') + '\n'
                        stash name: 'deploy', includes: (['images.env'] + composeFiles).join(',')

                        plan.each { artifact ->
                            stage(artifact.name) {
                                platformScript('resolve-images.sh', "${app.name} ${app.path} --ensure ${artifact.name}")
                            }
                        }
                    }
                }
            }

            stage('Deploy') {
                agent { label 'built-in' }
                stages {
                    stage('Admission') {
                        steps {
                            unstash 'deploy'
                            script {
                                def policy = platformScript.path('compose-policy.sh')
                                withAppSecrets(app) {
                                    sh "${compose(app, composeFiles)} config --no-env-resolution --format json | bash ${policy} ${app.name} ${app.hosts.join(' ')}"
                                }
                            }
                        }
                    }
                    stage('Up') {
                        steps {
                            script {
                                withAppSecrets(app) {
                                    // --remove-orphans: a service the app dropped from its
                                    // compose files must not keep running.
                                    sh "${compose(app, composeFiles)} up -d --wait --wait-timeout 180 --remove-orphans"
                                }
                                platformScript('record-release.sh', "${app.name} images.env ${checked.GIT_COMMIT}")
                            }
                        }
                    }
                }
            }
        }

        // agent none leaves post without a node, and the status step needs one.
        post {
            always {
                script { node('built-in') { commitStatus.result(checked, 'jenkins/deploy') } }
            }
        }
    }
}

// The app's compose project: its .env from the platform (operator config), the
// image refs from this run, the compose files from the commit being deployed.
private String compose(Map app, List files) {
    def dir = "${env.APPS_DIR}/${app.name}"
    return "docker compose -p ${app.name} --project-directory ${dir} --env-file ${dir}/.env --env-file images.env " +
        files.collect { "-f '${it}'" }.join(' ')
}

// Credential IDs are <app>-<key>, lower-case, dashes: the prefix is added
// here, from the job's app name, so no app can name another app's credential.
private void withAppSecrets(Map app, Closure body) {
    def bindings = app.secrets.collect { key ->
        string(credentialsId: "${app.name}-${key.toLowerCase().replace('_', '-')}", variable: key)
    }
    withCredentials(bindings, body)
}
