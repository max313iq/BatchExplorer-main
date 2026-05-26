import { __awaiter } from "tslib";
/**
 * Tests for the shared <ConfirmationDialog/> component.
 *
 * The component wraps the Radix Dialog primitive. Its public API is:
 *   - hidden: boolean        // inverse of "open"; when false the dialog renders
 *   - title / message
 *   - confirmText / cancelText
 *   - danger: boolean        // when true, confirm button uses the destructive variant
 *   - onConfirm / onCancel
 *   - loading: boolean       // suppresses cancel paths and renders a spinner
 *
 * These tests cover render, button wiring, danger styling/aria, escape-to-close,
 * and that focus moves inside the dialog on open (the focus-trap requirement).
 */
import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationDialog } from "../confirmation-dialog";
function renderDialog(overrides = {}) {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const props = Object.assign({ hidden: false, title: "Delete pool?", message: "This action cannot be undone.", onConfirm,
        onCancel }, overrides);
    const utils = render(React.createElement(ConfirmationDialog, Object.assign({}, props)));
    return Object.assign(Object.assign({}, utils), { onConfirm, onCancel, props });
}
/**
 * Locate the dialog content node. Radix renders multiple elements that could
 * match name+role queries (the close 'X' shares an aria-label with the dialog),
 * so we scope all queries to within this container.
 */
function getDialog() {
    return screen.getByRole("dialog");
}
describe("ConfirmationDialog", () => {
    it("does not render dialog content when hidden", () => {
        renderDialog({ hidden: true });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    it("renders title and string message when open", () => {
        renderDialog();
        const dialog = getDialog();
        expect(within(dialog).getByText("Delete pool?")).toBeInTheDocument();
        expect(within(dialog).getByText("This action cannot be undone.")).toBeInTheDocument();
    });
    it("uses the bodyId for the description so aria-describedby resolves", () => {
        renderDialog();
        const dialog = getDialog();
        const describedBy = dialog.getAttribute("aria-describedby");
        expect(describedBy).toBe("confirmation-dialog-body");
        // Element with that id exists and contains the message text.
        const body = document.getElementById("confirmation-dialog-body");
        expect(body).not.toBeNull();
        expect(body).toHaveTextContent("This action cannot be undone.");
    });
    it("renders a ReactNode message inside a div (not a <p>)", () => {
        renderDialog({
            message: React.createElement("span", { "data-testid": "custom-msg" }, "custom node"),
        });
        const custom = screen.getByTestId("custom-msg");
        expect(custom).toBeInTheDocument();
        // Wrapped in the bodyId div, not a DialogDescription <p>.
        const body = document.getElementById("confirmation-dialog-body");
        expect(body === null || body === void 0 ? void 0 : body.tagName).toBe("DIV");
        expect(body).toContainElement(custom);
    });
    it("uses default Confirm / Cancel labels when none are provided", () => {
        renderDialog();
        const dialog = getDialog();
        expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });
    it("uses custom confirmText / cancelText when provided", () => {
        renderDialog({ confirmText: "Delete", cancelText: "Keep it" });
        const dialog = getDialog();
        expect(within(dialog).getByRole("button", { name: "Delete" })).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Keep it" })).toBeInTheDocument();
    });
    it("invokes onConfirm when the confirm button is clicked", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        const { onConfirm, onCancel } = renderDialog({ confirmText: "Yes" });
        const dialog = getDialog();
        yield user.click(within(dialog).getByRole("button", { name: "Yes" }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    }));
    it("invokes onCancel when the cancel button is clicked", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        const { onConfirm, onCancel } = renderDialog({ cancelText: "No" });
        const dialog = getDialog();
        yield user.click(within(dialog).getByRole("button", { name: "No" }));
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
    }));
    it("invokes onCancel when Escape is pressed", () => __awaiter(void 0, void 0, void 0, function* () {
        const user = userEvent.setup();
        const { onCancel, onConfirm } = renderDialog();
        yield user.keyboard("{Escape}");
        yield waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
        expect(onConfirm).not.toHaveBeenCalled();
    }));
    it("applies the destructive variant to confirm when danger=true", () => {
        renderDialog({ danger: true, confirmText: "Delete" });
        const dialog = getDialog();
        const confirm = within(dialog).getByRole("button", { name: "Delete" });
        // The Button primitive applies the `bg-destructive` utility class for
        // the destructive variant. This is the externally observable signal
        // that `danger` was wired through correctly.
        expect(confirm.className).toContain("bg-destructive");
    });
    it("uses the default (non-destructive) variant when danger is omitted", () => {
        renderDialog({ confirmText: "OK" });
        const dialog = getDialog();
        const confirm = within(dialog).getByRole("button", { name: "OK" });
        expect(confirm.className).not.toContain("bg-destructive");
        expect(confirm.className).toContain("bg-primary");
    });
    it("sets aria-label on both action buttons for assistive tech", () => {
        renderDialog({ confirmText: "Proceed", cancelText: "Abort" });
        const dialog = getDialog();
        expect(within(dialog).getByRole("button", { name: "Proceed" })).toHaveAttribute("aria-label", "Proceed");
        expect(within(dialog).getByRole("button", { name: "Abort" })).toHaveAttribute("aria-label", "Abort");
    });
    it("moves focus inside the dialog after opening (focus trap)", () => __awaiter(void 0, void 0, void 0, function* () {
        renderDialog();
        const dialog = getDialog();
        // Radix moves focus into the dialog asynchronously after mount.
        yield waitFor(() => {
            const active = document.activeElement;
            expect(active).not.toBeNull();
            expect(dialog.contains(active)).toBe(true);
        });
    }));
    describe("loading state", () => {
        it("disables both buttons and shows the processing label", () => {
            renderDialog({ loading: true, confirmText: "Save" });
            const dialog = getDialog();
            const confirm = within(dialog).getByRole("button", {
                name: "Save",
            });
            const cancel = within(dialog).getByRole("button", {
                name: "Cancel",
            });
            expect(confirm).toBeDisabled();
            expect(cancel).toBeDisabled();
            expect(confirm).toHaveTextContent(/processing/i);
        });
        it("does not invoke onCancel when Escape is pressed while loading", () => __awaiter(void 0, void 0, void 0, function* () {
            const user = userEvent.setup();
            const { onCancel } = renderDialog({ loading: true });
            yield user.keyboard("{Escape}");
            // Give Radix a tick to potentially fire onOpenChange; it should not.
            yield new Promise((resolve) => setTimeout(resolve, 20));
            expect(onCancel).not.toHaveBeenCalled();
        }));
    });
});
//# sourceMappingURL=confirmation-dialog.test.js.map