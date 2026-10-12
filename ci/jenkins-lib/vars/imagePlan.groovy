// The app's build plan: one entry per artifact, each with the stage name, the
// compose env var and the content-addressed ref. Pure git — it never touches
// the registry, so it is safe before anything is built.
def call(Map app) {
    return platformScript('resolve-images.sh', "${app.name} ${app.path} --plan", true)
        .trim()
        .split('\n')
        .collect { line ->
            def fields = line.split('\t')
            [name: fields[0], var: fields[1], ref: fields[2]]
        }
}
