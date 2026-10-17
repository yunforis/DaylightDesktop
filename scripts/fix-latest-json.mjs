#!/usr/bin/env node
/**
 * 把 latest.json 里指向 GitHub 资产 API 的地址改写成公开下载地址。
 *
 * 为什么必须改：`tauri-action` 生成 latest.json 时，每个平台的 url 都写成
 *   https://api.github.com/repos/<owner>/<repo>/releases/assets/<资产 id>
 * 这是**带鉴权语义的 API 地址**。实测（`GET` 一个公开仓库的资产 API 地址，不带任何凭据）：
 *   - 请求头 `Accept: application/octet-stream` → 302 跳转到真正的二进制；
 *   - 其它请求头（客户端更新器发的就是普通通配的 Accept 头）→ **200 + application/json**，
 *     返回的是资产元数据 JSON，不是安装包。
 * 也就是说客户端会「下载」到一个 JSON、签名校验必定失败，自动更新整条链路走不通。
 * 改成 `https://github.com/<owner>/<repo>/releases/download/<tag>/<文件名>` 之后，任何请求头
 * 都会跳到真正的二进制，且不需要凭据（草稿发布后这些地址才生效，而 latest.json 本身也只有
 * 发布后才对外可达）。
 *
 * 这个文件同时导出一个纯函数 `rewriteLatestJson`，`desktop-tests` 直接拿它做断言——不联网
 * 也能验证「API 地址 → 公开地址」的映射，以及「产物缺失时必须报错」这两件事。
 *
 * 用法（在工作流里由 finalize 作业调用）：
 *   GITHUB_TOKEN=... node scripts/fix-latest-json.mjs \
 *     --repo owner/repo --tag v0.1.0 --release-id 123 [--expect darwin-x86_64,...]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 六个平台在 latest.json 里的核心键名，缺任何一个都说明这次发布不完整。 */
export const REQUIRED_PLATFORMS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-aarch64',
  'linux-x86_64',
  'windows-aarch64',
  'windows-x86_64',
];

/**
 * 纯函数：把 latest.json 的 platforms[*].url 统一成公开下载地址。
 *
 * @param {{platforms?: Record<string, {url?: string, signature?: string}>}} json latest.json 内容
 * @param {Array<{id: number, name: string}>} assets 该 Release 里的资产列表
 * @param {{repo: string, tag: string}} options
 * @returns {{json: object, changes: string[]}} 改写后的内容与变更说明（changes 为空表示无需改动）
 */
export function rewriteLatestJson(json, assets, { repo, tag }) {
  const prefix = `https://github.com/${repo}/releases/download/${tag}/`;
  const nameById = new Map(assets.map(asset => [String(asset.id), asset.name]));
  const changes = [];
  const platforms = {};

  for (const [key, entry] of Object.entries(json.platforms ?? {})) {
    const url = entry?.url ?? '';
    let next = url;
    if (!url.startsWith(prefix)) {
      // 只认 tauri-action 实际产出的那种形式，其它形态一律报错而不是猜。
      const matched = /\/releases\/assets\/(\d+)$/.exec(url);
      if (!matched) throw new Error(`平台 ${key} 的 url 既不是公开下载地址，也不是资产 API 地址：${url}`);
      const name = nameById.get(matched[1]);
      if (!name) throw new Error(`平台 ${key} 指向资产 ${matched[1]}，但该 Release 里没有这个资产（产物没上传成功？）`);
      next = `${prefix}${name}`;
      changes.push(`${key}：${url} → ${next}`);
    }
    platforms[key] = { ...entry, url: next };
  }

  return { json: { ...json, platforms }, changes };
}

/** 找出缺失的必要平台键，返回缺失列表（空数组表示完整）。 */
export function missingPlatforms(json, required = REQUIRED_PLATFORMS) {
  const present = new Set(Object.keys(json.platforms ?? {}));
  return required.filter(name => !present.has(name));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = value;
  }
  return args;
}

async function api(path, { token, method = 'GET', accept = 'application/vnd.github+json', body, raw = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'User-Agent': 'daylight-release',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
  }
  return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  const tag = args.tag;
  const releaseId = args['release-id'];
  if (!token || !repo || !tag || !releaseId) {
    throw new Error('需要 GITHUB_TOKEN 与 --repo/--tag/--release-id');
  }

  const assets = await api(`/repos/${repo}/releases/${releaseId}/assets?per_page=100`, { token });
  const latest = assets.find(asset => asset.name === 'latest.json');
  if (!latest) throw new Error(`Release ${releaseId} 里没有 latest.json——自动更新元数据没生成，不能当作发布成功。`);

  const json = JSON.parse((await api(`/repos/${repo}/releases/assets/${latest.id}`, { token, accept: 'application/octet-stream', raw: true })).toString());
  const { json: fixed, changes } = rewriteLatestJson(json, assets, { repo, tag });

  const missing = missingPlatforms(fixed);
  if (missing.length) {
    throw new Error(`latest.json 里缺少这些平台：${missing.join('、')}。这次发布不完整，先别对外发布。`);
  }

  console.log(`latest.json：版本 ${fixed.version}，平台 ${Object.keys(fixed.platforms).length} 个`);
  for (const [key, entry] of Object.entries(fixed.platforms)) {
    console.log(`  ${key.padEnd(26)} ${entry.url}  签名 ${(entry.signature ?? '').slice(0, 20)}…`);
  }

  if (!changes.length) {
    console.log('\n地址本来就是公开下载地址，无需改动。');
    return;
  }
  console.log(`\n需要改写 ${changes.length} 处地址：`);
  for (const line of changes) console.log(`  ${line}`);

  await api(`/repos/${repo}/releases/assets/${latest.id}`, { token, method: 'DELETE' });
  await fetch(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=latest.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'daylight-release' },
    body: JSON.stringify(fixed, null, 2),
  }).then(async response => {
    if (!response.ok) throw new Error(`上传 latest.json → HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
  });
  console.log('已重新上传改写后的 latest.json。');
}

// 只有直接运行才联网；被测试 import 时只用到上面那两个纯函数。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
