import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(process.argv[2] ?? '.');
const readJSON = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const run = (bin, args) => execFileSync(bin, args, {cwd: root, encoding: 'utf8'}).trim();
const manifest = readJSON('manifest.json');
const target = process.env.DBX_PLUGIN_TARGET;
assert.ok(['darwin-arm64', 'darwin-x64'].includes(target));
assert.equal(process.platform, 'darwin');
assert.equal(target, `darwin-${process.arch}`);
const sourceCommit = run('git', ['rev-parse', 'HEAD']);
assert.equal(sourceCommit, process.env.SOURCE_SHA);
assert.equal(process.env.RELEASE_TAG, `v${manifest.version}`);
const filename = `${manifest.id}-${manifest.version}-${target}.dbxp`;
const bytes = readFileSync(path.join(root, 'dist', filename));
const hash = createHash('sha256').update(bytes).digest('hex');
const metadata = readJSON(`dist/${filename.replace(/\.dbxp$/, '.artifact.json')}`);
assert.equal(metadata.target, target);
assert.equal(metadata.sha256, hash);
assert.equal(metadata.size, bytes.length);
assert.ok(!metadata.signingKeyId);
const packageVerification = readJSON('test-results/package-verification.json');
const integration = readJSON('test-results/stdio-integration.json');
const webkit = readJSON('test-results/macos-webkit.json');
assert.equal(packageVerification.status, 'passed');
assert.equal(packageVerification.sha256, hash);
assert.equal(packageVerification.packagedBinaryThreeProcessIntegration, true);
assert.equal(integration.results.length, 11);
assert.equal(webkit.status, 'passed');
const provenance = {
  repository: process.env.GITHUB_REPOSITORY,
  tag: process.env.RELEASE_TAG, sourceCommit,
  buildToolingCommit: process.env.GITHUB_SHA,
  workflowRun: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  target, filename, sha256: hash, size: bytes.length,
  os: {platform: process.platform, arch: process.arch, release: os.release(), version: run('sw_vers', ['-productVersion'])},
  toolchain: {go: run('go', ['version']), node: process.version, dbxCLI: readJSON('node_modules/@dbx-app/plugin-cli/package.json').version},
  packageVerification, integration, nativeWebKit: webkit,
  limitations: 'CI uses three native processes on one Mac. Physical multi-computer LAN discovery and the macOS DBX desktop UI were not verified by this run.',
};
writeFileSync(path.join(root, 'dist', `build-provenance-${target}.json`), JSON.stringify(provenance, null, 2) + '\n');
console.log(`Verified ${target} from ${sourceCommit}: ${hash}`);
