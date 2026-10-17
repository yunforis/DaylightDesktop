import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, LoaderCircle, PlugZap, RotateCcw, Save, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { FieldLabel } from '@/components/field-help';
import { CalendarSyncSettings } from '@/components/calendar-sync-settings';
import { CalendarCategoriesSettings, MailFiltersSettings } from '@/components/rules-settings';
import { request } from '@/lib/api';
import { useWorkspace } from '@/context/workspace';
import { formatHotkey, HOTKEY_DEFAULTS, readHotkeys, resetHotkeys, saveHotkeys } from '@/lib/hotkeys';

const DEFAULT_RANGES = [
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天起' },
  { id: 'week', label: '近一周' },
  { id: 'month', label: '近一个月' },
  { id: 'year', label: '近一年' },
  { id: 'custom', label: '自定义日期' },
];
const DEFAULT_STRATEGIES = [
  { id: 'idle', label: 'IMAP IDLE 推送（支持时优先）' },
  { id: 'poll', label: '定时轮询（默认）' },
];

export default function SettingsPage() {
  const { state, isSyncing, saveSettings, clearDemo, switchMailbox, reload } = useWorkspace();
  const settings = state.settings;
  const mailboxes = settings.mailboxes || [];
  const providers = settings.mailboxProviders || [];
  const modelProviders = settings.modelProviders || [];
  const tagOptions = settings.mailboxTagOptions || [
    { id: 'work', label: '工作' },
    { id: 'personal', label: '个人' },
    { id: 'life', label: '生活' },
    { id: 'custom', label: '自定义' },
  ];
  const help = settings.fieldHelp || {};
  const rangeOptions = settings.fetchRangeOptions || DEFAULT_RANGES;
  const strategyOptions = settings.syncStrategyOptions || DEFAULT_STRATEGIES;

  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState('');
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [promptMeta, setPromptMeta] = useState(null);
  const [persistence, setPersistence] = useState(null);
  const [hotkeys, setHotkeys] = useState(() => readHotkeys());

  useEffect(() => {
    const provider = providers.find((item) => item.id === (settings.provider || 'qq')) || providers[0] || {};
    setForm({
      ...provider,
      ...settings,
      provider: settings.provider || provider.id || 'qq',
      modelProvider: matchModelProvider(settings, modelProviders),
      mailboxId: settings.activeMailboxId || '',
      authorizationCode: '',
      apiKey: '',
      fetchMode: settings.fetchMode || 'recent',
      fetchRange: settings.fetchRange || 'week',
      fetchSince: settings.fetchSince || '',
      fetchUntil: settings.fetchUntil || '',
      syncStrategy: settings.syncStrategy || 'poll',
      pollIntervalSec: settings.pollIntervalSec || 60,
      tokenPriceIn: settings.tokenPriceIn ?? '',
      tokenPriceOut: settings.tokenPriceOut ?? '',
      tokenPriceCachedIn: settings.tokenPriceCachedIn ?? '',
      tag: settings.tag || 'work',
      tagCustom: settings.tagCustom || '',
      feishu: {
        appId: settings.feishu?.appId || '',
        ownerId: settings.feishu?.ownerId || '',
        appSecret: '',
      },
    });
  }, [settings.activeMailboxId, settings.email, settings.baseUrl, settings.model, settings.fetchMode, settings.syncStrategy, settings.tag, settings.tagCustom, settings.feishu?.appId, settings.feishu?.ownerId, settings.feishu?.hasAppSecret]);

  useEffect(() => {
    request('/prompts').then((data) => {
      setPrompt(data.extractionSystem || '');
      setPromptMeta(data);
    }).catch(() => {});
    request('/persistence').then(setPersistence).catch(() => {});
  }, []);

  if (!form) return null;
  const change = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const savedMailbox = mailboxes.find((mailbox) => mailbox.email?.toLowerCase() === form.email?.trim().toLowerCase());

  function chooseMailbox(id) {
    const mailbox = mailboxes.find((item) => item.id === id);
    setForm((current) => ({
      ...current,
      ...(mailbox || { ...(providers.find((item) => item.id === 'qq') || {}), provider: 'qq', email: '', fetchLimit: 15 }),
      mailboxId: id,
      authorizationCode: '',
    }));
  }

  function chooseProvider(id) {
    const provider = providers.find((item) => item.id === id);
    setForm((current) => ({ ...current, ...provider, provider: id }));
  }

  function chooseModelProvider(id) {
    const provider = modelProviders.find((item) => item.id === id);
    setForm((current) => ({
      ...current,
      modelProvider: id,
      ...(provider?.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider?.model ? { model: provider.model } : {}),
      // 切换提供商时带上该预设的参考单价（可再改）；自定义中转不覆盖已填单价
      ...(provider?.tokenPriceIn != null ? { tokenPriceIn: provider.tokenPriceIn } : {}),
      ...(provider?.tokenPriceOut != null ? { tokenPriceOut: provider.tokenPriceOut } : {}),
      ...(provider?.tokenPriceCachedIn != null ? { tokenPriceCachedIn: provider.tokenPriceCachedIn } : {}),
    }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await saveSettings(form);
      toast.success('设置已保存');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function testMailbox() {
    setTesting('mailbox'); setError('');
    try {
      const result = await request('/test/mailbox', 'POST', {
        mailboxId: form.mailboxId,
        email: form.email,
        authorizationCode: form.authorizationCode,
        provider: form.provider,
        imapHost: form.imapHost,
        imapPort: form.imapPort,
        imapSecure: form.imapSecure,
        smtpHost: form.smtpHost,
        smtpPort: form.smtpPort,
        smtpSecure: form.smtpSecure,
      });
      toast.success(result.message);
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setTesting('');
    }
  }

  async function testModel() {
    setTesting('model'); setError('');
    try {
      const result = await request('/test/model', 'POST', {
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
      });
      toast.success(result.message);
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setTesting('');
    }
  }

  async function savePrompt() {
    setBusy(true); setError('');
    try {
      const saved = await request('/prompts', 'PUT', { extractionSystem: prompt });
      setPromptMeta(saved);
      toast.success('提示词已保存，下次提取立即生效');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetPrompt() {
    setBusy(true);
    try {
      const saved = await request('/prompts/reset', 'POST', {});
      setPrompt(saved.extractionSystem);
      setPromptMeta(saved);
      toast.success('已恢复默认提示词');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">邮箱、模型、提取提示词与本地数据；云存储由管理员配置</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {settings.mailboxReady ? <Badge variant="secondary"><CheckCircle2 className="size-3" />邮箱已配置</Badge> : <Badge variant="outline">邮箱待配置</Badge>}
          {settings.modelReady ? <Badge variant="secondary"><CheckCircle2 className="size-3" />模型已配置</Badge> : <Badge variant="outline">模型待配置</Badge>}
        </div>
      </div>

      <Tabs defaultValue={new URLSearchParams(window.location.search).get('tab') || 'mailbox'} className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-8">
          <TabsTrigger value="mailbox">邮箱</TabsTrigger>
          <TabsTrigger value="model">模型</TabsTrigger>
          <TabsTrigger value="calendar">外部日历</TabsTrigger>
          <TabsTrigger value="categories">分类</TabsTrigger>
          <TabsTrigger value="filters">过滤</TabsTrigger>
          <TabsTrigger value="prompt">提示词</TabsTrigger>
          <TabsTrigger value="hotkeys">快捷键</TabsTrigger>
          <TabsTrigger value="data">数据</TabsTrigger>
        </TabsList>

        <TabsContent value="mailbox">
          <form className="grid gap-4 lg:grid-cols-2" onSubmit={onSubmit}>
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div>
                  <CardTitle className="text-base">邮箱账户</CardTitle>
                  <CardDescription>每个邮箱独立保存日历与邮件记录。预设会填入 IMAP/SMTP，也可改成自定义。</CardDescription>
                </div>
                <Button type="button" variant="outline" size="sm" disabled={!!testing || busy} onClick={testMailbox}>
                  {testing === 'mailbox' ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                  连通性测试
                </Button>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {mailboxes.length > 0 && (
                  <div className="space-y-2 md:col-span-2">
                    <FieldLabel help="切换已保存账户不会删除数据；换邮箱地址会新建独立数据目录。">已保存邮箱</FieldLabel>
                    <div className="flex flex-wrap gap-2">
                      <Select value={form.mailboxId || '__new__'} onValueChange={(value) => chooseMailbox(value === '__new__' ? '' : value)}>
                        <SelectTrigger className="max-w-md"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {mailboxes.map((mailbox) => (
                            <SelectItem key={mailbox.id} value={mailbox.id}>
                              [{mailbox.tagLabel || '工作'}] {mailbox.email || '未配置'}
                              {mailbox.id === settings.activeMailboxId ? ' · 当前' : ''}
                            </SelectItem>
                          ))}
                          <SelectItem value="__new__">添加另一个邮箱</SelectItem>
                        </SelectContent>
                      </Select>
                      {form.mailboxId && form.mailboxId !== settings.activeMailboxId && (
                        <Button type="button" variant="outline" disabled={busy || isSyncing} onClick={async () => {
                          setBusy(true);
                          try { await switchMailbox(form.mailboxId); toast.success('已切换邮箱'); }
                          catch (err) { setError(err.message); }
                          finally { setBusy(false); }
                        }}>
                          切换到此邮箱
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <FieldLabel help={help.email}>邮箱类型</FieldLabel>
                  <Select value={form.provider} onValueChange={chooseProvider}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {providers.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <FieldLabel help={help.email}>邮箱地址</FieldLabel>
                  <Input type="email" value={form.email || ''} onChange={(e) => change('email', e.target.value)} placeholder="you@example.com" />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel help={help.authorizationCode}>授权码 / 应用专用密码</FieldLabel>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.authorizationCode}
                    onChange={(e) => change('authorizationCode', e.target.value)}
                    placeholder={savedMailbox?.hasAuthorizationCode ? '已保存，留空保留' : '填写授权码，不是网页登录密码'}
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel help="给当前邮箱打标签，便于区分工作 / 个人 / 生活用途。">邮箱标签</FieldLabel>
                  <Select value={form.tag || 'work'} onValueChange={(value) => change('tag', value)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {tagOptions.map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <FieldLabel>自定义标签名</FieldLabel>
                  <Input
                    value={form.tagCustom || ''}
                    disabled={form.tag !== 'custom'}
                    onChange={(e) => change('tagCustom', e.target.value)}
                    placeholder={form.tag === 'custom' ? '例如：副业、家庭' : '选择「自定义」后可填写'}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">IMAP 收信</CardTitle>
                <CardDescription>同步邮件时连接此服务器</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-2">
                    <FieldLabel help={help.imapHost}>主机</FieldLabel>
                    <Input value={form.imapHost || ''} onChange={(e) => change('imapHost', e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>端口</FieldLabel>
                    <Input type="number" value={form.imapPort || ''} onChange={(e) => change('imapPort', e.target.value)} />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={Boolean(form.imapSecure)} onCheckedChange={(checked) => change('imapSecure', Boolean(checked))} />
                  使用 TLS（通常端口 993）
                </label>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">SMTP 发信</CardTitle>
                <CardDescription>发送冲突回复草稿时使用</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-2">
                    <FieldLabel help={help.smtpHost}>主机</FieldLabel>
                    <Input value={form.smtpHost || ''} onChange={(e) => change('smtpHost', e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>端口</FieldLabel>
                    <Input type="number" value={form.smtpPort || ''} onChange={(e) => change('smtpPort', e.target.value)} />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={Boolean(form.smtpSecure)} onCheckedChange={(checked) => change('smtpSecure', Boolean(checked))} />
                  使用 TLS（465）或 STARTTLS（587）
                </label>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">拉取策略</CardTitle>
                <CardDescription>新邮箱或同步时可按「最近 N 封」或「日期范围」拉取；并选择轮询或 IDLE。</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <FieldLabel help={help.fetchMode}>拉取方式</FieldLabel>
                  <Select value={form.fetchMode || 'recent'} onValueChange={(value) => change('fetchMode', value)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="recent">最近 N 封</SelectItem>
                      <SelectItem value="range">按日期范围</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <FieldLabel help={help.syncStrategy}>同步策略</FieldLabel>
                  <Select value={form.syncStrategy || 'poll'} onValueChange={(value) => change('syncStrategy', value)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {strategyOptions.map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {(form.fetchMode || 'recent') === 'recent' ? (
                  <div className="space-y-2">
                    <FieldLabel help={help.fetchLimit}>每次读取最近 N 封</FieldLabel>
                    <Input type="number" min="1" max="200" value={form.fetchLimit || 15} onChange={(e) => change('fetchLimit', e.target.value)} />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <FieldLabel help={help.fetchRange}>日期范围</FieldLabel>
                      <Select value={form.fetchRange || 'week'} onValueChange={(value) => change('fetchRange', value)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {rangeOptions.map((item) => (
                            <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {form.fetchRange === 'custom' && (
                      <>
                        <div className="space-y-2">
                          <FieldLabel>开始日期</FieldLabel>
                          <Input type="date" value={(form.fetchSince || '').slice(0, 10)} onChange={(e) => change('fetchSince', e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <FieldLabel>结束日期（可选）</FieldLabel>
                          <Input type="date" value={(form.fetchUntil || '').slice(0, 10)} onChange={(e) => change('fetchUntil', e.target.value)} />
                        </div>
                      </>
                    )}
                  </>
                )}
                <div className="space-y-2">
                  <FieldLabel>轮询间隔（秒）</FieldLabel>
                  <Input type="number" min="30" max="3600" value={form.pollIntervalSec || 60} onChange={(e) => change('pollIntervalSec', e.target.value)} />
                  <p className="text-xs text-muted-foreground">IDLE 模式下仍保留较慢的轮询兜底。</p>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-wrap justify-end gap-2 lg:col-span-2">
              {error && <p className="mr-auto text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy || isSyncing}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                {form.mailboxId === settings.activeMailboxId ? '保存邮箱设置' : '保存并切换'}
              </Button>
            </div>
          </form>
        </TabsContent>

        <TabsContent value="model">
          <form className="grid gap-4 lg:grid-cols-2" onSubmit={onSubmit}>
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div>
                  <CardTitle className="text-base">模型与 API Key（小 D 共用）</CardTitle>
                  <CardDescription>
                    任意 OpenAI 兼容 Chat Completions；中转站填其 Base URL。各邮箱共用同一套 Key。
                    可选费用单价与当前 Key / 模型一起保存，换预设会带入参考价，便于区分不同接口的估算成本。
                  </CardDescription>
                </div>
                <Button type="button" variant="outline" size="sm" disabled={!!testing || busy} onClick={testModel}>
                  {testing === 'model' ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                  连通性测试
                </Button>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel help="选择预设会填入常见 Base URL、示例模型与参考单价；自定义中转可改任意字段。">提供商 / 中转站</FieldLabel>
                  <Select value={form.modelProvider || 'custom'} onValueChange={chooseModelProvider}>
                    <SelectTrigger className="max-w-md"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {modelProviders.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel help={help.baseUrl}>Base URL</FieldLabel>
                  <Input type="url" value={form.baseUrl || ''} onChange={(e) => change('baseUrl', e.target.value)} placeholder="https://api.deepseek.com/v1" />
                </div>
                <div className="space-y-2">
                  <FieldLabel help={help.apiKey}>API Key</FieldLabel>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.apiKey}
                    onChange={(e) => change('apiKey', e.target.value)}
                    placeholder={settings.hasApiKey ? '已保存，留空保留' : 'sk-…'}
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel help={help.model}>模型名称</FieldLabel>
                  <Input value={form.model || ''} onChange={(e) => change('model', e.target.value)} placeholder="deepseek-chat" />
                </div>

                <Separator className="md:col-span-2" />

                <div className="space-y-1 md:col-span-2">
                  <p className="text-sm font-medium">费用单价（可选，随此 API Key 保存）</p>
                  <p className="text-xs text-muted-foreground text-pretty">
                    Token 数来自接口 usage；费用按下方单价估算（元 / 百万 Token），不是服务商账单。中转若另有计价，请改成你的实际单价。
                  </p>
                </div>
                <div className="space-y-2">
                  <FieldLabel help={help.tokenPrice}>输入</FieldLabel>
                  <Input type="number" min="0" step="any" value={form.tokenPriceIn} onChange={(e) => change('tokenPriceIn', e.target.value)} placeholder="元/百万" />
                </div>
                <div className="space-y-2">
                  <FieldLabel help={help.tokenPrice}>输出</FieldLabel>
                  <Input type="number" min="0" step="any" value={form.tokenPriceOut} onChange={(e) => change('tokenPriceOut', e.target.value)} placeholder="元/百万" />
                </div>
                <div className="space-y-2 md:col-span-2 sm:max-w-xs">
                  <FieldLabel help={help.tokenPrice}>缓存输入</FieldLabel>
                  <Input type="number" min="0" step="any" value={form.tokenPriceCachedIn} onChange={(e) => change('tokenPriceCachedIn', e.target.value)} placeholder="可选" />
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">飞书会议（招聘面试）</CardTitle>
                <CardDescription>
                  可选。配置后，面试邀约可自动创建飞书会议；也可在审核稿中粘贴腾讯会议 / 飞书链接。密钥仅保存在本地 settings。
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <FieldLabel>App ID</FieldLabel>
                  <Input
                    value={form.feishu?.appId || ''}
                    placeholder="cli_…"
                    onChange={(e) => change('feishu', { ...form.feishu, appId: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel>App Secret</FieldLabel>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.feishu?.appSecret || ''}
                    placeholder={settings.feishu?.hasAppSecret ? '已保存，留空保留' : '应用密钥'}
                    onChange={(e) => change('feishu', { ...form.feishu, appSecret: e.target.value })}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel>会议归属人 Open ID</FieldLabel>
                  <Input
                    value={form.feishu?.ownerId || ''}
                    placeholder="ou_…"
                    onChange={(e) => change('feishu', { ...form.feishu, ownerId: e.target.value })}
                  />
                </div>
                {settings.feishu?.configured && (
                  <p className="text-xs text-muted-foreground md:col-span-2">飞书会议已配置，可在智能招聘中一键创建。</p>
                )}
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground lg:col-span-2">
              模型 / 小 D / 分类 / 过滤规则保存在本地工作空间，仅这台设备可见。
            </p>

            <div className="flex flex-wrap justify-end gap-2 lg:col-span-2">
              {error && <p className="mr-auto text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy || isSyncing}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存模型设置
              </Button>
            </div>
          </form>
        </TabsContent>

        <TabsContent value="prompt">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
              <div>
                <CardTitle className="text-base">邮件提取提示词</CardTitle>
                <CardDescription>
                  保存在本地 prompts.json，每次模型调用都会重新读取（热更新）。
                  {promptMeta?.updatedAt ? ` 最近保存：${new Date(promptMeta.updatedAt).toLocaleString('zh-CN')}` : ''}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={resetPrompt}>
                  <RotateCcw className="size-4" />恢复默认
                </Button>
                <Button type="button" size="sm" disabled={busy} onClick={savePrompt}>
                  {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存提示词
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <FieldLabel help={help.extractionPrompt}>系统提示词</FieldLabel>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="min-h-[420px] font-mono text-xs leading-relaxed"
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="hotkeys">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="text-base">全局快捷键</CardTitle>
                <CardDescription className="break-keep text-pretty">
                  配置后立即生效。支持组合键如 mod+j，以及序列键如 g c。Mac 上 mod 为 ⌘，Windows / Linux 为 Ctrl。
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setHotkeys(resetHotkeys());
                  window.dispatchEvent(new Event('daylight:hotkeys-changed'));
                  toast.success('已恢复默认快捷键');
                }}
              >
                恢复默认
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {Object.entries(HOTKEY_DEFAULTS).map(([id, meta]) => (
                <div key={id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_180px_120px] sm:items-center">
                  <div>
                    <div className="text-sm font-medium">{meta.label}</div>
                    <div className="text-xs text-muted-foreground">当前显示：{formatHotkey(hotkeys[id]?.key || meta.key)}</div>
                  </div>
                  <Input
                    value={hotkeys[id]?.key || ''}
                    onChange={(e) => setHotkeys((current) => ({
                      ...current,
                      [id]: { ...current[id], key: e.target.value.toLowerCase() },
                    }))}
                    placeholder={meta.key}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      const next = saveHotkeys(hotkeys);
                      setHotkeys(next);
                      window.dispatchEvent(new Event('daylight:hotkeys-changed'));
                      toast.success('快捷键已保存');
                    }}
                  >
                    保存
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground break-keep">
                另：在待办卡片上右键可打开上下文菜单（查看原文 / 完成 / 恢复）。
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="calendar" className="space-y-4">
          <CalendarSyncSettings />
        </TabsContent>

        <TabsContent value="categories" className="space-y-4">
          <CalendarCategoriesSettings />
        </TabsContent>

        <TabsContent value="filters" className="space-y-4">
          <MailFiltersSettings />
        </TabsContent>

        <TabsContent value="data">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">一键导出 / 恢复</CardTitle>
                <CardDescription>导出包含设置、日程、邮件、证据链与提示词。文件含密钥，仅本地保管。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    const backup = await request('/backup');
                    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = `daylight-backup-${(backup.exportedAt || '').slice(0, 10) || 'export'}.json`;
                    anchor.click();
                    URL.revokeObjectURL(url);
                    toast.success('备份已下载');
                  } catch (err) {
                    setError(err.message);
                    toast.error(err.message);
                  } finally {
                    setBusy(false);
                  }
                }}>
                  <Download className="size-4" />导出备份
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = 'application/json,.json';
                  input.onchange = async () => {
                    const file = input.files?.[0];
                    if (!file) return;
                    setBusy(true); setError('');
                    try {
                      const payload = JSON.parse(await file.text());
                      if (!window.confirm('恢复备份会覆盖当前设置与各邮箱数据，确定继续？')) return;
                      await request('/backup/restore', 'POST', payload);
                      await reload();
                      toast.success('备份已恢复');
                    } catch (err) {
                      setError(err.message);
                      toast.error(err.message);
                    } finally {
                      setBusy(false);
                    }
                  };
                  input.click();
                }}>
                  <Upload className="size-4" />从文件恢复
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">持久化架构</CardTitle>
                <CardDescription>
                  {settings.calendarStorage?.note
                    || '默认本地 JSON；可选云组件（PG / Redis / MQ / OSS），不上 K8s。'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>· 日程主存储：<span className="font-medium text-foreground">{settings.calendarStorage?.primary === 'postgres' ? 'PostgreSQL（权威）' : '本地 JSON'}</span>
                  {settings.calendarStorage?.primary === 'postgres' ? ' · JSON 缓存' : ''}
                </p>
                <p>· <span className="font-medium text-foreground">settings.json</span>：邮箱、模型 Key / 分类 / 过滤等本地配置。</p>
                <p>· <span className="font-medium text-foreground">calendar.json</span>：每邮箱日程 / 邮件 / 待办（启用 PG 时双写并以库为准）。</p>
                <p>· <span className="font-medium text-foreground">prompts.json</span>：提取提示词热更新。</p>
                <p>· <span className="font-medium text-foreground">daylight.sqlite / sql.js</span>：提示词修订等本地元数据（与业务日历并行，不是唯一存储）。</p>
                {persistence && (
                  <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs">
                    <div>本地引擎：{persistence.engine || '—'}</div>
                    <div>IDLE：{persistence.idle?.active ? '监听中' : '未启用'}</div>
                    {persistence.path && <div className="truncate">SQLite：{persistence.path}</div>}
                    {persistence.infra && (
                      <div className="grid gap-1 border-t pt-2">
                        <div>PostgreSQL：{persistence.infra.postgres?.mode || persistence.infra.postgres?.ok ? '可用' : '未启用/回退'}</div>
                        <div>Redis：{persistence.infra.redis?.mode || (persistence.infra.redis?.ok ? '可用' : '未启用/回退')}</div>
                        <div>消息队列：{(persistence.infra.mq || persistence.infra.queue)?.mode || ((persistence.infra.mq || persistence.infra.queue)?.ok ? '可用' : '未启用/回退')}</div>
                        <div>对象存储：{persistence.infra.oss?.provider || persistence.infra.oss?.mode || 'local'}</div>
                      </div>
                    )}
                    {persistence.modelScope && (
                      <div>模型配置范围：{persistence.modelScope === 'user' ? '当前用户' : '共享默认'}</div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">示例数据</CardTitle>
                <CardDescription>清除不会删除真实邮箱同步结果</CardDescription>
              </CardHeader>
              <CardContent>
                <Button type="button" variant="outline" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try { await clearDemo(); toast.success('示例数据已清除'); }
                  catch (err) { setError(err.message); }
                  finally { setBusy(false); }
                }}>
                  清除示例数据
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function matchModelProvider(settings, modelProviders) {
  const hit = modelProviders.find((item) => item.baseUrl && item.baseUrl === settings.baseUrl);
  return hit?.id || 'custom';
}
