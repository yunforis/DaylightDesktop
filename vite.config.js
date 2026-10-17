import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = 'assets';

// 资源文件命名：与 Vite 默认的 `assets/[name]-[hash].[ext]` 等价，只修掉一个「以点结尾」的坑。
//
// Vite 的默认模板把扩展名当成 `.[ext]` 拼进去，而 `[ext]` 对**没有扩展名**的文件是空串，
// 于是产出的名字会以一个点结尾。实测：pdfjs-dist 的 `LICENSE_JBIG2` →
// `assets/LICENSE_JBIG2-C_izpuvI.`（`standard_fonts/LICENSE_LIBERATION` 同理）。
// 这种文件名在 POSIX 上合法，在 Windows 上非法——连文件都建不出来，Tauri 打包资源时直接报
// `resource path `runtime\dist\assets\LICENSE_JBIG2-C_izpuvI.` doesn't exist`，
// 而 macOS / Linux 上完全看不出来（本地与 macOS CI 都是绿的，是 windows-latest 抓出来的）。
//
// 这里保持默认命名不变，只在没有扩展名时省掉那个点。仍返回**模板字符串**（而不是最终文件名），
// 让 Rollup 继续负责 `[name]` / `[hash]` 的替换，hash 的算法与去重行为都不变。
function assetFileNames(assetInfo) {
  const original = assetInfo?.names?.[0] ?? assetInfo?.name ?? '';
  const pattern = path.extname(original) === '' ? `[name]-[hash]` : `[name]-[hash].[ext]`;
  return path.posix.join(assetsDir, pattern);
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'esnext',
    rollupOptions: { output: { assetFileNames } },
  },
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
    },
  },
});
