// Checks out the app's repository at `ref` and returns checkout()'s map
// (GIT_COMMIT, GIT_URL). The app is data: nothing in it is executed by Jenkins
// except its Dockerfiles, inside BuildKit.
def call(Map app, String ref, boolean poll = false) {
    return checkout(
        scm: [
            $class: 'GitSCM',
            branches: [[name: ref]],
            userRemoteConfigs: [[url: app.repo, credentialsId: 'git-credentials']],
        ],
        poll: poll,
        changelog: poll,
    )
}
