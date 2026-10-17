import React, { useEffect, useState } from 'react';
import { CalendarPlus, ExternalLink, LoaderCircle, PlugZap, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { request } from '@/lib/api';

const EMPTY_CALDAV = {
  provider: 'icloud',
  label: '',
  caldavUrl: 'https://caldav.icloud.com/',
  username: '',
  password: '',
  enabled: true,
};

export function CalendarSyncSettings() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [googleApp, setGoogleApp] = useState({ clientId: '', clientSecret: '' });
  const [msApp, setMsApp] = useState({ clientId: '', clientSecret: '' });
  const [caldav, setCaldav] = useState(EMPTY_CALDAV);

  async function reload() {
    const next = await request('/calendar-sync');
    setData(next);
    setGoogleApp({ clientId: next.oauthApps?.google?.clientId || '', clientSecret: '' });
    setMsApp({ clientId: next.oauthApps?.microsoft?.clientId || '', clientSecret: '' });
  }

  useEffect(() => {
    reload().catch((error) => toast.error(error.message));
    const params = new URLSearchParams(window.location.search);
    if (params.get('calendarSync') === 'ok') toast.success('外部日历已授权连接');
    if (params.get('calendarSync') === 'error') toast.error(params.get('message') || '授权失败');
  }, []);

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />加载外部日历配置…
        </CardContent>
      </Card>
    );
  }

  async function saveOAuthApps() {
    setBusy('oauth');
    try {
      await request('/calendar-sync/oauth-apps', 'PUT', {
        google: googleApp,
        microsoft: msApp,
      });
      await reload();
      toast.success('OAuth 应用配置已保存');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  async function startOAuth(provider) {
    setBusy(provider);
    try {
      const { url } = await request(`/calendar-sync/oauth/start/${provider}`);
      window.location.href = url;
    } catch (error) {
      toast.error(error.message);
      setBusy('');
    }
  }

  async function saveCaldav() {
    setBusy('caldav');
    try {
      await request('/calendar-sync/connections', 'POST', caldav);
      setCaldav(EMPTY_CALDAV);
      await reload();
      toast.success('CalDAV 连接已保存');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  async function toggleConnection(item, enabled) {
    try {
      await request('/calendar-sync/connections', 'POST', { ...item, enabled, password: '' });
      await reload();
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function removeConnection(id) {
    if (!window.confirm('确定移除该外部日历连接？')) return;
    try {
      await request(`/calendar-sync/connections/${id}`, 'DELETE');
      await reload();
      toast.success('已移除');
    } catch (error) {
      toast.error(error.message);
    }
  }

  async function testConnection(id) {
    setBusy(`test-${id}`);
    try {
      const result = await request(`/calendar-sync/test/${id}`, 'POST', {});
      toast.success(result.message || '连通成功');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy('');
    }
  }

  const icsUrl = `${window.location.origin}/api/calendar.ics`;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">外部日历同步</CardTitle>
          <CardDescription className="text-pretty">
            Daylight 本地/数据库日程为权威副本；创建、改期、取消后会推送到已连接的 Google、Outlook 或 CalDAV（含 iCloud）。
            Mac / iOS 浏览器可完成 OAuth；Apple「日历」App 通过 iCloud CalDAV 或下方 ICS 订阅同步。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">ICS 订阅（只读进系统日历）</p>
            <p className="mt-1 break-all">{icsUrl}</p>
            <p className="mt-1">在 Mac「日历」→ 文件 → 新建日历订阅，或 iOS「日历」→ 添加订阅日历，粘贴上述地址。双向写入请用 Google / Outlook OAuth 或 iCloud CalDAV。</p>
            <Button asChild size="sm" variant="outline" className="mt-2">
              <a href={icsUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" />下载当前 ICS
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">OAuth 应用（Google / Microsoft）</CardTitle>
          <CardDescription>
            在对应云控制台创建 Web 应用，回调地址填：
            <code className="mx-1 rounded bg-muted px-1">{`${window.location.origin}/api/calendar-sync/oauth/callback`}</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Google Client ID</Label>
            <Input value={googleApp.clientId} onChange={(e) => setGoogleApp((c) => ({ ...c, clientId: e.target.value }))} placeholder="xxxx.apps.googleusercontent.com" />
            <Label>Google Client Secret</Label>
            <Input type="password" value={googleApp.clientSecret} onChange={(e) => setGoogleApp((c) => ({ ...c, clientSecret: e.target.value }))} placeholder={data.oauthApps?.google?.hasClientSecret ? '已保存，留空保留' : '密钥'} />
          </div>
          <div className="space-y-2">
            <Label>Microsoft Client ID</Label>
            <Input value={msApp.clientId} onChange={(e) => setMsApp((c) => ({ ...c, clientId: e.target.value }))} placeholder="应用（客户端）ID" />
            <Label>Microsoft Client Secret</Label>
            <Input type="password" value={msApp.clientSecret} onChange={(e) => setMsApp((c) => ({ ...c, clientSecret: e.target.value }))} placeholder={data.oauthApps?.microsoft?.hasClientSecret ? '已保存，留空保留' : '客户端密码'} />
          </div>
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button type="button" disabled={Boolean(busy)} onClick={saveOAuthApps}>
              {busy === 'oauth' ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存 OAuth 配置
            </Button>
            <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => startOAuth('google')}>
              {busy === 'google' ? <LoaderCircle className="size-4 animate-spin" /> : <CalendarPlus className="size-4" />}
              连接 Google 日历
            </Button>
            <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => startOAuth('microsoft')}>
              {busy === 'microsoft' ? <LoaderCircle className="size-4 animate-spin" /> : <CalendarPlus className="size-4" />}
              连接 Outlook
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">CalDAV / iCloud</CardTitle>
          <CardDescription>
            iCloud：Apple ID 为用户名，密码用 appleid.apple.com 生成的 App 专用密码；日历 URL 多为
            <code className="mx-1 rounded bg-muted px-1">https://caldav.icloud.com/</code>
            （部分账号需完整日历集合路径）。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>类型</Label>
            <Select value={caldav.provider} onValueChange={(value) => setCaldav((c) => ({
              ...c,
              provider: value,
              caldavUrl: value === 'icloud' ? 'https://caldav.icloud.com/' : c.caldavUrl,
            }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="icloud">Apple iCloud</SelectItem>
                <SelectItem value="caldav">通用 CalDAV</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>显示名称</Label>
            <Input value={caldav.label} onChange={(e) => setCaldav((c) => ({ ...c, label: e.target.value }))} placeholder="我的 iPhone 日历" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>CalDAV 日历 URL</Label>
            <Input value={caldav.caldavUrl} onChange={(e) => setCaldav((c) => ({ ...c, caldavUrl: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label>用户名</Label>
            <Input value={caldav.username} onChange={(e) => setCaldav((c) => ({ ...c, username: e.target.value }))} placeholder="name@icloud.com" />
          </div>
          <div className="space-y-2">
            <Label>密码 / App 专用密码</Label>
            <Input type="password" value={caldav.password} onChange={(e) => setCaldav((c) => ({ ...c, password: e.target.value }))} />
          </div>
          <div className="md:col-span-2">
            <Button type="button" disabled={Boolean(busy) || !caldav.username || !caldav.password} onClick={saveCaldav}>
              {busy === 'caldav' ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
              保存 CalDAV 连接
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">已连接日历</CardTitle>
          <CardDescription>关闭开关可暂停推送；连通性测试会创建并删除一条临时事件。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(data.connections || []).length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未连接外部日历。</p>
          ) : data.connections.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{item.label || item.provider}</div>
                <div className="text-xs text-muted-foreground">
                  {item.provider}
                  {item.accountEmail ? ` · ${item.accountEmail}` : ''}
                  {item.username ? ` · ${item.username}` : ''}
                  {item.lastSyncAt ? ` · 最近同步 ${new Date(item.lastSyncAt).toLocaleString('zh-CN')}` : ''}
                </div>
                {item.lastError ? <p className="mt-1 text-xs text-destructive">{item.lastError}</p> : null}
              </div>
              <Switch checked={item.enabled !== false} onCheckedChange={(checked) => toggleConnection(item, checked)} />
              <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => testConnection(item.id)}>
                {busy === `test-${item.id}` ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                测试
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => removeConnection(item.id)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
