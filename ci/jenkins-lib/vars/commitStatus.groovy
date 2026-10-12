// Posts a status to the commit on its forge, linking back to this run: GitHub
// through the GitHub plugin, any other host as Forgejo (Gitea's API, which has
// the same statuses endpoint), with the git-credentials token. A failed post
// is logged, never fatal.
def call(Map checked, String context, String state, String message) {
    if (!checked) return
    if (checked.GIT_URL.startsWith('https://github.com/')) {
        step([
            $class: 'GitHubCommitStatusSetter',
            reposSource: [$class: 'ManuallyEnteredRepositorySource', url: checked.GIT_URL],
            commitShaSource: [$class: 'ManuallyEnteredShaSource', sha: checked.GIT_COMMIT],
            contextSource: [$class: 'ManuallyEnteredCommitContextSource', context: context],
            statusBackrefSource: [$class: 'ManuallyEnteredBackrefSource', backref: env.BUILD_URL],
            errorHandlers: [[$class: 'ShallowAnyErrorHandler']],
            statusResultSource: [$class: 'ConditionalStatusResultSource', results: [
                [$class: 'AnyBuildResult', state: state, message: message]
            ]]
        ])
        return
    }
    def api = forgejoStatusUrl(checked.GIT_URL, checked.GIT_COMMIT)
    def body = groovy.json.JsonOutput.toJson([
        state: state.toLowerCase(), context: context, description: message, target_url: env.BUILD_URL,
    ])
    try {
        withCredentials([usernamePassword(credentialsId: 'git-credentials', usernameVariable: 'FORGE_USER', passwordVariable: 'FORGE_TOKEN')]) {
            withEnv(["STATUS_API=${api}", "STATUS_BODY=${body}"]) {
                def code = sh(returnStdout: true, script: '''
                    curl -s -o /dev/null -w '%{http_code}' -X POST "$STATUS_API" \
                        -H "Authorization: token $FORGE_TOKEN" -H 'Content-Type: application/json' \
                        --data "$STATUS_BODY"
                ''').trim()
                if (code != '201') echo "commitStatus: ${context} not posted, Forgejo answered ${code}"
            }
        }
    } catch (e) {
        echo "commitStatus: ${context} not posted: ${e.message}"
    }
}

// The run's final result as a status, for post { always { … } }.
def result(Map checked, String context) {
    def states = [SUCCESS: 'SUCCESS', UNSTABLE: 'FAILURE', FAILURE: 'FAILURE', ABORTED: 'ERROR', NOT_BUILT: 'ERROR']
    def result = currentBuild.currentResult
    call(checked, context, states[result] ?: 'ERROR', "${result.toLowerCase().capitalize()}")
}

// http://forgejo:3000/owner/repo.git -> http://forgejo:3000/api/v1/repos/owner/repo/statuses/<sha>
@NonCPS
private String forgejoStatusUrl(String gitUrl, String sha) {
    def m = gitUrl =~ /^(https?:\/\/[^\/]+)\/([^\/]+)\/([^\/]+?)(\.git)?\/?$/
    if (!m.matches()) throw new IllegalArgumentException("not a Forgejo repo URL: ${gitUrl}")
    return "${m.group(1)}/api/v1/repos/${m.group(2)}/${m.group(3)}/statuses/${sha}"
}
