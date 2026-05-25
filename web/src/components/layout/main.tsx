import * as React from "react";

export const Main: React.FC<{ children?: React.ReactNode }> = (props) => {
  return (
    <main className="flex flex-auto flex-col">{props.children}</main>
  );
};
