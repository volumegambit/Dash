import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-2 font-semibold transition-colors',
  {
    variants: {
      variant: {
        default:
          'bg-brand-light text-brand border border-brand',
        pill: 'bg-surface text-text-primary border border-surface-muted',
        tag: 'bg-[#FFF0E8] text-brand font-mono text-[11px]',
      },
      size: {
        default: 'px-5 py-2 text-[13px]',
        sm: 'px-3.5 py-1.5 text-[11px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <div
      className={cn(badgeVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
