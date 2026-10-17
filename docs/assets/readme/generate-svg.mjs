#!/usr/bin/env node
/**
 * 生成 README 说明图（SVG）。
 *
 *   node docs/assets/readme/generate-svg.mjs
 *
 * 这些图是**手绘 SVG**（不是截图，也不是 AI 生成位图）：矢量、体积小、可离线渲染、
 * 不受 GitHub 深色模式影响，文本可直接搜索与复制。`docs/` 不在 desktop-sync 的
 * 复制清单里，因此本文件与产出的 SVG 都是桌面端自有资产，同步真源不会覆盖。
 *
 * 设计语言与 Web 版说明图一致：暖白底 + 深蓝 + 琥珀色点缀 + 圆角卡片。
 * 图内文字统一用英文，让 README.md 与 README_EN.md 共用同一份资产
 * （Web 版也是这么做的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.dirname(fileURLToPath(import.meta.url));

const BG = '#FAF7F2';
const INK = '#1B3A5C';
const INK2 = '#2C4A6B';
const SLATE = '#64748B';
const LINE = '#D9E2EC';
const CARD = '#FFFFFF';
const SOFT = '#EDF2F7';
const AMBER = '#F5B84A';
const AMBER_D = '#D89A22';
const RED = '#D9534F';
const GREEN = '#3FA46A';
const BLUE = '#3E7CB1';

const FONT =
  "PingFang SC,Hiragino Sans GB,Microsoft YaHei,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 粗略估算文本宽度：CJK 按 1em，拉丁按 0.55em。 */
function textW(str, fs) {
  let w = 0;
  for (const ch of String(str)) w += (ch.codePointAt(0) > 0x2e80 ? 1 : 0.55) * fs;
  return Math.round(w);
}

function t(x, y, str, { fs = 24, fill = INK, weight = 400, anchor = 'start', ls = 0, opacity = 1 } = {}) {
  const extra = [];
  if (anchor !== 'start') extra.push(`text-anchor="${anchor}"`);
  if (ls) extra.push(`letter-spacing="${ls}"`);
  if (opacity !== 1) extra.push(`opacity="${opacity}"`);
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${fs}" font-weight="${weight}" fill="${fill}" ${extra.join(' ')}>${esc(str)}</text>`;
}

function r(x, y, w, h, { rx = 16, fill = CARD, stroke = null, sw = 2, dash = null, opacity = 1 } = {}) {
  const extra = [];
  if (stroke) extra.push(`stroke="${stroke}" stroke-width="${sw}"`);
  if (dash) extra.push(`stroke-dasharray="${dash}"`);
  if (opacity !== 1) extra.push(`opacity="${opacity}"`);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra.join(' ')}/>`;
}

function line(x1, y1, x2, y2, { color = LINE, w = 3, dash = null, cap = 'round' } = {}) {
  const extra = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" stroke-linecap="${cap}"${extra}/>`;
}

