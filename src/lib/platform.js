/** 识别当前设备，用于 Landing 下载入口加粗提示。 */

export const DOWNLOAD_OPTIONS = [
  { id: 'mac-arm', label: 'macOS（Apple 芯片）', group: 'desktop' },
  { id: 'mac-intel', label: 'macOS（Intel）', group: 'desktop' },
  { id: 'windows', label: 'Windows', group: 'desktop' },
  { id: 'linux', label: 'Linux', group: 'desktop' },
  { id: 'ios', label: 'iOS', group: 'mobile' },
  { id: 'android', label: 'Android', group: 'mobile' },
  { id: 'harmony', label: '鸿蒙', group: 'mobile' },
];

export async function detectPreferredDownloadId() {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';

  if (/HarmonyOS|OpenHarmony|HUAWEI/i.test(ua) && /Mobile|Android/i.test(ua)) {
    return 'harmony';
  }
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';

  const isMac = /Mac/i.test(platform) || /Macintosh/i.test(ua);
  if (isMac) {
    const arch = await readArchitecture();
    if (arch === 'x86') return 'mac-intel';
    return 'mac-arm';
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  if ((/Linux/i.test(platform) || /Linux/i.test(ua)) && !/Android/i.test(ua)) return 'linux';
  return null;
}

async function readArchitecture() {
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
      if (architecture) return String(architecture).toLowerCase();
    }
  } catch {
    /* ignore */
  }
  return '';
}
