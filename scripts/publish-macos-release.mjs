import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

// Extend the existing 0.1.0 release. Package bytes, source archive and tag remain immutable;
// only the three aggregate metadata documents may be refreshed after both native jobs pass.
const output = path.resolve(process.argv[2] ?? 'dist/macos-release');
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG;
const sourceCommit = process.env.SOURCE_SHA;
assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
assert.equal(tag, 'v0.1.0');
assert.equal(sourceCommit, '384e61221e441bc6543f6eb44a192b2db672a205');
const gh = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(path.join(output, name));
const json = name => JSON.parse(read(name).toString('utf8'));
const write = (name, value) => writeFileSync(path.join(output, name), value);
const writeJSON = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
let ref = JSON.parse(gh(['api', `repos/${repository}/git/ref/tags/${tag}`])).object;
for (let depth = 0; ref.type === 'tag' && depth < 10; depth++) ref = JSON.parse(gh(['api', `repos/${repository}/git/tags/${ref.sha}`])).object;
assert.equal(ref.type, 'commit');
assert.equal(ref.sha, sourceCommit, 'Refusing to publish against a moved tag');
const release = JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'assets,body,isDraft']));
assert.equal(release.isDraft, false, 'Expected the already published Windows release');
const oldDirectory = path.join(output, 'previous-release');
mkdirSync(oldDirectory, {recursive: true});
const download = (name, directory) => gh(['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', directory]);
const oldAssets = new Map(release.assets.map(asset => [asset.name, asset]));
const windowsName = 'io.dbx.doudizhu-0.1.0-windows-x64.dbxp';
const immutableOriginals = [windowsName, windowsName.replace(/\.dbxp$/, '.artifact.json'), 'dbx-doudizhu-plugin-0.1.0-source.zip', 'dbx-doudizhu-plugin-0.1.0-source.zip.sha256'];
for (const name of [...immutableOriginals, 'release-candidates.json', 'release-notes.md', 'SHA256SUMS.txt']) {
  assert.ok(oldAssets.has(name), `Missing original release asset: ${name}`);
  download(name, oldDirectory);
  const bytes = readFileSync(path.join(oldDirectory, name));
  assert.equal(bytes.length, oldAssets.get(name).size);
  assert.equal(`sha256:${hash(bytes)}`, oldAssets.get(name).digest, `Published digest mismatch: ${name}`);
  if (immutableOriginals.includes(name)) write(name, bytes);
}
assert.equal(hash(read(windowsName)), '325b7c86ce93a7c053732b8956361e9bc3a9c9906c81b8b029daa7343462988c');
assert.equal(hash(read('dbx-doudizhu-plugin-0.1.0-source.zip')), '920859be83776f110136109cae1ecdb35ec4a53cf9d45ce46e7e6f203d70e7f0');
const candidates = JSON.parse(readFileSync(path.join(oldDirectory, 'release-candidates.json'), 'utf8'));
assert.equal(candidates.plugin.id, 'io.dbx.doudizhu');
assert.equal(candidates.plugin.version, '0.1.0');
const windows = candidates.artifacts.find(artifact => artifact.target === 'windows-x64');
assert.equal(windows.sha256, hash(read(windowsName)));
assert.equal(windows.size, read(windowsName).length);
const targets = ['darwin-arm64', 'darwin-x64'];
const provenance = targets.map(target => json(`build-provenance-${target}.json`));
const allNames = [...immutableOriginals];
const macArtifacts = provenance.map((build, index) => {
  const target = targets[index];
  assert.equal(build.target, target);
  assert.equal(build.sourceCommit, sourceCommit);
  assert.equal(build.buildToolingCommit, process.env.GITHUB_SHA);
  assert.equal(build.repository, repository);
  assert.equal(build.tag, tag);
  assert.equal(build.workflowRun, `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  assert.equal(build.packageVerification.status, 'passed');
  assert.equal(build.packageVerification.target, target);
  assert.equal(build.packageVerification.packagedBinaryThreeProcessIntegration, true);
  assert.equal(build.integration.results.length, 11);
  assert.equal(build.nativeWebKit.status, 'passed');
  const name = `io.dbx.doudizhu-0.1.0-${target}.dbxp`;
  assert.equal(build.filename, name);
  const bytes = read(name);
  const metadataName = name.replace(/\.dbxp$/, '.artifact.json');
  const metadata = json(metadataName);
  assert.equal(metadata.target, target);
  assert.equal(metadata.url, name);
  assert.equal(metadata.sha256, hash(bytes));
  assert.equal(metadata.size, bytes.length);
  assert.ok(!Object.hasOwn(metadata, 'signingKeyId'));
  assert.equal(build.sha256, metadata.sha256);
  assert.equal(build.size, metadata.size);
  allNames.push(name, metadataName, `build-provenance-${target}.json`);
  return {target, url: `https://github.com/${repository}/releases/download/${tag}/${name}`, sha256: metadata.sha256, size: metadata.size};
});
// Identical frontend/media across all platforms prevents a same-version protocol/UI mismatch.
execFileSync('python3', [path.join(import.meta.dirname, 'verify-platform-content.py'), ...[windowsName, ...provenance.map(build => build.filename)].map(name => path.join(output, name))], {stdio: 'inherit'});
candidates.artifacts = [windows, ...macArtifacts];
writeJSON('release-candidates.json', candidates);
const notes = release.body.replace('适用 Windows x64、DBX >=0.6.44。', '适用 Windows x64，以及 macOS 15.4+ 的 Apple Silicon（darwin-arm64）和 Intel（darwin-x64）电脑；需要 DBX >=0.6.44。');
const marker = '\n## macOS 发行补充\n';
const cleanNotes = notes.includes(marker) ? notes.slice(0, notes.indexOf(marker)) : notes;
write('release-notes.md', cleanNotes.trimEnd() + '\n' + marker + '\n' +
  `三个平台使用同一份原始 v0.1.0 应用源码（${sourceCommit}），LAN 协议 2 一致。原 Windows 安装包、源码包和版本 tag 均保持不变。\n\n` +
  `Mac 两种架构分别通过原生 CI：前端 15 项测试、Go race/vet、包内三个独立进程连续三局（每架构 11 项检查），并用系统 WebKit 实际解码内置音乐与语音。构建与验证记录：${provenance[0].workflowRun}；具体环境见 build-provenance-darwin-*.json。\n\n` +
  '内置 OGG 音乐和语音依赖 macOS 15.4+ 的系统 WebKit 支持，因此本版 Mac 支持范围为 macOS 15.4 及以上。首次联机若出现本地网络或防火墙授权，请允许 DBX 使用实际连接的局域网。\n\n' +
  'CI 不等同于 Mac 桌面 DBX 的完整界面验收或 Windows/Mac 三台实体电脑的局域网验收；上述两项尚未完成。安装包仍为未签名的商店审核候选。\n');
allNames.push('release-candidates.json', 'release-notes.md');
write('SHA256SUMS.txt', allNames.sort().map(name => `${hash(read(name))}  ${name}`).join('\n') + '\n');
allNames.push('SHA256SUMS.txt');
const mutable = new Set(['release-candidates.json', 'release-notes.md', 'SHA256SUMS.txt']);
// Complete all checks before writing to the published release. Never clobber a package.
for (const name of allNames) {
  if (oldAssets.has(name) && !mutable.has(name)) {
    assert.equal(oldAssets.get(name).digest, `sha256:${hash(read(name))}`, `Refusing to replace immutable asset ${name}`);
  }
}
writeJSON('release-assets.json', {repository, tag, sourceCommit, assets: allNames.map(name => ({name, sha256: hash(read(name)), size: read(name).length}))});
for (const name of allNames) {
  if (!oldAssets.has(name)) gh(['release', 'upload', tag, path.join(output, name), '--repo', repository]);
}
// Aggregate metadata is intentionally refreshed for the user's same-version multi-platform release.
for (const name of mutable) gh(['release', 'upload', tag, path.join(output, name), '--repo', repository, '--clobber']);
gh(['release', 'edit', tag, '--repo', repository, '--notes-file', path.join(output, 'release-notes.md')]);
const finalRelease = JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'assets']));
for (const name of allNames) {
  const asset = finalRelease.assets.find(item => item.name === name);
  assert.ok(asset, `Missing published asset ${name}`);
  assert.equal(asset.size, read(name).length);
  assert.equal(asset.digest, `sha256:${hash(read(name))}`);
}
console.log(`Published and verified ${allNames.length} assets for ${repository}@${tag}; Windows bytes and source tag unchanged.`);
