/**
 * The fixtures as the goldens page draws them: each program's WGSL and GLSL ES
 * from the package's own emitters, and its uniform defaults. Bundled and run in
 * Node by `run.mjs`; the page never sees a compiler.
 */
import { parse, sl, SL_IR_VERSION } from "../src/index"
import { emitGLSL, emitWGSL } from "../src/emit/web"
import { LIB_GLSL } from "../src/lib/glsl"
import { LIB_WGSL } from "../src/lib/wgsl"
import { LIB_FILES } from "../lib/generate"
import { check, parseLibrary, Printer } from "../lib/translate"
import common from "../lib/common.hlsl"
import noise2d from "../lib/noise2d.hlsl"
import sdf2d from "../lib/sdf2d.hlsl"
import probeSource from "./probes.hlsl"

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
    return {
        wgsl: insert(emitWGSL(p), "\n@vertex fn sl_vs(", LIB_WGSL),
        glsl: insert(emitGLSL(p), "\nvoid main() {", LIB_GLSL),
    }
}

function insert(text: string, before: string, lib: readonly string[]): string {
    if (text.split(before).length !== 2) throw new Error(`the web frame no longer has one "${before.trim()}"`)
    return text.replace(before, `\n${lib.map((s) => s.trim()).join("\n")}${before}`)
}

/** Each probe in `probes.hlsl`, by the name goldens.json ships it under, and the function it draws with. */
const PROBES = { hash21: "slProbeHash21", hash22: "slProbeHash22" } as const

/**
 * The hash probes: `probes.hlsl` translated with the library, as a host gets
 * them (the probe functions alone, in each language, the library being the
 * host's own), and as the page draws them (the whole library and the probes in
 * OneJS's web frame, the frame's output replaced by the probe's).
 */
export function probes() {
    const hlsl: Record<string, string> = { "common.hlsl": common, "noise2d.hlsl": noise2d, "sdf2d.hlsl": sdf2d }
    const library = LIB_FILES.flatMap((f) => parseLibrary(hlsl[f.source]!.replace(/\r\n/g, "\n"), `lib/${f.source}`))
    const own = parseLibrary(probeSource.replace(/\r\n/g, "\n"), "goldens/probes.hlsl")
    const c = check([...library, ...own])
    const text = (lang: "hlsl" | "glsl" | "wgsl") => {
        const p = new Printer(c, lang)
        return own.map((fn, i) => p.fn(library.length + i, fn.name)).join("\n")
    }
    const functions = { hlsl: text("hlsl"), glsl: text("glsl"), wgsl: text("wgsl") }
    const frame = parse("float4 main() { return float4(0, 0, 0, 1); }", { file: "probe.sl" })
    // The frame's output, whatever the node is called, exactly once.
    const output = (shader: string, pattern: RegExp, call: string) => {
        const found = shader.match(new RegExp(pattern.source, "g")) ?? []
        if (found.length !== 1) throw new Error(`the web frame has ${found.length} outputs matching ${pattern}, not one`)
        return shader.replace(pattern, call)
    }
    const out: Record<string, unknown> = {}
    for (const [name, entry] of Object.entries(PROBES)) {
        out[name] = {
            entry,
            call: `${entry}(pixel)`,
            ...functions,
            draw: {
                wgsl: output(insert(emitWGSL(frame), "\n@vertex fn sl_vs(", [...LIB_WGSL, functions.wgsl]),
                    /return n\d+;/, `return ${entry}(floor(vec2f(sl_uv.x, 1.0 - sl_uv.y) * sl.res.xy));`),
                glsl: output(insert(emitGLSL(frame), "\nvoid main() {", [...LIB_GLSL, functions.glsl]),
                    /sl_Out = n\d+;/, `sl_Out = ${entry}(floor(vec2(sl_uv.x, 1.0 - sl_uv.y) * sl_Res.xy));`),
            },
        }
    }
    return out
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
