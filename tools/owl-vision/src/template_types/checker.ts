import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { parseReport, placeFindings, Report } from "./findings";

const SEVERITIES: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint,
};

// Runs the configured template type checker and shows its findings where
// they are written. A run started while another is going replaces it.
export class TemplateTypeChecker implements vscode.Disposable {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection("owl-templates");
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    private readonly output = vscode.window.createOutputChannel("Owl Vision: template types");
    private running: ChildProcess | undefined;
    private timer: NodeJS.Timeout | undefined;

    constructor() {
        this.status.command = "owl-vision.check-templates";
    }

    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(), 500);
    }

    run() {
        const config = vscode.workspace.getConfiguration("owl-vision.templateTypes");
        const command = config.get<string[]>("command", []);
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!command.length || !folder) {
            this.diagnostics.clear();
            this.status.hide();
            return;
        }
        const cwd = path.resolve(folder.uri.fsPath, config.get<string>("cwd", "."));
        const severity = SEVERITIES[config.get<string>("severity", "warning")];
        this.stop();
        this.status.text = "$(sync~spin) Owl templates";
        this.status.tooltip = `${command.join(" ")} in ${cwd}`;
        this.status.show();
        const started = Date.now();
        const child = spawn(command[0], command.slice(1), {
            cwd,
            detached: process.platform !== "win32",
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", (error) => {
            if (this.running === child) {
                this.running = undefined;
                this.fail(`${command.join(" ")} in ${cwd}: ${error.message}`);
            }
        });
        child.on("close", (code) => {
            if (this.running !== child) {
                return;
            }
            this.running = undefined;
            let report;
            try {
                report = parseReport(Buffer.concat(stdout).toString());
            } catch (parseError) {
                this.fail(
                    `${command.join(" ")} in ${cwd} exited ${code}: ${parseError}\n` +
                        Buffer.concat(stderr).toString(),
                );
                return;
            }
            this.show(report, cwd, severity, started);
        });
        this.running = child;
    }

    private fail(message: string) {
        this.output.appendLine(message);
        this.status.text = "$(error) Owl templates";
        this.status.tooltip = "The checker failed: see the output channel. Click to run it again.";
    }

    private show(report: Report, cwd: string, severity: vscode.DiagnosticSeverity, started: number) {
        const { byFile, unplaced } = placeFindings(report, cwd);
        this.diagnostics.clear();
        for (const [file, findings] of byFile) {
            this.diagnostics.set(
                vscode.Uri.file(file),
                findings.map((finding) => {
                    const diagnostic = new vscode.Diagnostic(
                        new vscode.Range(
                            finding.startLine,
                            finding.startColumn,
                            finding.endLine,
                            finding.endColumn,
                        ),
                        finding.message,
                        severity,
                    );
                    diagnostic.code = finding.code;
                    diagnostic.source = "owl templates";
                    return diagnostic;
                }),
            );
        }
        const count = report.findings.length;
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        this.status.text = `$(${count ? "warning" : "check"}) Owl templates: ${count}`;
        this.status.tooltip =
            `${count} finding(s), ${unplaced} without a place, in ${seconds} s. ` +
            "Click to check again.";
    }

    // A checker runs tsc in a child of its own, which outlives it when only
    // the checker is killed: on POSIX the checker leads a process group, and
    // the group goes.
    private stop() {
        const child = this.running;
        this.running = undefined;
        if (!child?.pid || child.exitCode !== null) {
            return;
        }
        if (process.platform === "win32") {
            child.kill();
        } else {
            process.kill(-child.pid, "SIGTERM");
        }
    }

    dispose() {
        clearTimeout(this.timer);
        this.stop();
        this.diagnostics.dispose();
        this.status.dispose();
        this.output.dispose();
    }
}
