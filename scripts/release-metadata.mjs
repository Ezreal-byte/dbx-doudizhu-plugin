import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const packageJSON = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const repository = process.argv[3] ?? process.env.GITHUB_REPOSITORY;
assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Set GITHUB_REPOSITORY or pass owner/repository as the second argument');
assert.equal(packageJSON.version, manifest.version, 'Package and manifest versions differ');
const tag = `v${manifest.version}`;
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, tag, 'Tag must match the manifest version');
const target = 'windows-x64';
const filename = `${manifest.id}-${manifest.version}-${target}.dbxp`;
const metadataName = filename.replace(/\.dbxp$/, '.artifact.json');
const metadata = JSON.parse(readFileSync(path.join(output, metadataName), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(path.join(output, filename));
assert.equal(metadata.target, target);
assert.equal(metadata.url, filename, 'Packager metadata must reference the exact candidate filename');
assert.equal(metadata.size, bytes.length);
assert.equal(metadata.sha256, sha256(bytes));
assert.ok(!Object.hasOwn(metadata, 'signingKeyId'), 'Review candidates must be unsigned');

const downloadBase = `https://github.com/${repository}/releases/download/${tag}`;
const candidates = {
  plugin: {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    publisher: manifest.publisher,
    version: manifest.version,
    permissions: [...(manifest.permissions ?? [])].sort(),
  },
  artifacts: [{target, url: `${downloadBase}/${filename}`, sha256: metadata.sha256, size: metadata.size}],
};
writeFileSync(path.join(output, 'release-candidates.json'), `${JSON.stringify(candidates, null, 2)}\n`);

const sourceName = `dbx-doudizhu-plugin-${manifest.version}-source.zip`;
const sourceHashName = `${sourceName}.sha256`;
const sourceBytes = readFileSync(path.join(output, sourceName));
assert.equal(readFileSync(path.join(output, sourceHashName), 'utf8').trim(), `${sha256(sourceBytes)}  ${sourceName}`);

const notes = `# 田园斗地主 ${manifest.version}\n\n` +
  '本地局域网联机斗地主小游戏，仅供同一局域网内三名玩家休闲对局。支持公开房、密码房、房间搜索、五名动态角色、离线语音和倒茶送花互动。\n\n' +
  '不提供互联网匹配、云端账号或在线运营服务，不含充值、支付、提现、兑换、交易或博彩功能。欢乐豆仅是房间内的免费对局计分，不具备货币价值。游戏素材与语音随包提供，运行对局不依赖互联网；玩家之间通过局域网通信。\n\n' +
  `适用 Windows x64、DBX ${manifest.engines.dbx}。三名玩家请使用相同公开版本（LAN 协议 2）。\n\n` +
  '本 Release 提供未签名的 DBX Store 审核候选包。普通用户请等待商店审核与签名后安装；开发者可通过 DBX 的开发包安装入口验证。\n\n' +
  '附安装包、完整源码、候选元数据和 SHA-256 校验清单。CI 已运行前端测试、Go race/vet，以及解包后的三独立进程连续对局验证。三台物理电脑的现场验证不包含在 CI 中。\n';
writeFileSync(path.join(output, 'release-notes.md'), notes);

const names = [filename, metadataName, 'release-candidates.json', sourceName, sourceHashName, 'release-notes.md'].sort();
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
