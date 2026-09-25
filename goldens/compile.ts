/**
 * The fixtures as the goldens page draws them: each program's WGSL and GLSL ES
 * from the package's own emitters, and its uniform defaults. Bundled and run in
 * Node by `run.mjs`; the page never sees a compiler.
 */
import { parse, sl, SL_IR_VERSION } from "../src/index"
import { emitGLSL, emitWGSL } from "../src/emit/web"

export { SL_SDF_PARAMS } from "../src/core"
export { SL_IR_VERSION }

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
