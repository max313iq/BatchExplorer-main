/**
 * Button primitive — variants/sizes per Design Contract §2.4–§2.6, plus a
 * `loading` prop that disables the button and renders an inline spinner
 * (Contract §3.2 mandates this for mutation buttons).
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-base ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Default (primary) button: cyan → violet gradient fill +
        // soft outer glow that intensifies on hover. The gradient comes
        // from the global token stops so a single CSS-var change
        // restyles every primary button across the app.
        default:
          "gradient-primary text-primary-foreground shadow-[0_4px_12px_-2px_hsl(var(--gradient-primary-mid)/0.45)] hover:shadow-[0_6px_18px_-2px_hsl(var(--gradient-primary-mid)/0.65)] hover:-translate-y-px active:translate-y-0",
        destructive:
          "bg-destructive text-destructive-foreground shadow-elev-1 hover:bg-destructive/90 active:bg-destructive/95",
        outline:
          "border border-input bg-transparent text-foreground hover:bg-accent/10 hover:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-elev-1 hover:bg-secondary/80",
        ghost: "text-foreground hover:bg-accent/10 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        subtle: "bg-muted text-foreground hover:bg-muted/80",
        success:
          "bg-success text-success-foreground shadow-elev-1 hover:bg-success/90",
        warning:
          "bg-warning text-warning-foreground shadow-elev-1 hover:bg-warning/90",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        xs: "h-6 rounded px-2 text-2xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
        "icon-sm": "h-7 w-7 [&_svg]:size-3.5",
        "icon-xs": "h-6 w-6 [&_svg]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * When true, disables the button and renders a leading spinner. Original
   * children continue to render so layout doesn't shift mid-action.
   * Use this for any mutation that performs an async side-effect.
   */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    // When asChild={true}, Slot uses React.Children.only and throws on
    // anything other than exactly one element child. Even `false` from a
    // short-circuit expression counts toward the child array — so we
    // CANNOT have `{cond && <X/>}{children}` here. Build the children
    // payload conditionally instead: when asChild, pass `children` and
    // ONLY `children`. The slotted element can render its own spinner.
    const inner = asChild ? (
      children
    ) : (
      <>
        {loading && (
          <Loader2
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        {children}
      </>
    );
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {inner}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
