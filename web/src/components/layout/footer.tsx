import * as React from "react";

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-border bg-surface-base px-4 py-3 text-right text-xs text-muted-foreground">
      <span className="tabular-nums">&copy; {new Date().getFullYear()}</span>{" "}
      Microsoft
    </footer>
  );
};
