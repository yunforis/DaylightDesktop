import React, { useCallback, useEffect, useState } from 'react';
import {
  BookmarkPlus, FileText, Image as ImageIcon, LoaderCircle, Sparkles, Trash2, Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { getAuthToken } from '@/lib/auth-api';
import { getRequestMailboxId, request, withViewScope } from '@/lib/api';
import { cn } from '@/lib/utils';

const KIND_ICON = {
  photo: ImageIcon,
  ppt: FileText,
  report: FileText,
  template: FileText,
  note: FileText,
  other: FileText,
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function fetchMaterialBlob(previewUrl) {
  const response = await fetch(withViewScope(previewUrl), {
    headers: {
      ...(getRequestMailboxId() ? { 'X-Mailbox-Id': getRequestMailboxId() } : {}),
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
    },
  });
  if (!response.ok) {
    let message = '无法打开文件';
    try {
      const body = await response.json();
      message = body.error || message;
    } catch { /* binary or empty */ }
    throw new Error(message);
  }
  return response.blob();
}

function MaterialThumb({ item }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!item.hasFile || !item.previewUrl || !isImage(item)) return undefined;
    let alive = true;
    let objectUrl = '';
    fetchMaterialBlob(item.previewUrl)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.id, item.previewUrl, item.hasFile, item.mimeType, item.filename]);

  if (!src) return null;
  return (
    <img
      src={src}
      alt={item.filename}
      className="mt-2 max-h-36 rounded-md border object-contain"
    />
  );
}

