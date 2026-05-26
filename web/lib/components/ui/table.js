import { __rest } from "tslib";
import * as React from "react";
import { cn } from "@/lib/utils";
const Table = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("div", { className: "relative w-full overflow-auto" },
        React.createElement("table", Object.assign({ ref: ref, className: cn("w-full caption-bottom text-sm", className) }, props))));
});
Table.displayName = "Table";
const TableHeader = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("thead", Object.assign({ ref: ref, className: cn("[&_tr]:border-b [&_tr]:border-border bg-surface-sunken/50", className) }, props)));
});
TableHeader.displayName = "TableHeader";
const TableBody = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("tbody", Object.assign({ ref: ref, className: cn("[&_tr:last-child]:border-0", className) }, props)));
});
TableBody.displayName = "TableBody";
const TableFooter = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("tfoot", Object.assign({ ref: ref, className: cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className) }, props)));
});
TableFooter.displayName = "TableFooter";
const TableRow = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("tr", Object.assign({ ref: ref, className: cn("border-b border-border transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted", className) }, props)));
});
TableRow.displayName = "TableRow";
const TableHead = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("th", Object.assign({ ref: ref, className: cn("h-9 px-3 text-left align-middle text-2xs font-semibold uppercase tracking-wider text-muted-foreground [&:has([role=checkbox])]:pr-0", className) }, props)));
});
TableHead.displayName = "TableHead";
const TableCell = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("td", Object.assign({ ref: ref, className: cn("px-3 py-2 align-middle [&:has([role=checkbox])]:pr-0", className) }, props)));
});
TableCell.displayName = "TableCell";
const TableCaption = React.forwardRef((_a, ref) => {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (React.createElement("caption", Object.assign({ ref: ref, className: cn("mt-4 text-sm text-muted-foreground", className) }, props)));
});
TableCaption.displayName = "TableCaption";
export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption, };
//# sourceMappingURL=table.js.map