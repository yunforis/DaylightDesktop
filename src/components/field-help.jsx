import React from 'react';
import { CircleHelp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';

export function FieldHelp({ text, label }) {
  if (!text) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-6 text-muted-foreground"
          aria-label={label ? `${label}说明` : '字段说明'}
        >
          <CircleHelp className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-left text-xs leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export function FieldLabel({ children, htmlFor, help }) {
  return (
    <div className="flex items-center gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
        {children}
      </label>
      <FieldHelp text={help} label={typeof children === 'string' ? children : undefined} />
    </div>
  );
}
