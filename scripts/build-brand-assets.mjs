/**
 * 品牌图标生成：从一张源图（极简日出信封徽标）裁掉透明留白，输出网页用得到的所有尺寸。
 *
 * 用法：
 *   npm run brand:assets                     # 以 public/logo.png 为源，重新生成派生尺寸
 *   npm run brand:assets -- <source.png>     # 用新源图重建全部图标
 *
 * 源图（1254×1254，透明底）另存于 Daylight-iOS 仓库，改标识时两边一起换。
 * 生成物：public/logo.png（页面内品牌标记）、favicon.png、apple-touch-icon.png、
 * icon-192.png / icon-512.png（web app manifest；带白底，避免 iOS 把透明填黑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.resolve(process.argv[2] || path.join(root, 'public', 'logo.png'));
const publicDir = path.join(root, 'public');

const ALPHA_FLOOR = 8;

const image = await loadImage(sourcePath);
const natural = createCanvas(image.width, image.height);
const naturalContext = natural.getContext('2d');
naturalContext.drawImage(image, 0, 0);
const { data } = naturalContext.getImageData(0, 0, image.width, image.height);

let minX = image.width;
let minY = image.height;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < image.height; y += 1) {
  for (let x = 0; x < image.width; x += 1) {
    if (data[((y * image.width) + x) * 4 + 3] > ALPHA_FLOOR) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error(`源图没有可见像素：${sourcePath}`);

// 裁成正方形，保证缩放后徽标不变形。
const width = maxX - minX + 1;
const height = maxY - minY + 1;
const side = Math.max(width, height);
const centerX = (minX + maxX) / 2;
const centerY = (minY + maxY) / 2;
const crop = {
  x: Math.max(0, Math.min(image.width - side, centerX - (side / 2))),
  y: Math.max(0, Math.min(image.height - side, centerY - (side / 2))),
  side: Math.min(side, image.width, image.height),
};
console.log(`源图 ${path.relative(root, sourcePath)} ${image.width}×${image.height} → 可见区域 ${width}×${height}，裁切 ${crop.side}×${crop.side}`);

function render(size, { background = null, padding = 0.06 } = {}) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
  }
  const inner = Math.round(size * (1 - (padding * 2)));
  const offset = Math.round((size - inner) / 2);
  context.drawImage(image, crop.x, crop.y, crop.side, crop.side, offset, offset, inner, inner);
  return canvas.toBuffer('image/png');
}

const targets = [
  { file: 'logo.png', size: 512, padding: 0.04 },
  { file: 'favicon.png', size: 128, padding: 0.03 },
  { file: 'apple-touch-icon.png', size: 180, background: '#ffffff', padding: 0.04 },
  { file: 'icon-192.png', size: 192, background: '#ffffff', padding: 0.04 },
  { file: 'icon-512.png', size: 512, background: '#ffffff', padding: 0.04 },
];

for (const target of targets) {
  const buffer = render(target.size, target);
  fs.writeFileSync(path.join(publicDir, target.file), buffer);
  console.log(`  public/${target.file}  ${target.size}×${target.size}  ${(buffer.length / 1024).toFixed(1)} KB`);
}
