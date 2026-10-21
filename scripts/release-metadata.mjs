import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const packageJSON = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const listing = JSON.parse(readFileSync(path.join(root, '.dbx-store.json'), 'utf8'));
const repository = process.argv[3] ?? process.env.GITHUB_REPOSITORY;
assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Set GITHUB_REPOSITORY or pass owner/repository as the second argument');
assert.equal(packageJSON.version, manifest.version, 'Package and manifest versions differ');
const tag = `v${manifest.version}`;
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, tag, 'Tag must match the manifest version');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const downloadBase = `https://github.com/${repository}/releases/download/${tag}`;
const names = [];
const artifacts = ['windows-x64', 'darwin-arm64', 'darwin-x64'].map(target => {
  const filename = `${manifest.id}-${manifest.version}-${target}.dbxp`;
  const metadataName = filename.replace(/\.dbxp$/, '.artifact.json');
  const metadata = JSON.parse(readFileSync(path.join(output, metadataName), 'utf8'));
  const bytes = readFileSync(path.join(output, filename));
  assert.equal(metadata.target, target);
  assert.equal(metadata.url, filename, 'Packager metadata must reference the exact candidate filename');
  assert.equal(metadata.size, bytes.length);
  assert.equal(metadata.sha256, sha256(bytes));
  assert.ok(!Object.hasOwn(metadata, 'signingKeyId'), 'Review candidates must be unsigned');

  const validation = path.join(output, 'validation', target);
  const checked = JSON.parse(readFileSync(path.join(validation, 'package-verification.json'), 'utf8'));
  const integration = JSON.parse(readFileSync(path.join(validation, 'stdio-integration.json'), 'utf8'));
  assert.equal(checked.status, 'passed', `${target}: package verification did not pass`);
  assert.equal(checked.target, target);
  assert.equal(checked.sha256, metadata.sha256);
  assert.equal(checked.size, bytes.length);
  assert.equal(checked.packagedBinaryThreeProcessIntegration, true);
  assert.equal(integration.results.length, 11, `${target}: incomplete three-process integration`);

  names.push(filename, metadataName);
  if (target.startsWith('darwin-')) {
    const provenanceName = `build-provenance-${target}.json`;
    const provenance = JSON.parse(readFileSync(path.join(output, provenanceName), 'utf8'));
    assert.equal(provenance.repository, repository);
    assert.equal(provenance.tag, tag);
    assert.equal(provenance.target, target);
    assert.equal(provenance.filename, filename);
    assert.equal(provenance.sha256, metadata.sha256);
    assert.equal(provenance.size, bytes.length);
    assert.equal(provenance.os.platform, 'darwin');
    assert.equal(provenance.os.arch, target.slice('darwin-'.length));
    assert.equal(provenance.nativeWebKit.status, 'passed');
    if (process.env.GITHUB_SHA) {
      assert.equal(provenance.sourceCommit, process.env.GITHUB_SHA, 'Mac application source differs from release source');
      assert.equal(provenance.buildToolingCommit, process.env.GITHUB_SHA, 'Mac build tooling differs from release source');
    }
    if (process.env.GITHUB_RUN_ID) {
      assert.equal(provenance.workflowRun, `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
    }
    names.push(provenanceName);
  }
  return {target, url: `${downloadBase}/${filename}`, sha256: metadata.sha256, size: metadata.size};
});
const candidates = {
  plugin: {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    publisher: manifest.publisher,
    version: manifest.version,
    permissions: [...(manifest.permissions ?? [])].sort(),
  },
  artifacts,
};
writeFileSync(path.join(output, 'release-candidates.json'), `${JSON.stringify(candidates, null, 2)}\n`);

const sourceName = `dbx-doudizhu-plugin-${manifest.version}-source.zip`;
const sourceHashName = `${sourceName}.sha256`;
const sourceBytes = readFileSync(path.join(output, sourceName));
assert.equal(readFileSync(path.join(output, sourceHashName), 'utf8').trim(), `${sha256(sourceBytes)}  ${sourceName}`);

const notes = `# 田园斗地主 ${manifest.version}\n\n` +
  `${manifest.description}\n\n${listing.releaseNotes}\n\n` +
  `适用 Windows x64、macOS 15.4+（Apple Silicon / Intel），DBX ${manifest.engines.dbx}。三名玩家请使用相同公开版本（LAN 协议 2）。\n\n` +
  '本 Release 提供未签名的 DBX Store 审核候选包。普通用户请等待商店审核与签名后安装；开发者可通过 DBX 的开发包安装入口验证。\n\n' +
  '附三个平台安装包、完整源码、候选元数据、Mac 原生构建记录和 SHA-256 校验清单。各平台 CI 已运行前端测试、Go race/vet，以及解包后的三独立进程连续对局验证；Mac 另验证了系统 WebKit 解码随包音频。三台物理电脑的现场验证及 Mac DBX 桌面界面验证不包含在 CI 中。\n';
writeFileSync(path.join(output, 'release-notes.md'), notes);

names.push('release-candidates.json', sourceName, sourceHashName, 'release-notes.md');
names.sort();
const checksums = names.map(name => `${sha256(readFileSync(path.join(output, name)))}  ${name}`).join('\n');
writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${checksums}\n`);
names.push('SHA256SUMS.txt');
const assets = names.sort().map(name => {
  const data = readFileSync(path.join(output, name));
  return {name, sha256: sha256(data), size: data.length};
});
// CI consumes this inventory to publish only these verified files, never stale dist output.
writeFileSync(path.join(output, 'release-assets.json'), `${JSON.stringify({repository, tag, version: manifest.version, assets}, null, 2)}\n`);
console.log(`Verified ${assets.length} release assets for ${repository}@${tag}`);
