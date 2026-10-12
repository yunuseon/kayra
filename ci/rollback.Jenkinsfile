// =============================================================================
// Platform — roll an app back to something it already shipped.
//
// Offers the app's release records (record-release.sh), newest first, minus
// the commit that is live now, and hands the chosen SHA to <app>/deploy as REF.
// That job and parameter are the whole contract with the app. The images are
// usually still in the registry; if GC took them, the deploy rebuilds them.
//
// agent none: input waits for a human, and must not hold the controller's
// only executor while it does.
// =============================================================================
pipeline {
    agent none

    options {
        timestamps()
        timeout(time: 15, unit: 'MINUTES')
    }

    stages {
        stage('Choose') {
            steps {
                script {
                    def apps = []
                    def releasesByApp = [:]
                    node('built-in') {
                        apps = sh(script: 'ls -1 "$JENKINS_HOME/releases" 2>/dev/null || true', returnStdout: true)
                            .trim().readLines().findAll { it }
                        apps.each { app ->
                            // <time>-<sha>.env, newest first, one line per distinct SHA.
                            releasesByApp[app] = sh(script: """
                                ls -1 "\$JENKINS_HOME/releases/${app}" | sort -r \
                                    | sed -E 's/^([0-9TZ]+)-([0-9a-f]+)\\.env\$/\\2 \\1/' \
                                    | awk '!seen[\$1]++'
                            """, returnStdout: true).trim().readLines()
                        }
                    }
                    if (!apps) {
                        error 'Nothing has been deployed yet, so there is nothing to roll back to.'
                    }

                    def app = apps.size() == 1 ? apps[0] : input(
                        message: 'Roll back which app?',
                        parameters: [choice(name: 'APP', choices: apps)]
                    )
                    // The first entry is what is live now.
                    def targets = releasesByApp[app].drop(1)
                    if (!targets) {
                        error "${app} has only ever shipped one commit."
                    }
                    def choice = input(
                        message: "${app} runs ${releasesByApp[app][0]}. Roll back to:",
                        parameters: [choice(name: 'RELEASE', choices: targets)]
                    )
                    def sha = choice.tokenize(' ')[0]

                    currentBuild.displayName = "#${env.BUILD_NUMBER} ${app} → ${sha.substring(0, 12)}"
                    build job: "${app}/deploy", parameters: [string(name: 'REF', value: sha)], wait: false
                }
            }
        }
    }
}
