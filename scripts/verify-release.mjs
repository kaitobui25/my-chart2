import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

const issues = [];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  issues.push('package.json version must be a valid release version');
}
if (pkg.repository?.url !== 'git+https://github.com/pviet85/lamlong-charts.git') {
  issues.push('package repository must match the trusted-publisher repository');
}

const licenseMarkers = {
  MIT: /^MIT License\s*$/m,
  'Apache-2.0': /^\s*Apache License\s*$[\s\S]*Version 2\.0/m,
};
const documentationMarkers = {
  MIT: /project is licensed under MIT/i,
  'Apache-2.0': /project is licensed under the Apache License 2\.0/i,
};
const marker = licenseMarkers[pkg.license];
if (!marker) {
  issues.push(`release check does not recognize SPDX license ${pkg.license}`);
} else if (!marker.test(license)) {
  issues.push(`LICENSE content does not match package.json license ${pkg.license}`);
}
const documentationMarker = documentationMarkers[pkg.license];
if (!documentationMarker?.test(readme)) {
  issues.push(`README license statement does not match package.json license ${pkg.license}`);
}
if (readme.includes('has not been published to the npm registry yet')) {
  issues.push('remove the pre-release npm status warning from README before publishing');
}

const tag = process.env.GITHUB_REF_NAME;
if (tag) {
  if (tag !== `v${pkg.version}`) {
    issues.push('release tag must match package.json version');
  }
}

if (issues.length > 0) {
  console.error(issues.map((issue) => `- ${issue}`).join('\n'));
  process.exit(1);
}

console.log(`Release metadata verified for ${pkg.name}@${pkg.version}`);