export function EventAftermathPanel({ eventId, ended, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [kind, setKind] = useState('note');
  const [note, setNote] = useState('');
  const [textContent, setTextContent] = useState('');
  const [requirements, setRequirements] = useState('');
  const [templateMaterialId, setTemplateMaterialId] = useState('');
  const [templateText, setTemplateText] = useState('');
  const [activeReportId, setActiveReportId] = useState('');
  const [presets, setPresets] = useState([]);
  const [activePresetId, setActivePresetId] = useState('');
  const [presetName, setPresetName] = useState('');

  const reload = useCallback(async () => {
    const next = await request(`/events/${eventId}/materials`);
    setData(next);
    setActiveReportId((current) => {
      if (current && next.reports?.some((item) => item.id === current)) return current;
      return next.reports?.length ? next.reports[next.reports.length - 1].id : '';
    });
  }, [eventId]);

  const reloadPresets = useCallback(async () => {
    const next = await request('/report-prompts');
    setPresets(next.presets || []);
  }, []);

  useEffect(() => {
    reload().catch((error) => toast.error(error.message));
  }, [reload]);

  useEffect(() => {
    reloadPresets().catch(() => {});
  }, [reloadPresets]);

  function applyPreset(preset) {
    setActivePresetId(preset.id);
    setRequirements(preset.requirements || '');
    setTemplateText(preset.templateText || '');
    setPresetName(preset.name || '');
  }

  async function saveCurrentPreset() {
    const name = String(presetName || '').trim() || '未命名模板';
    if (!requirements.trim() && !templateText.trim()) {
      toast.message('请先填写写作要求或模板大纲');
      return;
    }
    setBusy('preset');
    try {
      const next = await request('/report-prompts/presets', 'POST', {
        id: activePresetId || undefined,
        name,
        requirements,
        templateText,
      });
      setPresets(next.presets || []);
      const hit = (next.presets || []).find((item) => item.name === name)
        || (next.presets || []).at(-1);
      if (hit) setActivePresetId(hit.id);
      toast.success('提示词模板已保存');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  async function removePreset(id) {
    if (!window.confirm('删除该提示词模板？')) return;
    setBusy(`preset-del-${id}`);
    try {
      const next = await request(`/report-prompts/presets/${encodeURIComponent(id)}`, 'DELETE');
      setPresets(next.presets || []);
      if (activePresetId === id) setActivePresetId('');
      toast.success('已删除模板');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  async function uploadFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length && !textContent.trim() && !note.trim()) {
      toast.message('请选择文件或填写感受文字');
      return;
    }
    setBusy('upload');
    try {
      if (files.length) {
        for (const file of files) {
          const contentBase64 = await fileToBase64(file);
          await request(`/events/${eventId}/materials`, 'POST', {
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            kind: kind === 'note' ? guessKind(file) : kind,
            note,
            contentBase64,
          });
        }
      } else {
        await request(`/events/${eventId}/materials`, 'POST', {
          filename: '感受备注.txt',
          mimeType: 'text/plain',
          kind: 'note',
          note,
          textContent,
        });
      }
      setNote('');
      setTextContent('');
      await reload();
      await onChanged?.();
      toast.success('材料已保存');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  async function removeItem(materialId) {
    if (!window.confirm('删除该材料？')) return;
    setBusy(`del-${materialId}`);
    try {
      await request(`/events/${eventId}/materials/${materialId}`, 'DELETE');
      await reload();
      await onChanged?.();
      toast.success('已删除');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  async function openPreview(item) {
    if (!item.previewUrl) return;
    setBusy(`preview-${item.id}`);
    try {
      const blob = await fetchMaterialBlob(item.previewUrl);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  async function generateReport() {
    setBusy('report');
    try {
      const report = await request(`/events/${eventId}/reports/generate`, 'POST', {
        requirements,
        templateMaterialId: templateMaterialId || undefined,
        templateText: templateText || undefined,
      });
      await reload();
      await onChanged?.();
      setActiveReportId(report.id);
      toast.success('报告已生成');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  async function removeReport(reportId) {
    if (!window.confirm('删除该报告？')) return;
    try {
      await request(`/events/${eventId}/reports/${reportId}`, 'DELETE');
      setActiveReportId('');
      await reload();
      await onChanged?.();
    } catch (error) {
      toast.error(error.message);
    }
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        加载活动材料…
      </div>
    );
  }

  const templates = (data.materials || []).filter((item) => (
    item.kind === 'template' || /\.(md|txt|doc)$/i.test(item.filename || '')
  ));
  const activeReport = (data.reports || []).find((item) => item.id === activeReportId)
    || data.reports?.[data.reports.length - 1];

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border bg-card">
        <div className="flex items-center justify-between gap-2 border-b bg-muted/25 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">活动后续 · 材料收纳</h3>
            <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
              上传报告、PPT、照片或写下感受，再按提示词模板一键生成复盘。
            </p>
          </div>
          {ended ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">已结束</span>
          ) : (
            <span className="shrink-0 text-[11px] text-amber-700 dark:text-amber-300">可提前归档</span>
          )}
        </div>

        <div className="space-y-3 px-4 py-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>材料类型</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(data.kinds || []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>简短说明</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：现场照片 / 最终版 PPT" />
            </div>
          </div>

          {(kind === 'note' || kind === 'report') && (
            <div className="space-y-1.5">
              <Label>文字内容（可不选文件）</Label>
              <Textarea
                rows={3}
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                placeholder="写下感受、要点或粘贴文本…"
              />
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} asChild>
              <label className="cursor-pointer">
                <Upload className="size-4" />
                选择文件上传
                <input
                  type="file"
                  className="hidden"
                  multiple
                  accept="image/*,.pdf,.ppt,.pptx,.doc,.docx,.txt,.md,.csv,.json"
                  onChange={(e) => {
                    uploadFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={Boolean(busy) || (!textContent.trim() && !note.trim())}
              onClick={() => uploadFiles([])}
            >
              {busy === 'upload' ? <LoaderCircle className="size-4 animate-spin" /> : null}
              仅保存文字
            </Button>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              已收纳 {(data.materials || []).length} 项
            </div>
            {(data.materials || []).length === 0 ? (
              <p className="rounded-xl border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                还没有材料。结束后把 PPT、照片和感受放进来即可。
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.materials.map((item) => {
                  const Icon = KIND_ICON[item.kind] || FileText;
                  return (
                    <li key={item.id} className="flex items-start gap-2 rounded-xl border bg-background px-2.5 py-2">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{item.filename}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {(data.kinds || []).find((entry) => entry.id === item.kind)?.label || item.kind}
                          {item.note ? ` · ${item.note}` : ''}
                        </div>
                        {item.textContent && (
                          <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.textContent}</p>
                        )}
                        <MaterialThumb item={item} />
                      </div>
                      <div className="flex shrink-0 flex-col gap-1">
                        {item.hasFile && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={busy === `preview-${item.id}`}
                            onClick={() => openPreview(item)}
                          >
                            预览
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          disabled={busy === `del-${item.id}`}
                          onClick={() => removeItem(item.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-card">
        <div className="flex items-center gap-2 border-b bg-muted/25 px-4 py-3 text-sm font-semibold">
          <Sparkles className="size-3.5" />
          一键生成报告 · 提示词管理
        </div>
        <div className="space-y-3 px-4 py-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>提示词模板</Label>
              <span className="text-[11px] text-muted-foreground">点击套用 · 可保存当前填写</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors',
                    activePresetId === preset.id
                      ? 'border-foreground bg-foreground text-background'
                      : 'bg-muted/40 text-foreground hover:bg-muted',
                  )}
                >
                  <button type="button" className="max-w-[9rem] truncate" onClick={() => applyPreset(preset)}>
                    {preset.name}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'rounded-full p-0.5 opacity-70 hover:opacity-100',
                      activePresetId === preset.id ? 'hover:bg-background/20' : 'hover:bg-foreground/10',
                    )}
                    aria-label={`删除 ${preset.name}`}
                    disabled={busy === `preset-del-${preset.id}`}
                    onClick={() => removePreset(preset.id)}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
              {!presets.length && (
                <p className="text-xs text-muted-foreground">暂无模板，填写下方后可保存。</p>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="模板名称，例如：校招复盘"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={saveCurrentPreset}
              >
                {busy === 'preset'
                  ? <LoaderCircle className="size-4 animate-spin" />
                  : <BookmarkPlus className="size-4" />}
                {activePresetId ? '更新模板' : '保存为模板'}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>写作要求</Label>
            <Textarea
              rows={3}
              value={requirements}
              onChange={(e) => {
                setRequirements(e.target.value);
                setActivePresetId('');
              }}
              placeholder="例如：按公司周报格式，含成果、风险、下周计划；语气正式"
              className="font-mono text-[13px] leading-relaxed"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>选用已上传模板（可选）</Label>
              <Select
                value={templateMaterialId || '__none'}
                onValueChange={(value) => setTemplateMaterialId(value === '__none' ? '' : value)}
              >
                <SelectTrigger><SelectValue placeholder="不使用模板文件" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">不使用模板文件</SelectItem>
                  {templates.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.filename}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>或粘贴模板大纲</Label>
              <Textarea
                rows={3}
                value={templateText}
                onChange={(e) => {
                  setTemplateText(e.target.value);
                  setActivePresetId('');
                }}
                placeholder={'一、背景\n二、过程\n三、结论'}
                className="font-mono text-[13px] leading-relaxed"
              />
            </div>
          </div>
          <Button type="button" size="sm" disabled={Boolean(busy)} onClick={generateReport}>
            {busy === 'report' ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            根据材料生成报告
          </Button>

        {(data.reports || []).length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {data.reports.map((report) => (
                <button
                  key={report.id}
                  type="button"
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs',
                    activeReport?.id === report.id ? 'border-foreground bg-background' : 'bg-muted/40 text-muted-foreground',
                  )}
                  onClick={() => setActiveReportId(report.id)}
                >
                  {report.title}
                </button>
              ))}
            </div>
            {activeReport && (
              <div className="rounded-md border bg-background p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{activeReport.title}</div>
                    {activeReport.summary && (
                      <p className="mt-1 text-xs text-muted-foreground">{activeReport.summary}</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => removeReport(activeReport.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                  {activeReport.markdown}
                </pre>
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function guessKind(file) {
  if (file.type?.startsWith('image/')) return 'photo';
  if (/\.(ppt|pptx|key)$/i.test(file.name)) return 'ppt';
  if (/\.(pdf|doc|docx)$/i.test(file.name)) return 'report';
  if (/\.(md|txt)$/i.test(file.name)) return 'template';
  return 'other';
}

function isImage(item) {
  return String(item.mimeType || '').startsWith('image/')
    || /\.(png|jpe?g|gif|webp|bmp)$/i.test(item.filename || '');
}
