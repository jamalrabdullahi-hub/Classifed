'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { X } from 'lucide-react';
import { forwardRef } from 'react';
import { cn } from '../cn';

/**
 * Overlays and navigation, on Radix primitives.
 *
 * Radix rather than hand-rolled because focus trapping, escape handling,
 * scroll locking and the ARIA wiring are easy to get subtly wrong and hard to
 * notice when you do — and a trade confirmation dialog is precisely where a
 * keyboard user must not get stranded.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(function DialogContent({ className, children, hideClose = false, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]',
          'data-[state=open]:animate-fade-up',
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
          'rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-raised)]',
          'shadow-[var(--shadow-lg)] data-[state=open]:animate-fade-up',
          'max-h-[calc(100vh-2rem)] overflow-y-auto',
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose ? (
          <DialogPrimitive.Close
            className={cn(
              'absolute right-4 top-4 rounded-[var(--radius-sm)] p-1',
              'text-[var(--text-subtle)] transition-colors',
              'hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
            )}
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-[var(--border)] px-5 py-4', className)} {...props} />;
}

export const DialogTitle = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-[15px] font-semibold tracking-[-0.01em] text-[var(--text)]', className)}
      {...props}
    />
  );
});

export const DialogDescription = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]', className)}
      {...props}
    />
  );
});

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 border-t border-[var(--border)] px-5 py-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('flex items-center gap-1 border-b border-[var(--border)]', className)}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'relative -mb-px border-b-2 border-transparent px-3 py-2 text-[13px] font-medium',
        'text-[var(--text-muted)] transition-colors hover:text-[var(--text)]',
        'data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--text)]',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = TabsPrimitive.Content;

// ── Tooltip ─────────────────────────────────────────────────────────────────

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <TooltipPrimitive.Root delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-50 max-w-xs rounded-[var(--radius-sm)] border border-[var(--border-strong)]',
            'bg-[var(--surface-raised)] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--text)]',
            'shadow-[var(--shadow-md)] data-[state=delayed-open]:animate-fade-up',
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
