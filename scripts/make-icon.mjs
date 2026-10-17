import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs/promises';
const canvas = createCanvas(1024, 1024), c = canvas.getContext('2d');
c.fillStyle = '#193e32'; c.beginPath(); c.roundRect(20,20,984,984,220); c.fill();
const g=c.createLinearGradient(200,200,800,850);g.addColorStop(0,'#fff4bd');g.addColorStop(1,'#c8dcc7');
c.fillStyle=g;c.beginPath();c.arc(512,490,235,Math.PI,0);c.fill();
c.strokeStyle='#e2ebd4';c.lineWidth=44;c.lineCap='round';
for(const [y,w] of [[566,510],[670,370],[774,210]]) {c.beginPath();c.moveTo(512-w/2,y);c.lineTo(512+w/2,y);c.stroke();}
await fs.writeFile('src-tauri/icons/source.png',canvas.toBuffer('image/png'));
