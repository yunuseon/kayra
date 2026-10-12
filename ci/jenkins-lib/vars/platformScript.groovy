// The platform's scripts (resources/platform/<name>) ship with this library,
// so an app's checkout never needs to contain platform files — which is what
// lets an app live in its own repo.

// Runs <name> with args in the current workspace.
def call(String name, String args, boolean returnStdout = false) {
    return sh(script: "bash ${path(name)} ${args}", returnStdout: returnStdout)
}

// Writes <name> into the workspace and returns its path, for use in a pipe.
def path(String name) {
    writeFile file: ".platform/${name}", text: libraryResource("platform/${name}")
    return ".platform/${name}"
}
