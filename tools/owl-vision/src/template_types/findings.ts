import * as path from "path";

// What a template type checker prints (Odoo's
// `node tooling/typing/template_types.mjs --json`): each finding of tsc in a
// template's type shadow, placed at the attribute it comes from. Lines and
// columns count from 1; the end is exclusive.
export interface Finding {
    file?: string | null;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    code: string;
    message: string;
    template?: string;
    component?: string;
}

export interface Report {
    findings: Finding[];
}

// A finding as an editor places it: lines and columns from 0.
export interface PlacedFinding {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    code: string;
    message: string;
}

export function parseReport(stdout: string): Report {
    const report = JSON.parse(stdout);
    if (!Array.isArray(report?.findings)) {
        throw new Error("the checker's output has no findings array");
    }
    return report;
}

// The findings by absolute file; a relative one is read from the checker's
// working directory. One without a place is counted, not shown.
export function placeFindings(
    report: Report,
    cwd: string,
): { byFile: Map<string, PlacedFinding[]>; unplaced: number } {
    const byFile = new Map<string, PlacedFinding[]>();
    let unplaced = 0;
    for (const finding of report.findings) {
        if (!finding.file || !finding.line || !finding.column) {
            unplaced++;
            continue;
        }
        const file = path.resolve(cwd, finding.file);
        const about = [finding.template, finding.component].filter(Boolean).join(", ");
        const placed: PlacedFinding = {
            startLine: finding.line - 1,
            startColumn: finding.column - 1,
            endLine: (finding.endLine ?? finding.line) - 1,
            endColumn: (finding.endColumn ?? finding.column) - 1,
            code: finding.code,
            message: about ? `${finding.message} (${about})` : finding.message,
        };
        byFile.set(file, [...(byFile.get(file) || []), placed]);
    }
    return { byFile, unplaced };
}
