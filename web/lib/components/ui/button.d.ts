/**
 * Button primitive — variants/sizes per Design Contract §2.4–§2.6, plus a
 * `loading` prop that disables the button and renders an inline spinner
 * (Contract §3.2 mandates this for mutation buttons).
 */
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
declare const buttonVariants: (props?: ({
    variant?: "link" | "success" | "warning" | "default" | "destructive" | "outline" | "secondary" | "ghost" | "subtle" | null | undefined;
    size?: "default" | "sm" | "xs" | "lg" | "icon" | "icon-sm" | "icon-xs" | null | undefined;
} & import("class-variance-authority/dist/types").ClassProp) | undefined) => string;
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    asChild?: boolean;
    /**
     * When true, disables the button and renders a leading spinner. Original
     * children continue to render so layout doesn't shift mid-action.
     * Use this for any mutation that performs an async side-effect.
     */
    loading?: boolean;
}
declare const Button: React.ForwardRefExoticComponent<ButtonProps & React.RefAttributes<HTMLButtonElement>>;
export { Button, buttonVariants };
//# sourceMappingURL=button.d.ts.map