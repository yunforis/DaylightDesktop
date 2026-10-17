import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dockerfile 的 build 阶段只 COPY index.html/vite.config/src/public/shared，没有 server/。
// 前端一旦直接 import server/ 下的文件，`docker compose up --build` 就会在 vite build 阶段失败，
// 而本地 `npm run build` 因为整棵树都在反而看不出问题。这里把边界固定下来。
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test('前端只能复用 shared/ 的代码，不能直接 import server/', () => {
  const offenders = [];
  for (const file of listFiles(path.join(root, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (/(^|\/)server\//.test(specifier)) {
        offenders.push(`${path.relative(root, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Dockerfile 的 build 阶段不含 server/，跨端复用请放到 shared/：\n${offenders.join('\n')}`,
  );
});

test('Dockerfile 的 build 阶段包含前端构建所需目录', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const stage = dockerfile.split(/^FROM /m).find((part) => /^dependencies AS build/.test(part.trim()));
  assert.ok(stage, '找不到 Dockerfile 的 build 阶段');
  for (const dir of ['src', 'shared']) {
    assert.match(stage, new RegExp(`COPY ${dir}(\\s|$)`), `build 阶段必须 COPY ${dir}`);
  }
});
