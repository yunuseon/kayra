// =============================================================================
// appBuild — the build pipeline of every app. Defined by the platform, never
// by the app: an app only supplies data (app.yml, image.json, Dockerfiles).
//
// Builds each artifact's content-addressed image if the registry lacks it, one
// stage per artifact, cached or not. A green build of the app's own ref (main)
// deploys exactly that commit.
//
//   app: [name, repo, ref, path] — rendered into the job by the platform role.
// =============================================================================
def call(Map app) {
    def checked = null
    // Empty on a job's very first run: parameters declared by the pipeline
    // only exist once it has run.
    def branch = params.BRANCH ?: app.ref

    pipeline {
        agent { label 'buildkit' }

        parameters {
            string(name: 'BRANCH', defaultValue: app.ref, description: 'Branch, tag or commit to build')
        }

        options {
            timestamps()
            disableConcurrentBuilds()
            buildDiscarder(logRotator(numToKeepStr: '20'))
            timeout(time: 30, unit: 'MINUTES')
        }

        stages {
            stage('Checkout') {
                steps {
                    script {
                        // Polling (and the GitHub push trigger, which polls)
                        // watches whatever the last build checked out with
                        // poll: true. A build of some other branch still has
                        // to register the app's own ref, or it would stop
                        // watching main until main is built again by hand.
                        if (branch != app.ref) {
                            dir("${env.WORKSPACE}@watch") { appCheckout(app, app.ref, true) }
                        }
                        checked = appCheckout(app, branch, branch == app.ref)
                        commitStatus(checked, 'jenkins/build', 'PENDING', 'Building images')
                    }
                }
            }

            stage('Images') {
                steps {
                    script {
                        imagePlan(app).each { artifact ->
                            stage(artifact.name) {
                                platformScript('resolve-images.sh', "${app.name} ${app.path} --ensure ${artifact.name}")
                            }
                        }
                    }
                }
            }
        }

        post {
            always {
                script { commitStatus.result(checked, 'jenkins/build') }
            }
            success {
                script {
                    // The exact commit, not the branch: it may have moved on,
                    // and that newer commit has not been built yet.
                    if (branch == app.ref) {
                        build job: "${app.name}/deploy", parameters: [string(name: 'REF', value: checked.GIT_COMMIT)], wait: false
                    }
                }
            }
            cleanup {
                cleanWs()
            }
        }
    }
}
