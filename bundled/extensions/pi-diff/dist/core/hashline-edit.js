import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { applyHashlineEdits } from "../hashline.js";
import { finalizeHashlineWriteContent, prepareTextForHashlineEdit } from "./text-encoding.js";
async function atomicWriteFile(filePath, content, mode) {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.pi-hashline.${process.pid}.${randomUUID()}.tmp`);
    await fs.promises.writeFile(tmp, content, { encoding: "utf8", mode });
    await fs.promises.chmod(tmp, mode & 0o7777);
    try {
        await fs.promises.rename(tmp, filePath);
    }
    catch (error) {
        await fs.promises.rm(tmp, { force: true }).catch(() => { });
        throw error;
    }
}
export async function applyHashlineEditsToFile(filePath, changes, options) {
    const dryRun = options?.dryRun === true;
    let raw;
    let mode = 0o666;
    try {
        const stats = await fs.promises.lstat(filePath);
        if (stats.isSymbolicLink()) {
            return { ok: false, error: `[E_READ_FAILED] refusing to edit symbolic link ${filePath}`, code: "E_READ_FAILED" };
        }
        if (!stats.isFile()) {
            return { ok: false, error: `[E_READ_FAILED] not a regular file ${filePath}`, code: "E_READ_FAILED" };
        }
        mode = stats.mode;
    }
    catch (err) {
        if (options?.rawUtf8 === undefined) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `[E_READ_FAILED] cannot stat ${filePath}: ${msg}`, code: "E_READ_FAILED" };
        }
    }
    if (options?.rawUtf8 !== undefined) {
        raw = options.rawUtf8;
    }
    else {
        try {
            raw = await fs.promises.readFile(filePath, "utf8");
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `[E_READ_FAILED] cannot read ${filePath}: ${msg}`, code: "E_READ_FAILED" };
        }
    }
    const { bom, ending, normalized } = prepareTextForHashlineEdit(raw);
    const hasCrlf = /\r\n/.test(raw);
    const hasBareLf = /(^|[^\r])\n/.test(raw);
    const hasBareCr = /\r(?!\n)/.test(raw);
    if ((hasCrlf && hasBareLf) || hasBareCr) {
        return {
            ok: false,
            error: `[E_MIXED_EOL] refusing to rewrite mixed line endings in ${filePath}`,
            code: "E_MIXED_EOL",
        };
    }
    const result = applyHashlineEdits(normalized, changes, filePath);
    if (!result.ok)
        return result;
    const finalRaw = finalizeHashlineWriteContent(bom, ending, result.newContent);
    if (!dryRun) {
        try {
            if (options?.rawUtf8 !== undefined) {
                const latest = await fs.promises.readFile(filePath, "utf8");
                if (latest !== raw) {
                    return {
                        ok: false,
                        error: `[E_STALE_FILE] ${filePath} changed while the edit was being prepared; reread before retrying`,
                        code: "E_STALE_FILE",
                    };
                }
            }
            await atomicWriteFile(filePath, finalRaw, mode);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `[E_WRITE_FAILED] cannot write ${filePath}: ${msg}`, code: "E_WRITE_FAILED" };
        }
    }
    return { ...result, newContent: result.newContent, finalRaw };
}
//# sourceMappingURL=hashline-edit.js.map