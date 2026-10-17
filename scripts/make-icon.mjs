// 生成桌面端图标母版 src-tauri/icons/source.png，再由 `npx tauri icon` 派生出全套图标。
//
// 品牌标识是透明底 PNG，各边留白不均匀，所以先按 alpha 裁到内容边界，再等比放进
// 圆角方形底里。底色和取景比例要与 iOS 的 AppIcon 保持一致，两端看起来才像同一个 App。
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs/promises';

const SOURCE = 'resources/icon-source.png';
const OUT = 'src-tauri/icons/source.png';
const SIDE = 1024;
const INSET = 20; // 圆角方形四周留白
const RADIUS = 220; // 圆角半径，沿用旧图标的比例
const BACKDROP = '#ffffff'; // 与 iOS AppIcon、启动屏底色一致
const FIT = 0.7; // 标识最长边占圆角方形边长的比例

const img = await loadImage(SOURCE);

// 摊平后逐像素找内容边界；alpha 极低的抗锯齿边缘不算内容。
const flat = createCanvas(img.width, img.height);
const flatCtx = flat.getContext('2d');
flatCtx.drawImage(img, 0, 0);
const { data } = flatCtx.getImageData(0, 0, img.width, img.height);
let minX = img.width;
let minY = img.height;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < img.height; y += 1) {
  for (let x = 0; x < img.width; x += 1) {
    if (data[(y * img.width + x) * 4 + 3] > 8) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error(`${SOURCE} 里没有不透明像素`);
const boxW = maxX - minX + 1;
const boxH = maxY - minY + 1;
const box = SIDE - INSET * 2;
const scale = (box * FIT) / Math.max(boxW, boxH);
const drawW = Math.round(boxW * scale);
const drawH = Math.round(boxH * scale);

const canvas = createCanvas(SIDE, SIDE);
const ctx = canvas.getContext('2d');
ctx.fillStyle = BACKDROP;
ctx.beginPath();
ctx.roundRect(INSET, INSET, box, box, RADIUS);
ctx.fill();
ctx.drawImage(
  img,
  minX, minY, boxW, boxH,
  Math.round((SIDE - drawW) / 2), Math.round((SIDE - drawH) / 2), drawW, drawH,
);

await fs.writeFile(OUT, canvas.toBuffer('image/png'));
console.log(
  `✓ ${OUT}  标识 ${boxW}×${boxH} → ${drawW}×${drawH}`
  + `（最长边占圆角方形 ${Math.round(FIT * 100)}%，底色 ${BACKDROP}）`,
);
