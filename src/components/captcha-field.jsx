import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authRequest } from '@/lib/auth-api';

export const CaptchaField = forwardRef(function CaptchaField({ value, onChange, onCaptchaId }, ref) {
  const [svg, setSvg] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await authRequest('/auth/captcha');
      setSvg(data.svg);
      onCaptchaId(data.id);
      onChange('');
    } finally {
      setLoading(false);
    }
  }, [onCaptchaId, onChange]);

  useImperativeHandle(ref, () => ({
    refresh: () => refresh().catch(() => {}),
  }), [refresh]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  return (
    <div className="space-y-2">
      <Label htmlFor="captcha">图形验证码</Label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="h-10 overflow-hidden rounded-md border bg-muted/40 px-1"
          onClick={() => refresh().catch(() => {})}
          title="点击刷新"
          dangerouslySetInnerHTML={{ __html: svg || '<span class="px-3 text-xs text-muted-foreground">加载中</span>' }}
        />
        <Input
          id="captcha"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="输入图中字符"
          autoComplete="off"
          className="flex-1"
        />
        <Button type="button" size="icon" variant="outline" disabled={loading} onClick={() => refresh().catch(() => {})}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
    </div>
  );
});
