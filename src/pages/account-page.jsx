import React from 'react';
import { Sparkles, UserRound } from 'lucide-react';
import { requestStartOnboarding } from '@/components/onboarding';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthUser } from '@/lib/auth-session';

export default function AccountPage() {
  const { user } = useAuthUser();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">账号</h1>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          管理登录身份。所有用户均可使用官方场景模板，工作台不受账号类型限制。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="size-4" />
            基本信息
          </CardTitle>
          <CardDescription>与工作邮箱配置无关，这是 Daylight 登录账号。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="flex justify-between gap-4 border-b pb-2">
            <span className="text-muted-foreground">用户名</span>
            <span className="font-medium">{user?.username || '—'}</span>
          </div>
          <div className="flex justify-between gap-4 border-b pb-2">
            <span className="text-muted-foreground">邮箱</span>
            <span className="font-medium break-all">{user?.email || '—'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">角色</span>
            <span className="font-medium">{user?.isAdmin ? '管理员' : '用户'}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            新手指引
          </CardTitle>
          <CardDescription>
            第一次登录会自动弹出。之后可随时重看：设置、同步、日历、邮件、待办等用法（内容可由管理员维护）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="outline" onClick={() => requestStartOnboarding()}>
            重新查看新手指引
          </Button>
        </CardContent>
      </Card>


    </div>
  );
}
