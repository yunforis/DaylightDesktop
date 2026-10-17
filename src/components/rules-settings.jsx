import React, { useEffect, useState } from 'react';
import { LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';

const PALETTE = ['#3d7a5c', '#a66b3d', '#3b6ea5', '#8b5a9e', '#b4534a', '#4f7c74', '#6b7280', '#c2410b'];

function newCategory() {
  return {
    id: `cat_${Math.random().toString(36).slice(2, 8)}`,
    label: '新分类',
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)] || '#64748b',
    enabled: true,
    keywords: [],
  };
}

function newFilter() {
  return {
    id: `rule_${Math.random().toString(36).slice(2, 8)}`,
    name: '新过滤规则',
    enabled: true,
    action: 'skip',
    match: 'any',
    conditions: [{ field: 'subject', op: 'contains', value: '', caseSensitive: false }],
  };
}

export function CalendarCategoriesSettings() {
  const { state, reload } = useWorkspace();
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setItems((state?.settings?.calendarCategories || []).map((item) => ({
      ...item,
      keywordsText: (item.keywords || []).join('、'),
    })));
  }, [state?.settings?.calendarCategories]);

  async function save() {
    setBusy(true);
    try {
      await request('/calendar-categories', 'PUT', {
        categories: items.map(({ keywordsText, ...item }) => ({
          ...item,
          keywords: String(keywordsText || '')
            .split(/[,，、\n]/)
            .map((part) => part.trim())
            .filter(Boolean),
        })),
      });
      await reload();
      toast.success('日历分类已保存');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">日历分类</CardTitle>
        <CardDescription>
          左侧日历勾选区与日程归类共用这些分类。同步邮件时，模型会按「分类名 + 关键词」把日程归入对应类别。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((item, index) => (
          <div key={item.id} className="space-y-3 rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                checked={item.enabled !== false}
                onCheckedChange={(checked) => setItems((current) => current.map((row, i) => (
                  i === index ? { ...row, enabled: Boolean(checked) } : row
                )))}
              />
              <Input
                className="h-8 w-28"
                type="color"
                value={/^#/.test(item.color) ? item.color : '#64748b'}
                onChange={(e) => setItems((current) => current.map((row, i) => (
                  i === index ? { ...row, color: e.target.value } : row
                )))}
              />
              <Input
                className="h-8 min-w-[8rem] flex-1"
                value={item.label}
                onChange={(e) => setItems((current) => current.map((row, i) => (
                  i === index ? { ...row, label: e.target.value } : row
                )))}
                placeholder="分类名称"
              />
              <Badge variant="outline" className="font-mono text-[10px]">{item.id}</Badge>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={items.length <= 1}
                onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">归类关键词（逗号分隔，给模型提示）</Label>
              <Input
                value={item.keywordsText || ''}
                onChange={(e) => setItems((current) => current.map((row, i) => (
                  i === index ? { ...row, keywordsText: e.target.value } : row
                )))}
                placeholder="例如：会议、评审、项目"
              />
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setItems((current) => [...current, newCategory()])}>
            <Plus className="size-4" />添加分类
          </Button>
          <Button type="button" disabled={busy} onClick={save}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存分类
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function MailFiltersSettings() {
  const { state, reload } = useWorkspace();
  const fieldOptions = state?.settings?.filterFieldOptions || [
    { id: 'from', label: '发件人' },
    { id: 'subject', label: '主题' },
    { id: 'body', label: '正文' },
    { id: 'any', label: '任意文本' },
  ];
  const opOptions = state?.settings?.filterOpOptions || [
    { id: 'contains', label: '包含' },
    { id: 'not_contains', label: '不包含' },
    { id: 'equals', label: '等于' },
    { id: 'starts_with', label: '开头是' },
    { id: 'ends_with', label: '结尾是' },
    { id: 'wildcard', label: '通配符' },
    { id: 'regex', label: '正则' },
    { id: 'domain', label: '发件人域名' },
  ];
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setItems((state?.settings?.mailFilters || []).map((item) => ({
      ...item,
      conditions: (item.conditions || []).map((condition) => ({ ...condition })),
    })));
  }, [state?.settings?.mailFilters]);

  async function save() {
    setBusy(true);
    try {
      await request('/mail-filters', 'PUT', { filters: items });
      await reload();
      toast.success('过滤规则已保存');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  function updateRule(index, patch) {
    setItems((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function updateCondition(ruleIndex, conditionIndex, patch) {
    setItems((current) => current.map((row, i) => {
      if (i !== ruleIndex) return row;
      const conditions = row.conditions.map((condition, j) => (
        j === conditionIndex ? { ...condition, ...patch } : condition
      ));
      return { ...row, conditions };
    }));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">邮件过滤规则</CardTitle>
        <CardDescription>
          命中规则的邮件在同步时直接跳过，不调用模型。支持主题/发件人/正文、包含/域名/通配符/正则，以及「满足任一」或「全部满足」。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((rule, ruleIndex) => (
          <div key={rule.id} className="space-y-3 rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                checked={rule.enabled !== false}
                onCheckedChange={(checked) => updateRule(ruleIndex, { enabled: Boolean(checked) })}
              />
              <Input
                className="h-8 min-w-[10rem] flex-1"
                value={rule.name}
                onChange={(e) => updateRule(ruleIndex, { name: e.target.value })}
                placeholder="规则名称"
              />
              <Select value={rule.match || 'any'} onValueChange={(value) => updateRule(ruleIndex, { match: value })}>
                <SelectTrigger className="h-8 w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">满足任一条件</SelectItem>
                  <SelectItem value="all">全部条件满足</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => setItems((current) => current.filter((_, i) => i !== ruleIndex))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>

            <div className="space-y-2">
              {(rule.conditions || []).map((condition, conditionIndex) => (
                <div key={`${rule.id}-${conditionIndex}`} className="grid gap-2 md:grid-cols-[7rem_7.5rem_1fr_auto]">
                  <Select value={condition.field || 'subject'} onValueChange={(value) => updateCondition(ruleIndex, conditionIndex, { field: value })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {fieldOptions.map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={condition.op || 'contains'} onValueChange={(value) => updateCondition(ruleIndex, conditionIndex, { op: value })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {opOptions.map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="h-8"
                    value={condition.value || ''}
                    onChange={(e) => updateCondition(ruleIndex, conditionIndex, { value: e.target.value })}
                    placeholder="匹配值 / 正则 / 域名"
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={(rule.conditions || []).length <= 1}
                    onClick={() => updateRule(ruleIndex, {
                      conditions: rule.conditions.filter((_, i) => i !== conditionIndex),
                    })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => updateRule(ruleIndex, {
                  conditions: [...(rule.conditions || []), { field: 'subject', op: 'contains', value: '', caseSensitive: false }],
                })}
              >
                <Plus className="size-3.5" />条件
              </Button>
            </div>
          </div>
        ))}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setItems((current) => [...current, newFilter()])}>
            <Plus className="size-4" />添加规则
          </Button>
          <Button type="button" disabled={busy} onClick={save}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存规则
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
