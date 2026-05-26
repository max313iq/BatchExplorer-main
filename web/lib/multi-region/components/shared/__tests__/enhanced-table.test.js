import { __awaiter } from "tslib";
/**
 * Tests for the canonical `<DataTable>` from
 * `src/multi-region/components/shared/enhanced-table.tsx`.
 *
 * Coverage targets (per Design Contract §5):
 *   - Basic row/cell rendering
 *   - Sortable column header (asc → desc → off + aria-sort)
 *   - Empty state (custom + default fallback)
 *   - Loading state (skeleton rows)
 *   - Selection (per-row toggle + select-all)
 *   - CSV export visibility (only when at least one column has a `csv` accessor)
 *   - Row activation (click + Enter)
 *   - Column-visibility menu hides hidden columns
 */
import * as React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable, } from "../enhanced-table";
// ---------------------------------------------------------------------------
// Mock `downloadCsv` so we can assert the click wires through without invoking
// blob/URL APIs that may not be fully implemented in jsdom.
// ---------------------------------------------------------------------------
jest.mock("@/lib/utils", () => {
    const actual = jest.requireActual("@/lib/utils");
    return Object.assign(Object.assign({}, actual), { downloadCsv: jest.fn() });
});
// Pull the mocked function in for assertions.
import { downloadCsv } from "@/lib/utils";
const downloadCsvMock = downloadCsv;
const ROWS = [
    { id: "a", name: "Apple", count: 3 },
    { id: "b", name: "Banana", count: 1 },
    { id: "c", name: "Cherry", count: 2 },
];
function makeColumns(opts = {}) {
    const cols = [
        Object.assign({ id: "name", header: "Name", cell: (r) => r.name, sort: (a, b) => a.name.localeCompare(b.name) }, (opts.withCsv ? { csv: (r) => r.name } : {})),
        {
            id: "count",
            header: "Count",
            cell: (r) => r.count,
        },
    ];
    return cols;
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("<DataTable>", () => {
    beforeEach(() => {
        downloadCsvMock.mockClear();
    });
    // -------- basic render --------------------------------------------------
    it("renders rows with the right cells", () => {
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id }));
        // Headers
        expect(screen.getByRole("button", { name: /sort by name/i })).toBeInTheDocument();
        expect(screen.getByText("Count")).toBeInTheDocument();
        // Cells
        expect(screen.getByText("Apple")).toBeInTheDocument();
        expect(screen.getByText("Banana")).toBeInTheDocument();
        expect(screen.getByText("Cherry")).toBeInTheDocument();
    });
    // -------- sorting -------------------------------------------------------
    it("toggles header sort asc → desc → off and updates aria-sort", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id }));
        const nameHeader = screen.getByRole("columnheader", { name: /name/i });
        expect(nameHeader).toHaveAttribute("aria-sort", "none");
        const sortBtn = within(nameHeader).getByRole("button");
        // 1st click → ascending
        yield user.click(sortBtn);
        expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
        // 2nd click → descending
        yield user.click(sortBtn);
        expect(nameHeader).toHaveAttribute("aria-sort", "descending");
        // 3rd click → cleared (back to none, since column is sortable)
        yield user.click(sortBtn);
        expect(nameHeader).toHaveAttribute("aria-sort", "none");
    }));
    it("non-sortable columns have no aria-sort attribute and no sort button", () => {
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id }));
        const countHeader = screen.getByRole("columnheader", { name: /count/i });
        expect(countHeader).not.toHaveAttribute("aria-sort");
        expect(within(countHeader).queryByRole("button")).toBeNull();
    });
    it("respects `initialSort` and renders rows in that order", () => {
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id, initialSort: { column: "name", direction: "desc" } }));
        // Verify aria-sort reflects initial state
        const nameHeader = screen.getByRole("columnheader", { name: /name/i });
        expect(nameHeader).toHaveAttribute("aria-sort", "descending");
        // Cell order: with desc sort by name, Cherry → Banana → Apple
        const rows = screen.getAllByRole("row");
        // rows[0] is the header; rows[1..3] are the data rows in sorted order.
        expect(within(rows[1]).getByText("Cherry")).toBeInTheDocument();
        expect(within(rows[2]).getByText("Banana")).toBeInTheDocument();
        expect(within(rows[3]).getByText("Apple")).toBeInTheDocument();
    });
    // -------- empty / loading ------------------------------------------------
    it("renders default empty fallback when rows=[] and no `empty` prop", () => {
        render(React.createElement(DataTable, { tableId: "tbl", rows: [], columns: makeColumns(), rowKey: (r) => r.id }));
        expect(screen.getByText(/no data/i)).toBeInTheDocument();
    });
    it("renders custom `empty` prop when rows=[]", () => {
        render(React.createElement(DataTable, { tableId: "tbl", rows: [], columns: makeColumns(), rowKey: (r) => r.id, empty: React.createElement("p", null, "nothing here") }));
        expect(screen.getByText("nothing here")).toBeInTheDocument();
        expect(screen.queryByText(/no data/i)).toBeNull();
    });
    it("renders skeleton rows when loading=true", () => {
        const { container } = render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id, loading: true }));
        // 6 skeleton rows are rendered (per the component); each row contains at
        // least one Skeleton div with the `animate-pulse` class.
        const skeletons = container.querySelectorAll(".animate-pulse");
        expect(skeletons.length).toBeGreaterThanOrEqual(6);
        // Real cells are NOT rendered while loading.
        expect(screen.queryByText("Apple")).toBeNull();
    });
    // -------- selection ------------------------------------------------------
    it("toggles a single row via the row checkbox", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        let selection = new Set();
        const onSelectionChange = jest.fn((next) => {
            selection = next;
        });
        function Wrapper() {
            const [s, setS] = React.useState(new Set());
            return (React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id, selection: s, onSelectionChange: (next) => {
                    onSelectionChange(next);
                    setS(next);
                } }));
        }
        render(React.createElement(Wrapper, null));
        const rowCheckboxes = screen.getAllByRole("checkbox", {
            name: /select row/i,
        });
        expect(rowCheckboxes).toHaveLength(ROWS.length);
        yield user.click(rowCheckboxes[1]); // toggle Banana
        expect(onSelectionChange).toHaveBeenCalledTimes(1);
        const last = onSelectionChange.mock.calls[0][0];
        expect(last.has("b")).toBe(true);
        expect(last.has("a")).toBe(false);
        expect(last.has("c")).toBe(false);
        void selection; // suppress lint
    }));
    it("select-all toggles every visible row at once", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        const onSelectionChange = jest.fn();
        function Wrapper() {
            const [s, setS] = React.useState(new Set());
            return (React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id, selection: s, onSelectionChange: (next) => {
                    onSelectionChange(next);
                    setS(next);
                } }));
        }
        render(React.createElement(Wrapper, null));
        const selectAll = screen.getByRole("checkbox", {
            name: /select all visible rows/i,
        });
        yield user.click(selectAll);
        expect(onSelectionChange).toHaveBeenCalled();
        const after = onSelectionChange.mock.calls[0][0];
        expect(after.has("a")).toBe(true);
        expect(after.has("b")).toBe(true);
        expect(after.has("c")).toBe(true);
    }));
    it("select-all checkbox unchecks all when all rows are already selected", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        const onSelectionChange = jest.fn();
        function Wrapper() {
            const [s, setS] = React.useState(new Set(ROWS.map((r) => r.id)));
            return (React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id, selection: s, onSelectionChange: (next) => {
                    onSelectionChange(next);
                    setS(next);
                } }));
        }
        render(React.createElement(Wrapper, null));
        const selectAll = screen.getByRole("checkbox", {
            name: /select all visible rows/i,
        });
        yield user.click(selectAll);
        const after = onSelectionChange.mock.calls[0][0];
        expect(after.size).toBe(0);
    }));
    // -------- CSV export ----------------------------------------------------
    it("does NOT render CSV button when no column has a `csv` accessor", () => {
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id }));
        expect(screen.queryByRole("button", { name: /export visible rows to csv/i })).toBeNull();
    });
    it("renders CSV button when at least one column has a `csv` accessor", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns({ withCsv: true }), rowKey: (r) => r.id }));
        const csvBtn = screen.getByRole("button", {
            name: /export visible rows to csv/i,
        });
        expect(csvBtn).toBeInTheDocument();
        yield user.click(csvBtn);
        expect(downloadCsvMock).toHaveBeenCalledTimes(1);
        const [filename, headers, dataRows] = downloadCsvMock.mock.calls[0];
        expect(filename).toBe("export-tbl.csv");
        expect(headers).toEqual(["Name"]);
        expect(dataRows).toEqual([["Apple"], ["Banana"], ["Cherry"]]);
    }));
    it("uses `csvFileName` override when provided", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns({ withCsv: true }), rowKey: (r) => r.id, csvFileName: "my-export.csv" }));
        yield user.click(screen.getByRole("button", { name: /export visible rows to csv/i }));
        expect(downloadCsvMock.mock.calls[0][0]).toBe("my-export.csv");
    }));
    // -------- row activation -------------------------------------------------
    it("invokes onRowActivate when a row is clicked", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        const onRowActivate = jest.fn();
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id, onRowActivate: onRowActivate }));
        // Find a body row (not the header) — interactive rows have role="button".
        const buttonRows = screen.getAllByRole("button").filter((el) => el.tagName.toLowerCase() === "tr");
        expect(buttonRows.length).toBe(ROWS.length);
        yield user.click(buttonRows[0]);
        expect(onRowActivate).toHaveBeenCalledWith(ROWS[0]);
    }));
    it("invokes onRowActivate when Enter is pressed on a row", () => {
        const onRowActivate = jest.fn();
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id, onRowActivate: onRowActivate }));
        const buttonRows = screen.getAllByRole("button").filter((el) => el.tagName.toLowerCase() === "tr");
        // Use fireEvent for keyboard events on a non-input element — this avoids
        // userEvent's pointer/focus dance and exercises the same code path.
        fireEvent.keyDown(buttonRows[1], { key: "Enter" });
        expect(onRowActivate).toHaveBeenCalledWith(ROWS[1]);
    });
    it("non-interactive rows (no onRowActivate) have no role=button", () => {
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id }));
        // Header has sort buttons, but no <tr role="button">.
        const buttonRows = screen.queryAllByRole("button").filter((el) => el.tagName.toLowerCase() === "tr");
        expect(buttonRows).toHaveLength(0);
    });
    // -------- column visibility ---------------------------------------------
    it("hides columns flagged `defaultHidden` on initial render", () => {
        const cols = [
            ...makeColumns(),
            {
                id: "secret",
                header: "Secret",
                cell: () => "hidden-cell",
                defaultHidden: true,
            },
        ];
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: cols, rowKey: (r) => r.id }));
        // The Secret column header should NOT appear in the rendered table.
        expect(screen.queryByRole("columnheader", { name: /^secret$/i })).toBeNull();
        expect(screen.queryByText("hidden-cell")).toBeNull();
    });
    it("renders the column-visibility toggle button in the toolbar", () => {
        render(React.createElement(DataTable, { tableId: "tbl", rows: ROWS, columns: makeColumns(), rowKey: (r) => r.id }));
        expect(screen.getByRole("button", { name: /toggle column visibility/i })).toBeInTheDocument();
    });
});
//# sourceMappingURL=enhanced-table.test.js.map