function poly(pts, { color = INK, w = 3, dash = null, marker = 'ink' } = {}) {
  const d = 'M' + pts.map((p) => p.join(' ')).join(' L ');
  const extra = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra} marker-end="url(#mk-${marker})"/>`;
}

/** 水平箭头（同一行内两个卡片之间）。 */
function arrowH(x1, x2, y, { color = SLATE, dash = null, marker = 'slate', w = 3 } = {}) {
  return poly([[x1, y], [x2, y]], { color, w, dash, marker });
}

function chipWidth(label, fs, pad) {
  return textW(label, fs) + pad * 2;
}

function chip(x, y, label, { h = 48, fs = 22, fill = CARD, stroke = LINE, fg = INK2, pad = 22, weight = 500 } = {}) {
  const w = chipWidth(label, fs, pad);
  return {
    w,
    svg: `${r(x, y, w, h, { rx: h / 2, fill, stroke, sw: 1.5 })}${t(x + w / 2, y + h / 2 + fs * 0.36, label, { fs, fill: fg, weight, anchor: 'middle' })}`,
  };
}

/**
 * 步骤卡片：编号独占一行，标题独占一行，说明行在下方。
 * 标题与说明都按卡片宽度取字号，避免长标题（如 "Confirm & install"）顶到边框。
 */
function stepCard(x, y, w, h, { index, title, lines = [], titleFs = 21, lineFs = 17 }) {
  const parts = [r(x, y, w, h, { rx: 18, fill: CARD, stroke: LINE })];
  parts.push(r(x + 22, y + 20, 34, 34, { rx: 10, fill: AMBER }));
  parts.push(t(x + 39, y + 44, String(index), { fs: 19, weight: 700, anchor: 'middle' }));
  parts.push(t(x + 22, y + 94, title, { fs: titleFs, weight: 700 }));
  lines.forEach((ln, i) => parts.push(t(x + 22, y + 126 + i * 28, ln, { fs: lineFs, fill: SLATE })));
  return parts.join('');
}

/** 水平居中的等宽卡片行；返回每张卡片的 x 坐标。 */
function rowX(count, w, gap, W) {
  const total = count * w + (count - 1) * gap;
  const start = Math.round((W - total) / 2);
  return Array.from({ length: count }, (_, i) => start + i * (w + gap));
}

// --- 图标 ---------------------------------------------------------------

function iconWindow(cx, cy, s = 1, color = INK) {
  const w = 54 * s;
  const h = 40 * s;
  return [
    r(cx - w / 2, cy - h / 2, w, h, { rx: 8 * s, fill: CARD, stroke: color, sw: 3 * s }),
    line(cx - w / 2, cy - h / 2 + 13 * s, cx + w / 2, cy - h / 2 + 13 * s, { color, w: 2.5 * s }),
    `<circle cx="${cx - w / 2 + 9 * s}" cy="${cy - h / 2 + 6.5 * s}" r="${2.6 * s}" fill="${color}"/>`,
    `<circle cx="${cx - w / 2 + 18 * s}" cy="${cy - h / 2 + 6.5 * s}" r="${2.6 * s}" fill="${color}"/>`,
  ].join('');
}

function iconEnvelope(cx, cy, s = 1, color = INK2) {
  const w = 40 * s;
  const h = 28 * s;
  return [
    r(cx - w / 2, cy - h / 2, w, h, { rx: 5 * s, fill: 'none', stroke: color, sw: 3 * s }),
    `<path d="M${cx - w / 2 + 1} ${cy - h / 2 + 3} L${cx} ${cy + 3 * s} L${cx + w / 2 - 1} ${cy - h / 2 + 3}" fill="none" stroke="${color}" stroke-width="${3 * s}" stroke-linejoin="round"/>`,
  ].join('');
}

function iconCheck(cx, cy, s = 1, color = GREEN) {
  return `<path d="M${cx - 8 * s} ${cy} l${6 * s} ${7 * s} l${12 * s} ${-15 * s}" fill="none" stroke="${color}" stroke-width="${4 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function iconDb(cx, cy, s = 1, color = INK) {
  const rx = 22 * s;
  return [
    `<ellipse cx="${cx}" cy="${cy - 20 * s}" rx="${rx}" ry="${9 * s}" fill="none" stroke="${color}" stroke-width="${3 * s}"/>`,
    `<path d="M${cx - rx} ${cy - 20 * s} v${40 * s} a${rx} ${9 * s} 0 0 0 ${2 * rx} 0 v${-40 * s}" fill="none" stroke="${color}" stroke-width="${3 * s}"/>`,
    `<path d="M${cx - rx} ${cy - 20 * s} a${rx} ${9 * s} 0 0 0 ${2 * rx} 0" fill="none" stroke="${color}" stroke-width="${3 * s}"/>`,
    `<path d="M${cx - rx} ${cy} a${rx} ${9 * s} 0 0 0 ${2 * rx} 0" fill="none" stroke="${color}" stroke-width="${3 * s}"/>`,
  ].join('');
}

