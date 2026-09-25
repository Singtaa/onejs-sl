/**
 * The fixtures as the goldens page draws them: each program's WGSL and GLSL ES
 * from the package's own emitters, and its uniform defaults. Bundled and run in
 * Node by `run.mjs`; the page never sees a compiler.
 */
import { parse, sl, SL_IR_VERSION } from "../src/index"
import { emitGLSL, emitWGSL } from "../src/emit/web"
import { LIB_GLSL } from "../src/lib/glsl"
import { LIB_WGSL } from "../src/lib/wgsl"

export { SL_SDF_PARAMS } from "../src/core"
export { SL_IR_VERSION }

/**
 * The whole translated library in OneJS's web frame, once per language.
 *
 * A program carries only the functions it calls, so the fixtures compile
 * whatever the corpus reaches and nothing else: `sl_sdfDistance` and
 * `onejsFbmKind`, which the web never calls, would otherwise ship translated
 * and never compiled. These do not draw anything; `run.mjs` only compiles them.
 */
export function wholeLibrary(): { wgsl: string; glsl: string } {
    const p = parse("float4 main() { return float4(uv, 0, 1); }", { file: "library.sl" })
    const insert = (text: string, before: string, lib: readonly string[]) => {
        if (text.split(before).length !== 2) throw new Error(`the web frame no longer has one "${before.trim()}"`)
        return text.replace(before, `\n${lib.map((s) => s.trim()).join("\n")}${before}`)
    }
    return {
        wgsl: insert(emitWGSL(p), "\n@vertex fn sl_vs(", LIB_WGSL),
        glsl: insert(emitGLSL(p), "\nvoid main() {", LIB_GLSL),
    }
}

export function compile(sources: Record<string, string>) {
    const out: Record<string, unknown> = {}
    for (const [name, source] of Object.entries(sources)) {
        const p = parse(source, { file: name })
        out[name] = {
            hash: p.hash,
            source,
            uniforms: p.uniforms,
            textures: p.textures.map((t) => t.slot),
            // Four floats per slot, as a host seeds them before a caller's own.
            defaults: sl.uniformDefaults(p),
            wgsl: emitWGSL(p),
            glsl: emitGLSL(p),
        }
    }
    return out
}
