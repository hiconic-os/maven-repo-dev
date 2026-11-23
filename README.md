# Maven package repository

This repository hosts GitHub Maven packages. The daily **Maintain artifact index**
workflow retains the five highest integer versions of `meta.artifact-index`.
Only obsolete index snapshots are deleted; application packages are untouched.

The job runs at 03:17 UTC and can also be started manually. Manual runs default
to a dry run; disable **Inspect only** to delete. Retention can be five or three.
The backing repository is checked before any deletion, and an incomplete inventory
or failed delete fails the job. Concurrent new versions remain untouched.

Authentication uses the existing `DEVROCK_PIPELINE_UPLOAD_PASSWORD` secret, or
`ARTIFACT_INDEX_CLEANUP_TOKEN` when supplied. If neither exists, the ephemeral
repository job token is used with package-write permission. A PAT needs package read/delete
scopes and package administration rights. No token is passed in command arguments.

The dependency-free Node.js script is bundled so no other repository, SDK or npm
installation is needed. Its source is `delete-old-versions.js` in
[hiconic-os/com.braintribe.devrock.cicd](https://github.com/hiconic-os/com.braintribe.devrock.cicd).
Keep the bundled copy synchronized when changing retention behavior.

Local dry run:

~~~sh
GITHUB_TOKEN=... node .github/scripts/delete-old-versions.cjs --org=hiconic-os --repo=hiconic-os/maven-repo-dev --keep=5 --dry
~~~
