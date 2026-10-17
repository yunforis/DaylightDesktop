/**
 * 日程结束后的材料收纳与一键 AI 报告。
 * 材料元数据挂在 event.materials / event.reports；文件走 OSS/本地 attachments。
 */
import { randomUUID } from 'node:crypto';
import { putAttachment, getAttachmentObject } from './infra/oss.js';
import { callJsonModel } from './model-json.js';
import { readSettings, readStore, saveStore } from './store.js';
import { getRequestUserId } from './request-context.js';

export const MATERIAL_KINDS = [
  { id: 'note', label: '感受 / 备注' },
  { id: 'photo', label: '照片' },
  { id: 'ppt', label: 'PPT / 演示稿' },
  { id: 'report', label: '报告 / 文档' },
  { id: 'template', label: '报告模板' },
  { id: 'other', label: '其他' },
];

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript)|.*\+xml)/i;
const TEXT_EXT = /\.(txt|md|markdown|json|csv|html?|log)$/i;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function findEvent(store, eventId) {
  const index = (store.events || []).findIndex((item) => item.id === eventId);
  if (index < 0) {
    const error = new Error('日程不存在。');
    error.status = 404;
    throw error;
  }
  return { event: store.events[index], index };
}

function publicMaterial(item) {
  const { storageKey, ...visible } = item;
  return {
    ...visible,
    hasFile: Boolean(storageKey),
    previewUrl: storageKey ? `/api/events/${item.eventId || ''}/materials/${item.id}/file` : null,
  };
}

export function listMaterials(eventId) {
  const store = readStore();
  const { event } = findEvent(store, eventId);
  return {
    eventId,
    kinds: MATERIAL_KINDS,
    materials: (event.materials || []).map((item) => publicMaterial({ ...item, eventId })),
    reports: event.reports || [],
  };
}

