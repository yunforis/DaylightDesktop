import React from 'react';
import { Globe, Languages, Moon, Sun, SwatchBook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '@/components/theme-provider';

/** Landing / 认证页共用的主题色、明暗、语言切换（与工作区一致）。 */
export function PublicThemeControls({ className = '' }) {
  const { mode, toggleMode, accent, setAccent, accents, locale, setLocale, locales } = useTheme();

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" title="主题色" aria-label="主题色">
            <SwatchBook className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>主题色</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={accent} onValueChange={setAccent}>
            {accents.map((item) => (
              <DropdownMenuRadioItem key={item.id} value={item.id}>{item.label}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="icon"
        variant="ghost"
        onClick={toggleMode}
        title={mode === 'dark' ? '切换到浅色' : '切换到深色'}
        aria-label={mode === 'dark' ? '切换到浅色' : '切换到深色'}
      >
        {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" title="语言" aria-label="语言">
            <Languages className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="flex items-center gap-2">
            <Globe className="size-3.5" />语言
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={locale} onValueChange={setLocale}>
            {locales.map((item) => (
              <DropdownMenuRadioItem key={item.id} value={item.id}>{item.label}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
