// =============================================================================
// Platform — nightly registry garbage collection. See registry-gc.sh.
//
// On the controller: it is the only node with the docker socket, and this
// pipeline and the script it runs come from main.
// =============================================================================
pipeline {
    agent { label 'built-in' }

    options {
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 30, unit: 'MINUTES')
    }

    stages {
        stage('Collect') {
            steps {
                sh 'bash infrastructure/ci/registry-gc.sh'
            }
        }
    }
}
