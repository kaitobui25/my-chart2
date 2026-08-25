# Releasing `lamlong-chart`

Releases are published only from a version tag by
`.github/workflows/release.yml`. The workflow verifies the tag against
`package.json`, runs the full test suite and dependency audits, checks the npm
tarball, publishes through npm trusted publishing, and creates generated GitHub
release notes.

## One-time bootstrap for the first npm release

npm requires a package to exist before a trusted publisher can be attached to
it. Because `lamlong-chart` is not published yet, an owner must bootstrap the
first version from a clean checkout using an npm account protected by 2FA:

Before running these commands, resolve any license/metadata mismatch and remove
the temporary "not published" warning from `README.md`. `npm publish` runs
`verify:release` and stops if either condition is still unresolved.

```bash
npm ci
npx playwright install chromium
python3.11 -m pip install aiohttp
npm run verify
npm audit --audit-level=high
python3.11 scripts/audit-provider.py
npm pack --dry-run
npm login
npm publish --access public --provenance=false
npm logout
```

Do not put the bootstrap token in GitHub, `.npmrc`, the repository, or a shell
script. Verify the owner, package name, version, license, repository URL, and
tarball contents immediately before publishing. The first bootstrap is the only
release without provenance because npm cannot attach a trusted publisher until
the package exists; all subsequent releases use OIDC and provenance in CI.

## Configure trusted publishing

After the package exists, open the package settings on npm and add this GitHub
Actions trusted publisher:

- Organization or user: `pviet85`
- Repository: `lamlong-charts`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Create the `npm` GitHub Environment and require a maintainer approval before
deployment. Once one OIDC release succeeds, set npm Publishing access to
**Require two-factor authentication and disallow tokens**, then revoke any old
automation token.

## Publish a release

1. Update `version` in `package.json` and `package-lock.json` together.
2. Run `npm run verify:release`, `npm run verify`,
   `npm audit --audit-level=high`, and
   `python3.11 scripts/audit-provider.py`.
3. Merge the reviewed version commit.
4. Create and push an annotated tag that exactly matches the version:

```bash
git tag -a v0.1.1 -m "lamlong-chart v0.1.1"
git push origin v0.1.1
```

The protected `npm` environment is the approval gate. Do not publish the same
version from a laptop after trusted publishing is enabled.