function iconGear(cx, cy, s = 1, color = INK) {
  const r0 = 13 * s;
  const teeth = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI / 4) * i;
    teeth.push(
      line(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r0 * 1.55, cy + Math.sin(a) * r0 * 1.55, {
        color,
        w: 5 * s,
      }),
    );
  }
  return [
    ...teeth,
    `<circle cx="${cx}" cy="${cy}" r="${r0}" fill="none" stroke="${color}" stroke-width="${3.5 * s}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r0 * 0.42}" fill="${color}"/>`,
  ].join('');
}

function iconShield(cx, cy, s = 1, color = INK) {
  return [
    `<path d="M${cx} ${cy - 22 * s} l${18 * s} ${8 * s} v${14 * s} c0 ${14 * s} ${-9 * s} ${20 * s} ${-18 * s} ${24 * s} c${-9 * s} ${-4 * s} ${-18 * s} ${-10 * s} ${-18 * s} ${-24 * s} v${-14 * s} z" fill="none" stroke="${color}" stroke-width="${3 * s}" stroke-linejoin="round"/>`,
    iconCheck(cx, cy + 2 * s, 0.8 * s, color),
  ].join('');
}

function iconCalendar(cx, cy, s = 1, color = INK2) {
  const w = 42 * s;
  const h = 38 * s;
  return [
    r(cx - w / 2, cy - h / 2, w, h, { rx: 6 * s, fill: 'none', stroke: color, sw: 3 * s }),
    line(cx - w / 2, cy - h / 2 + 12 * s, cx + w / 2, cy - h / 2 + 12 * s, { color, w: 3 * s }),
    line(cx - w / 2 + 12 * s, cy - h / 2 - 5 * s, cx - w / 2 + 12 * s, cy - h / 2 + 3 * s, { color, w: 3 * s }),
    line(cx + w / 2 - 12 * s, cy - h / 2 - 5 * s, cx + w / 2 - 12 * s, cy - h / 2 + 3 * s, { color, w: 3 * s }),
    r(cx + 3 * s, cy + 2 * s, 11 * s, 9 * s, { rx: 2 * s, fill: AMBER }),
  ].join('');
}

function iconCloud(cx, cy, s = 1, color = BLUE) {
  return `<path d="M${cx - 20 * s} ${cy + 10 * s} h${36 * s} a${11 * s} ${11 * s} 0 0 0 ${2 * s} ${-21 * s} a${15 * s} ${15 * s} 0 0 0 ${-28 * s} ${-6 * s} a${11 * s} ${11 * s} 0 0 0 ${-10 * s} ${27 * s} z" fill="none" stroke="${color}" stroke-width="${3 * s}" stroke-linejoin="round"/>`;
}

function iconTray(cx, cy, s = 1, color = INK) {
  return [
    `<path d="M${cx - 22 * s} ${cy} v${14 * s} a${4 * s} ${4 * s} 0 0 0 ${4 * s} ${4 * s} h${36 * s} a${4 * s} ${4 * s} 0 0 0 ${4 * s} ${-4 * s} v${-14 * s}" fill="none" stroke="${color}" stroke-width="${3 * s}"/>`,
    `<path d="M${cx - 12 * s} ${cy - 4 * s} L${cx} ${cy + 8 * s} L${cx + 12 * s} ${cy - 4 * s}" fill="none" stroke="${color}" stroke-width="${3 * s}" stroke-linecap="round" stroke-linejoin="round"/>`,
    line(cx, cy - 20 * s, cx, cy + 6 * s, { color, w: 3 * s }),
  ].join('');
}

// --- 文件包装 ------------------------------------------------------------

