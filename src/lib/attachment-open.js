/** 全局附件预览入口：由 AttachmentViewerProvider 注入，任意处可调用。 */
let opener = null;

export function setAttachmentOpener(fn) {
  opener = typeof fn === 'function' ? fn : null;
}

export function openAttachmentViewer(file) {
  if (!opener) {
    console.warn('AttachmentViewerProvider 尚未挂载');
    return;
  }
  opener(file);
}
