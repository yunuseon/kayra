# Security

kayra runs untrusted app code next to a platform with real secrets, so
isolation problems matter — a way for an app or its build to reach the host,
the Docker socket, the platform's network or another app's secrets.

**Report vulnerabilities privately**, through GitHub's
[security advisories](https://github.com/yunuseon/kayra/security/advisories/new),
not in a public issue.

Known, accepted gaps are listed in [CI isolation](https://yunuseon.github.io/kayra/concepts/ci-isolation/);
no need to report those.

Only the latest release gets fixes.
