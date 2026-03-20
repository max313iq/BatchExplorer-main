import { Component, EventEmitter, Input, Output } from "@angular/core";
import { AbstractControl, FormBuilder, FormGroup, ValidationErrors, Validators } from "@angular/forms";
import { StartTaskDto } from "app/models/dtos";
import {
    StartTaskApplyRequest,
    StartTaskApplyScope,
    StartTaskApplyTarget,
} from "app/services/workbench/start-task-apply.service";
import "./start-task-editor.scss";

interface StartTaskEditorForm {
    scope: StartTaskApplyScope;
    commandLine: string;
    waitForSuccess: boolean;
    maxTaskRetryCount: number;
    resourceFilesJson: string;
}

@Component({
    selector: "bl-start-task-editor",
    templateUrl: "start-task-editor.html",
})
export class StartTaskEditorComponent {
    @Input() public currentTarget: StartTaskApplyTarget | null = null;
    @Input() public selectedTargets: StartTaskApplyTarget[] = [];
    @Input() public allTargets: StartTaskApplyTarget[] = [];
    @Input() public requireConfirmation = true;

    @Output() public previewRequested = new EventEmitter<StartTaskApplyRequest>();
    @Output() public applyRequested = new EventEmitter<StartTaskApplyRequest>();

    public confirmationPending = false;
    public parsingError = "";

    public form: FormGroup;

    constructor(formBuilder: FormBuilder) {
        this.form = formBuilder.group({
            scope: ["current", Validators.required],
            commandLine: ["", [Validators.required, this._trimmedRequired]],
            waitForSuccess: [true],
            maxTaskRetryCount: [0, [Validators.min(-1), Validators.max(10)]],
            resourceFilesJson: [""],
        });
    }

    public get commandLineInvalid(): boolean {
        const control = this.form.controls.commandLine;
        return control.invalid && (control.touched || control.dirty);
    }

    public get affectedPoolCount(): number {
        return this._resolveTargets(this.form.value.scope).length;
    }

    public preview() {
        if (!this._canSubmit()) {
            return;
        }
        const request = this._buildRequest(true, true);
        if (request) {
            this.previewRequested.emit(request);
        }
    }

    public beginApply() {
        if (!this._canSubmit()) {
            return;
        }
        this.confirmationPending = this.requireConfirmation;
        if (!this.requireConfirmation) {
            this.confirmApply();
        }
    }

    public cancelApply() {
        this.confirmationPending = false;
    }

    public confirmApply() {
        if (!this._canSubmit()) {
            return;
        }
        const request = this._buildRequest(false, true);
        if (request) {
            this.applyRequested.emit(request);
            this.confirmationPending = false;
        }
    }

    private _canSubmit() {
        this.form.markAllAsTouched();
        this.parsingError = "";
        return this.form.valid;
    }

    private _buildRequest(dryRun: boolean, confirmationAccepted: boolean): StartTaskApplyRequest | null {
        const value = this.form.value as StartTaskEditorForm;
        const startTask = this._buildStartTaskModel(value);
        if (!startTask) {
            return null;
        }
        return {
            scope: value.scope,
            startTask,
            currentTarget: this.currentTarget || undefined,
            selectedTargets: this.selectedTargets,
            allTargets: this.allTargets,
            dryRun,
            confirmationAccepted,
        };
    }

    private _buildStartTaskModel(value: StartTaskEditorForm): Partial<StartTaskDto> | null {
        const commandLine = value.commandLine && value.commandLine.trim();
        const startTask: Partial<StartTaskDto> = {
            commandLine,
            waitForSuccess: value.waitForSuccess,
            maxTaskRetryCount: value.maxTaskRetryCount,
        };

        const resourceFilesJson = (value.resourceFilesJson || "").trim();
        if (resourceFilesJson.length > 0) {
            try {
                const resourceFiles = JSON.parse(resourceFilesJson);
                if (!Array.isArray(resourceFiles)) {
                    this.parsingError = "resourceFiles JSON must be an array.";
                    return null;
                }
                startTask.resourceFiles = resourceFiles;
            } catch (error) {
                this.parsingError = "resourceFiles JSON is invalid.";
                return null;
            }
        }

        return startTask;
    }

    private _resolveTargets(scope: StartTaskApplyScope): StartTaskApplyTarget[] {
        if (scope === "current") {
            return this.currentTarget ? [this.currentTarget] : [];
        }
        if (scope === "selected") {
            return this.selectedTargets || [];
        }
        return this.allTargets || [];
    }

    private _trimmedRequired(control: AbstractControl): ValidationErrors | null {
        const value = String(control.value || "");
        return value.trim().length > 0 ? null : { required: true };
    }
}