function wrap(name, w, h, title, body) {
  const markers = [
    ['ink', INK],
    ['slate', SLATE],
    ['amber', AMBER_D],
    ['red', RED],
    ['green', GREEN],
    ['blue', BLUE],
  ]
    .map(
      ([id, color]) =>
        `<marker id="mk-${id}" viewBox="0 0 10 8" refX="9.5" refY="4" markerWidth="8" markerHeight="6.4" orient="auto"><path d="M0 0 L10 4 L0 8 z" fill="${color}"/></marker>`,
    )
    .join('\n    ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <defs>
    ${markers}
  </defs>
  ${body}
</svg>
`;
  fs.writeFileSync(path.join(OUT, name), svg, 'utf8');
  console.log(`  写出 ${name}  ${w}×${h}  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KiB`);
}

// --- banner.svg ---------------------------------------------------------

function banner() {
  const W = 1800;
  const H = 600;
  const p = [
    r(0, 0, W, H, { rx: 0, fill: BG }),
    `<circle cx="1655" cy="70" r="230" fill="#F2E3C6" opacity="0.5"/>`,
    `<circle cx="90" cy="560" r="200" fill="#E4EBF3" opacity="0.55"/>`,

    // logo：太阳 + 两片叶子
    `<circle cx="196" cy="188" r="50" fill="${AMBER}"/>`,
    `<path d="M138 206 C138 206 176 208 196 262 C168 250 138 240 138 206 Z" fill="${INK}"/>`,
    `<path d="M254 206 C254 206 216 208 196 262 C224 250 254 240 254 206 Z" fill="${INK}"/>`,

    t(300, 232, 'Daylight', { fs: 120, weight: 800, ls: -3 }),
  ];

  // “Desktop” 药丸
  const wordEnd = 300 + textW('Daylight', 120) - 14;
  p.push(r(wordEnd + 26, 168, 212, 70, { rx: 35, fill: AMBER }));
  p.push(t(wordEnd + 26 + 106, 216, 'Desktop', { fs: 38, weight: 700, anchor: 'middle' }));

  p.push(t(300, 336, 'Turn messages into next steps.', { fs: 50, weight: 700 }));
  p.push(t(300, 388, 'Install and run it locally · no server, no account.', { fs: 27, fill: '#5A6B80' }));

  let cx = 300;
  for (const label of ['Tauri 2 shell', 'Node 22 bundled', 'Local data']) {
    const c = chip(cx, 444, label, { h: 50, fill: CARD });
    p.push(c.svg);
    cx += c.w + 16;
  }

  // 应用窗口插画
  const wx = 1140;
  const wy = 130;
  const ww = 580;
  const wh = 330;
  p.push(r(wx + 10, wy + 12, ww, wh, { rx: 24, fill: '#E8E2D8', opacity: 0.9 }));
  p.push(r(wx, wy, ww, wh, { rx: 24, fill: CARD, stroke: LINE }));
  p.push(
    `<path d="M${wx} ${wy + 26} a26 26 0 0 1 26 -26 h${ww - 52} a26 26 0 0 1 26 26 v34 h-${ww} z" fill="${SOFT}"/>`,
  );
  for (const [i, c] of ['#E06A5F', '#F0B429', '#4CAF7D'].entries()) {
    p.push(`<circle cx="${wx + 30 + i * 26}" cy="${wy + 30}" r="7" fill="${c}"/>`);
  }

  // 两封邮件卡片
  const mail = (x, y, lines) => [
    r(x, y, 250, 76, { rx: 14, fill: SOFT }),
    iconEnvelope(x + 40, y + 38, 0.85, INK2),
    ...lines.map((w, i) => r(x + 74, y + 22 + i * 20, w, 9, { rx: 4, fill: i === 0 ? '#C7D2DE' : '#DCE3EC' })),
  ];
  p.push(...mail(wx + 30, wy + 84, [168, 118]));
  p.push(...mail(wx + 52, wy + 178, [150, 96]));

  // 箭头
  p.push(poly([[wx + 310, wy + 168], [wx + 342, wy + 168]], { color: SLATE, w: 3.5, marker: 'slate' }));

  // 右侧任务 / 日历卡片
  const tx = wx + 352;
  p.push(r(tx, wy + 60, 200, 118, { rx: 14, fill: CARD, stroke: LINE }));
  const rows = [
    [GREEN, true],
    [AMBER, true],
    [null, false],
  ];
  rows.forEach(([color, done], i) => {
    const y = wy + 78 + i * 32;
    p.push(r(tx + 18, y, 18, 18, { rx: 5, fill: color ?? CARD, stroke: color ? 'none' : LINE, sw: 2 }));
    if (done) p.push(iconCheck(tx + 27, y + 9, 0.62, CARD));
    p.push(r(tx + 46, y + 4, i === 0 ? 132 : 108, 9, { rx: 4, fill: i === 0 ? '#C7D2DE' : '#DCE3EC' }));
  });

  p.push(r(tx, wy + 196, 200, 100, { rx: 14, fill: CARD, stroke: LINE }));
  for (let i = 0; i < 3; i += 1) p.push(line(tx + 16 + i * 60, wy + 212, tx + 16 + i * 60, wy + 282, { color: SOFT, w: 3 }));
  for (let i = 0; i < 3; i += 1) p.push(line(tx + 16, wy + 232 + i * 26, tx + 184, wy + 232 + i * 26, { color: SOFT, w: 3 }));
  p.push(r(tx + 24, wy + 240, 46, 20, { rx: 4, fill: AMBER }));
  p.push(r(tx + 100, wy + 266, 60, 20, { rx: 4, fill: '#C7D2DE' }));
  p.push(r(tx + 40, wy + 214, 50, 16, { rx: 4, fill: '#DCE3EC' }));

  wrap('banner.svg', W, H, 'Daylight Desktop — Turn messages into next steps.', p.join('\n  '));
}

// --- architecture.svg ---------------------------------------------------

function architecture() {
  const W = 1720;
  const H = 1080;
  const p = [
    r(0, 0, W, H, { rx: 0, fill: BG }),
    t(80, 68, 'Desktop architecture', { fs: 36, weight: 700 }),
    t(80, 106, 'One app · loopback only · no database, no Redis, no message queue', { fs: 22, fill: SLATE }),

    r(80, 130, 1560, 600, { rx: 30, fill: '#F4F7FA', stroke: LINE, dash: '11 9' }),
    t(112, 174, 'SINGLE APP BOUNDARY · 127.0.0.1 ONLY', { fs: 19, weight: 700, fill: SLATE, ls: 2 }),
  ];

  // Row 1
  p.push(r(120, 200, 700, 150, { rx: 20 }));
  p.push(iconWindow(172, 252));
  p.push(t(214, 248, 'Rust shell (Tauri 2)', { fs: 27, weight: 700 }));
  p.push(t(214, 284, 'Window · tray · single instance · close-to-tray', { fs: 20, fill: SLATE }));
  p.push(t(214, 314, 'System keyring · native updater · starts the backend', { fs: 20, fill: SLATE }));

  p.push(r(860, 200, 740, 150, { rx: 20 }));
  p.push(iconCalendar(906, 252));
  p.push(t(946, 248, 'WebView · React 19 UI', { fs: 27, weight: 700 }));
  p.push(t(946, 284, 'shadcn/ui + Tailwind · served over loopback HTTP', { fs: 20, fill: SLATE }));
  p.push(t(946, 314, 'Workspaces · mail · calendar · tasks · recruitment · invoices', { fs: 20, fill: SLATE }));

  p.push(poly([[360, 350], [360, 398]], { color: INK, w: 3.5, marker: 'ink' }));
  p.push(t(378, 382, 'one-time token → session cookie', { fs: 19, fill: SLATE }));

  // Row 2
  p.push(r(120, 400, 1480, 145, { rx: 20, fill: CARD, stroke: LINE }));
  p.push(iconGear(172, 452));
  p.push(t(214, 448, 'Bundled Node backend', { fs: 27, weight: 700 }));
  p.push(t(214, 484, 'Express on 127.0.0.1 · Host / Origin / cookie checks (403 / 403 / 401)', { fs: 20, fill: SLATE }));
  p.push(t(214, 514, 'IMAP · SMTP · OpenAI-compatible models · embeddings · OCR · external calendars', { fs: 20, fill: SLATE }));
  let bx = 1010;
  for (const label of ['Node 22 bundled', 'shipped in installer']) {
    const c = chip(bx, 462, label, { h: 42, fs: 19, fill: SOFT, stroke: 'none' });
    p.push(c.svg);
    bx += c.w + 12;
  }

  p.push(poly([[860, 545], [860, 583]], { color: INK, w: 3.5, marker: 'ink' }));
  p.push(t(878, 572, 'atomic write (temp file + rename)', { fs: 19, fill: SLATE }));

  // Row 3
  p.push(r(120, 585, 1480, 110, { rx: 20, fill: CARD, stroke: LINE }));
  p.push(iconDb(172, 640));
  p.push(t(214, 628, 'Local data directory', { fs: 27, weight: 700 }));
  p.push(t(214, 664, 'JSON business store · settings.json & infra.json encrypted with AES-256-GCM · backend.log', { fs: 20, fill: SLATE }));
  const kb = chip(1000, 610, 'no plaintext fallback', { h: 42, fs: 19, fill: SOFT, stroke: 'none', fg: INK2 });
  p.push(kb.svg);

  // 外部服务
  const ext = [
    ['IMAP', 'read mail', iconEnvelope],
    ['SMTP', 'send replies', iconEnvelope],
    ['LLM', 'OpenAI-compatible', iconCloud],
    ['Calendars', 'Google / CalDAV', iconCalendar],
    ['Feishu', 'optional meetings', iconTray],
  ];
  ext.forEach(([name, sub, icon], i) => {
    const x = 80 + i * 312;
    const w = i === 4 ? 300 : 288;
    p.push(r(x, 806, w, 116, { rx: 18 }));
    p.push(icon(x + 46, 864, 0.8, INK2));
    p.push(t(x + 84, 856, name, { fs: 24, weight: 700 }));
    p.push(t(x + 84, 888, sub, { fs: 18, fill: SLATE }));
    p.push(poly([[x + w / 2, 806], [x + w / 2, 736]], { color: SLATE, w: 2.5, dash: '8 7', marker: 'slate' }));
  });

  // 图例
  p.push(r(80, 948, 1180, 116, { rx: 18, fill: SOFT, stroke: 'none' }));
  p.push(line(112, 982, 182, 982, { color: INK, w: 3.5 }));
  p.push(t(196, 990, 'in-process write / loopback HTTP', { fs: 20, fill: INK2 }));
  p.push(line(560, 982, 630, 982, { color: BLUE, w: 2.5, dash: '12 6 3 6' }));
  p.push(t(644, 990, 'anonymous HTTPS (update source)', { fs: 20, fill: INK2 }));
  p.push(line(112, 1016, 182, 1016, { color: SLATE, w: 2.5, dash: '8 7' }));
  p.push(t(196, 1024, 'outbound network call (your credentials)', { fs: 20, fill: INK2 }));
  p.push(t(112, 1054, 'update packages are verified with a public key compiled into the app', { fs: 20, fill: INK2 }));

  // 更新源：沿右侧留白绕行到 Rust 壳层，避免横穿其它卡片
  p.push(r(1300, 948, 340, 116, { rx: 18, fill: CARD, stroke: LINE }));
  p.push(iconShield(1340, 1006, 0.8, INK));
  p.push(t(1372, 986, 'Update source', { fs: 21, weight: 700 }));
  p.push(t(1372, 1014, 'GitHub Releases', { fs: 18, fill: SLATE }));
  p.push(t(1372, 1042, 'latest.json · anonymous', { fs: 18, fill: SLATE }));
  p.push(
    poly(
      [
        [1640, 1006],
        [1692, 1006],
        [1692, 122],
        [470, 122],
        [470, 196],
      ],
      { color: BLUE, w: 2.5, dash: '12 6 3 6', marker: 'blue' },
    ),
  );

  wrap('architecture.svg', W, H, 'Daylight Desktop local architecture', p.join('\n  '));
}

// --- update-flow.svg ----------------------------------------------------

function updateFlow() {
  const W = 1720;
  const H = 640;
  const p = [
    r(0, 0, W, H, { rx: 0, fill: BG }),
    t(80, 68, 'Auto-update trust chain', { fs: 36, weight: 700 }),
    t(80, 106, 'Implemented and verified entirely in the Rust shell · the app page has no channel to it', { fs: 22, fill: SLATE }),
  ];

  const steps = [
    ['Launch + 6 s', ['One silent check', 'Nothing if current']],
    ['GET latest.json', ['Anonymous HTTPS', 'Published releases only']],
    ['Download', ['Installer + .sig', 'Progress in the title bar']],
    ['Verify signature', ['minisign public key', 'Mismatch → refuse']],
    ['Confirm & install', ['User clicks to confirm', 'Replace → restart']],
  ];
  const w = 280;
  const gap = 32;
  const y = 168;
  const h = 180;
  const xs = rowX(steps.length, w, gap, W);
  steps.forEach(([title, lines], i) => {
    p.push(stepCard(xs[i], y, w, h, { index: i + 1, title, lines }));
    if (i < steps.length - 1) p.push(arrowH(xs[i] + w + 6, xs[i + 1] - 6, y + h / 2, { color: INK, marker: 'ink', w: 3.5 }));
  });

  p.push(r(80, 396, 760, 96, { rx: 18, fill: '#FDF2F2', stroke: '#F0C4C2' }));
  p.push(t(112, 436, 'Signature mismatch', { fs: 23, weight: 700, fill: RED }));
  p.push(t(112, 468, 'The update is refused; the running version keeps working.', { fs: 19, fill: INK2 }));

  p.push(r(880, 396, 760, 96, { rx: 18, fill: '#FFF8E8', stroke: '#F0DCB0' }));
  p.push(t(912, 436, 'Never a silent install', { fs: 23, weight: 700, fill: AMBER_D }));
  p.push(t(912, 468, 'Download, replace and restart all require the user to click.', { fs: 19, fill: INK2 }));

  p.push(
    t(80, 556, 'Drafts and pre-releases are never delivered; an unreachable endpoint shows "no update information available yet".', {
      fs: 20,
      fill: SLATE,
    }),
  );
  p.push(t(80, 590, 'Losing the signing key means no further usable updates: clients reject packages signed by a different key.', { fs: 20, fill: SLATE }));

  wrap('update-flow.svg', W, H, 'Daylight Desktop auto-update trust chain', p.join('\n  '));
}

// --- mailbox-scopes.svg -------------------------------------------------

function mailboxScopes() {
  const W = 1720;
  const H = 614;
  const p = [
    r(0, 0, W, H, { rx: 0, fill: BG }),
    t(80, 68, 'Mailbox views and retrieval scope', { fs: 36, weight: 700 }),
    t(80, 106, 'Categorize campus, personal and work inboxes; the selected view scopes search and answers', { fs: 22, fill: SLATE }),
  ];

  const cards = [
    ['Single mailbox', 'Working in one inbox', 'Indexed content from the current mailbox', 1],
    ['Same category', 'Campus or work inboxes together', 'Indexed content from tagged mailboxes', 3],
    ['All mailboxes', 'Finding a notice when its inbox is unclear', 'Indexed content from all local mailboxes', 5],
  ];
  cards.forEach(([title, sub, scope, n], i) => {
    const x = 80 + i * 540;
    const y = 160;
    const w = 480;
    p.push(r(x, y, w, 280, { rx: 22 }));
    const spacing = n > 3 ? 38 : 44;
    const scale = n > 3 ? 0.7 : 0.9;
    const start = x + (n > 3 ? 64 : 74);
    for (let k = 0; k < n; k += 1) p.push(iconEnvelope(start + k * spacing, y + 66, scale, INK2));
    if (n > 1) {
      const pillX = start + (n - 1) * spacing + 20 * scale + 20;
      p.push(r(pillX, y + 50, 74, 32, { rx: 16, fill: AMBER }));
      p.push(t(pillX + 37, y + 72, `×${n}`, { fs: 19, weight: 700, anchor: 'middle' }));
    }
    p.push(t(x + 32, y + 140, title, { fs: 28, weight: 700 }));
    p.push(t(x + 32, y + 176, sub, { fs: 20, fill: SLATE }));
    p.push(r(x + 32, y + 200, w - 64, 56, { rx: 14, fill: SOFT, stroke: 'none' }));
    p.push(t(x + 52, y + 236, scope, { fs: 17, fill: INK2 }));
  });

  p.push(r(80, 458, 1560, 92, { rx: 16, fill: '#FFF8E8', stroke: '#F0DCB0' }));
  p.push(t(108, 496, 'Combined views are a read scope only: events, drafts and sending still use the selected mailbox.', { fs: 20, fill: INK2 }));
  p.push(t(108, 530, 'Retrieval covers indexed content, not necessarily the whole mailbox history.', { fs: 20, fill: INK2 }));

  wrap('mailbox-scopes.svg', W, H, 'Mailbox views and retrieval scope', p.join('\n  '));
}

// --- 业务流程图（招聘 / 发票）--------------------------------------------

function flow(name, title, subtitle, steps, note, noteFill = SOFT, noteStroke = 'none') {
  const W = 1720;
  const noteLines = Array.isArray(note) ? note : [note];
  const BOXY = 344;
  const boxH = 54 + (noteLines.length - 1) * 30;
  const H = BOXY + boxH + 26;
  const p = [
    r(0, 0, W, H, { rx: 0, fill: BG }),
    t(80, 68, title, { fs: 36, weight: 700 }),
    t(80, 106, subtitle, { fs: 22, fill: SLATE }),
  ];

  const w = 250;
  const gap = 32;
  const y = 158;
  const h = 150;
  const xs = rowX(steps.length, w, gap, W);
  steps.forEach(([label, sub], i) => {
    p.push(stepCard(xs[i], y, w, h, { index: i + 1, title: label, lines: [sub], titleFs: 20, lineFs: 16 }));
    if (i < steps.length - 1) p.push(arrowH(xs[i] + w + 5, xs[i + 1] - 5, y + h / 2, { color: SLATE, marker: 'slate' }));
  });

  p.push(r(80, BOXY, 1560, boxH, { rx: 16, fill: noteFill, stroke: noteStroke }));
  noteLines.forEach((ln, i) => p.push(t(108, BOXY + 32 + i * 30, ln, { fs: 20, fill: INK2 })));

  wrap(name, W, H, title, p.join('\n  '));
}

// --- 主流程 --------------------------------------------------------------

console.log('生成 README 说明图 →', OUT);
banner();
architecture();
updateFlow();
mailboxScopes();
flow(
  'recruitment-flow.svg',
  'Recruitment: from resume to interview',
  'Attachments, OCR and retrieval feed a candidate profile; sending always passes a human review',
  [
    ['Application mail', 'detected on sync'],
    ['Save attachment', 'original kept'],
    ['PDF text · OCR', 'scans re-read'],
    ['Candidate profile', 'cited to source'],
    ['Screening', 'natural language'],
    ['Review & send', 'invitation draft'],
  ],
  [
    'Feishu meeting creation is optional and needs its own authorization. Scans, failed OCR and incomplete profiles stay visible for retry.',
    'Existing recruitment records are reused rather than duplicated when a workspace is added.',
  ],
);
flow(
  'invoice-flow.svg',
  'Invoices: from attachment to field checks',
  'Every extracted field keeps a link back to the original attachment',
  [
    ['Invoice attachment', 'found in mail'],
    ['Extract fields', 'number · date · parties'],
    ['Amount & tax', 'items, totals'],
    ['Check original', 'open / download'],
    ['Reimbursement', 'materials ready'],
  ],
  'Extraction does not establish tax authenticity, reimbursement or payment, and it never creates calendar events or tasks on its own.',
  '#FFF8E8',
  '#F0DCB0',
);
console.log('完成。');
