/**
 * Unit tests for the shared `<FilterChipRow>` widget.
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterChipRow } from "../filter-chip-row";
const OPTIONS = [
    { key: "info", label: "Info", tone: "info" },
    { key: "warning", label: "Warning", tone: "warning" },
    { key: "error", label: "Error", tone: "destructive" },
];
describe("FilterChipRow", () => {
    it("renders the All chip and the option chips", () => {
        render(React.createElement(FilterChipRow, { label: "Severity", value: new Set(), options: OPTIONS, onChange: () => { } }));
        expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Info/ })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Warning/ })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Error/ })).toBeInTheDocument();
    });
    it("fires onChange with the added key when a chip is clicked", () => {
        const onChange = jest.fn();
        render(React.createElement(FilterChipRow, { label: "Severity", value: new Set(), options: OPTIONS, onChange: onChange }));
        fireEvent.click(screen.getByRole("button", { name: /Info/ }));
        expect(onChange).toHaveBeenCalledTimes(1);
        const next = onChange.mock.calls[0][0];
        expect(Array.from(next)).toEqual(["info"]);
    });
    it("fires onChange with the key removed when an active chip is clicked", () => {
        const onChange = jest.fn();
        render(React.createElement(FilterChipRow, { label: "Severity", value: new Set(["info", "warning"]), options: OPTIONS, onChange: onChange }));
        fireEvent.click(screen.getByRole("button", { name: /Info/ }));
        expect(onChange).toHaveBeenCalledTimes(1);
        const next = onChange.mock.calls[0][0];
        expect(Array.from(next).sort()).toEqual(["warning"]);
    });
    it("clears the set when the All chip is clicked", () => {
        const onChange = jest.fn();
        render(React.createElement(FilterChipRow, { label: "Severity", value: new Set(["info", "warning"]), options: OPTIONS, onChange: onChange }));
        fireEvent.click(screen.getByRole("button", { name: "All" }));
        expect(onChange).toHaveBeenCalledTimes(1);
        const next = onChange.mock.calls[0][0];
        expect(next.size).toBe(0);
    });
    it("renders count badges when supplied", () => {
        render(React.createElement(FilterChipRow, { label: "Severity", value: new Set(), options: OPTIONS, counts: { info: 3, warning: 0, error: 12 }, onChange: () => { } }));
        expect(screen.getByText("3")).toBeInTheDocument();
        expect(screen.getByText("12")).toBeInTheDocument();
    });
});
//# sourceMappingURL=filter-chip-row.spec.js.map