export async function addMaterial(eventId, body = {}, { userId, username, mailboxId } = {}) {
  const filename = String(body.filename || 'file').trim() || 'file';
  const mimeType = String(body.mimeType || 'application/octet-stream').trim();
  const kind = MATERIAL_KINDS.some((item) => item.id === body.kind) ? body.kind : 'other';
  const note = String(body.note || '').trim().slice(0, 2000);
  const textContent = typeof body.textContent === 'string' ? body.textContent.slice(0, 100_000) : '';

  let buffer = null;
  if (body.contentBase64) {
    buffer = Buffer.from(String(body.contentBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length > MAX_UPLOAD_BYTES) {
      const error = new Error('单个附件不超过 8MB（demo 限制）。');
      error.status = 400;
      throw error;
    }
  }

  const store = readStore();
  const { event } = findEvent(store, eventId);
  const id = randomUUID();
  const material = {
    id,
    eventId,
    filename,
    mimeType,
    kind,
    note,
    textContent: textContent || undefined,
    size: buffer?.length || 0,
    createdAt: new Date().toISOString(),
  };

  if (buffer?.length) {
    const uploaded = await putAttachment({
      buffer,
      filename,
      contentType: mimeType,
      userId: userId || getRequestUserId(),
      username,
      mailboxId: mailboxId || readSettings().activeMailboxId || 'default',
      prefix: `materials/${mailboxId || readSettings().activeMailboxId || 'default'}/${eventId}`,
    });
    material.storageKey = uploaded.key;
    material.storage = uploaded.storage;
    material.size = uploaded.size;
  } else if (!textContent && kind !== 'note') {
    const error = new Error('请上传文件，或填写感受/备注文字。');
    error.status = 400;
    throw error;
  }

  event.materials = [...(event.materials || []), material];
  saveStore(store);
  return publicMaterial(material);
}

export function updateMaterial(eventId, materialId, patch = {}) {
  const store = readStore();
  const { event } = findEvent(store, eventId);
  const material = (event.materials || []).find((item) => item.id === materialId);
  if (!material) {
    const error = new Error('材料不存在。');
    error.status = 404;
    throw error;
  }
  if (patch.note !== undefined) material.note = String(patch.note || '').trim().slice(0, 2000);
  if (patch.kind && MATERIAL_KINDS.some((item) => item.id === patch.kind)) material.kind = patch.kind;
  if (patch.textContent !== undefined) material.textContent = String(patch.textContent || '').slice(0, 100_000);
  saveStore(store);
  return publicMaterial({ ...material, eventId });
}

export function removeMaterial(eventId, materialId) {
  const store = readStore();
  const { event } = findEvent(store, eventId);
  const before = event.materials?.length || 0;
  event.materials = (event.materials || []).filter((item) => item.id !== materialId);
  if ((event.materials?.length || 0) === before) {
    const error = new Error('材料不存在。');
    error.status = 404;
    throw error;
  }
  saveStore(store);
  return { ok: true };
}

export async function readMaterialFile(eventId, materialId) {
  const store = readStore();
  const { event } = findEvent(store, eventId);
  const material = (event.materials || []).find((item) => item.id === materialId);
  if (!material?.storageKey) {
    const error = new Error('该材料没有可预览的文件。');
    error.status = 404;
    throw error;
  }
  const object = await getAttachmentObject(material.storageKey);
  return {
    buffer: object.buffer,
    contentType: material.mimeType || object.contentType || 'application/octet-stream',
    filename: material.filename,
  };
}

async function extractTextSnippet(material) {
  if (material.textContent) return material.textContent.slice(0, 12_000);
  if (!material.storageKey) return '';
  if (!TEXT_MIME.test(material.mimeType || '') && !TEXT_EXT.test(material.filename || '')) {
    return '';
  }
  try {
    const object = await getAttachmentObject(material.storageKey);
    return object.buffer.toString('utf8').slice(0, 12_000);
  } catch {
    return '';
  }
}

export async function generateEventReport(eventId, body = {}) {
  const settings = readSettings();
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    const error = new Error('请先在设置中配置模型接口。');
    error.status = 400;
    throw error;
  }

  const store = readStore();
  const { event } = findEvent(store, eventId);
  const materials = event.materials || [];
  const requirements = String(body.requirements || '').trim();
  const templateMaterialId = body.templateMaterialId || '';
  const templateText = String(body.templateText || '').trim();

  let templateBlock = templateText;
  if (templateMaterialId) {
    const template = materials.find((item) => item.id === templateMaterialId);
    if (!template) {
      const error = new Error('未找到指定的报告模板材料。');
      error.status = 400;
      throw error;
    }
    templateBlock = (await extractTextSnippet(template)) || template.note || `（二进制模板：${template.filename}，请按常见报告结构撰写）`;
  }

  const materialBriefs = [];
  for (const item of materials) {
    if (item.id === templateMaterialId) continue;
    const snippet = await extractTextSnippet(item);
    materialBriefs.push({
      id: item.id,
      kind: item.kind,
      filename: item.filename,
      note: item.note || '',
      mimeType: item.mimeType,
      textExcerpt: snippet || null,
    });
  }

  const system = `你是活动复盘与报告助手。根据给定日程与用户上传的材料、模板/要求生成报告。
不要编造未提供的事实；材料不足时明确标注「材料未提供」。
只返回 JSON：{"title":"报告标题","summary":"两三句摘要","markdown":"完整 Markdown 正文"}。
markdown 使用中文，结构清晰，可含标题、列表、结论与待办。`;

  const userPayload = {
    event: {
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      location: event.location || '',
      description: event.description || '',
      category: event.category || '',
    },
    requirements: requirements || '按专业但简洁的活动总结报告撰写，含过程回顾、成果、问题与下一步。',
    template: templateBlock || null,
    materials: materialBriefs,
  };

  const result = await callJsonModel(settings, [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(userPayload) },
  ], { label: '生成活动报告', timeoutMs: 90_000 });

  const report = {
    id: randomUUID(),
    title: String(result.title || `${event.title || '活动'} · 复盘报告`).trim(),
    summary: String(result.summary || '').trim(),
    markdown: String(result.markdown || '').trim(),
    requirements,
    templateMaterialId: templateMaterialId || null,
    materialIds: materials.map((item) => item.id),
    createdAt: new Date().toISOString(),
    source: 'model',
  };
  if (!report.markdown) {
    const error = new Error('模型未返回报告正文，请重试或补充材料。');
    error.status = 502;
    throw error;
  }

  event.reports = [...(event.reports || []), report];
  saveStore(store);
  return report;
}

export function deleteReport(eventId, reportId) {
  const store = readStore();
  const { event } = findEvent(store, eventId);
  const before = event.reports?.length || 0;
  event.reports = (event.reports || []).filter((item) => item.id !== reportId);
  if ((event.reports?.length || 0) === before) {
    const error = new Error('报告不存在。');
    error.status = 404;
    throw error;
  }
  saveStore(store);
  return { ok: true };
}
