import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export function WorkbenchSelect({ value, onValueChange, placeholder = '请选择', options, disabled = false, className, id, ...props }) {
  const choices = (options || []).filter((option) => option.value);
  return (
    <Select value={value || undefined} onValueChange={onValueChange} disabled={disabled || !choices.length}>
      <SelectTrigger id={id} className={cn('w-full', className)} {...props}>
        <SelectValue placeholder={choices.length ? placeholder : '暂无可选项'} />
      </SelectTrigger>
      <SelectContent>
        {choices.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function scenarioGuides(template = {}) {
  const tasks = [];
  const seen = new Set();
  for (const signal of template.signals || []) {
    for (const title of signal.tasks || []) {
      if (!title || seen.has(title)) continue;
      seen.add(title);
      tasks.push({
        title,
        detail: signal.warning || template.noticeWarning || '',
        stage: signal.suggestedStage || '',
      });
    }
  }
  return {
    tasks,
    samples: (template.samples || []).filter((sample) => sample.input && sample.expected),
    materials: template.materials || [],
    warning: template.noticeWarning || '',
    rules: template.rules || '',
  };
}

export function ScenarioAssistant({ template, itemTitle, busy, onPlan }) {
  const guides = scenarioGuides(template);
  const [note, setNote] = useState(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" />场景助手</CardTitle>
        <CardDescription>按这个模板声明的规则、材料和样例整理下一步。点生成只会得到待确认行动，不代发邮件，也不把读到的通知当成已经提交。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {guides.warning && <Alert><AlertDescription>{guides.warning}</AlertDescription></Alert>}
        {guides.materials.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">要盯住的材料</p>
            <div className="flex flex-wrap gap-1.5">{guides.materials.map((name) => <Badge key={name} variant="secondary">{name}</Badge>)}</div>
          </div>
        )}
        <div className="space-y-2">
          <p className="text-sm font-medium">这个场景会生成的行动</p>
          {guides.tasks.length === 0 && <p className="text-sm text-muted-foreground">模板还没有声明待办。在识别信号里写上要生成的任务后，这里会变成可试用的提示。</p>}
          {guides.tasks.map((task) => (
            <button key={task.title} type="button" className="w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/50" onClick={() => setNote({ title: task.title, body: task.detail || '确认前只是待处理行动。' })}>
              <p className="text-sm font-medium">{task.title}</p>
              {task.detail && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{task.detail}</p>}
            </button>
          ))}
        </div>
        {guides.samples.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">用一条样例看看会怎么处理</p>
            {guides.samples.map((sample) => (
              <button key={sample.input} type="button" className="w-full rounded-lg border border-dashed p-3 text-left text-sm transition-colors hover:border-primary/50" onClick={() => setNote({ title: sample.input, body: sample.expected })}>
                {sample.input}
              </button>
            ))}
          </div>
        )}
        {note && (
          <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm">
            <p className="font-medium">{note.title}</p>
            <p className="leading-relaxed text-muted-foreground">{note.body}</p>
          </div>
        )}
        <Button className="w-full" disabled={busy || !itemTitle} onClick={onPlan}>对{itemTitle ? `「${itemTitle}」` : '当前事项'}按规则生成</Button>
        {!itemTitle && <p className="text-xs text-muted-foreground">先在进度里新建一个事项，再生成待确认行动。</p>}
      </CardContent>
    </Card>
  );
}
