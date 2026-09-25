/**
 * Everything the package does, over a corpus, as one JSON-able value.
 *
 * `run.mjs` bundles this the way Magerie bundles its scripts (one ES2020 IIFE)
 * and runs it in QuickJS-ng and in a bare Node context. The two results have
 * to be byte-identical, so a host API the package reaches for fails here, and
 * so does any arithmetic or number formatting QuickJS does differently.
 */
import { SLError, SLParseError, fromJSON, parse, sl, toJSON, type Program } from "../src/index"
import { BUILTINS } from "../src/tables"
import { vmFit } from "../src/limits"
import { encode } from "../src/vm"
import { emitShader } from "../src/emit/unity"
import { emitGLSL, emitWGSL } from "../src/emit/web"
import { emitBody, emitLibrary, type BodyTarget } from "../src/emit/hlsl-body"
import { inputsUsed } from "../src/core"

/** A host frame's names, as Magerie's kernel spells them. */
const TARGET: BodyTarget = {
    inputs: { uv: "SL_UV", fragCoord: "SL_FRAGCOORD", resolution: "SL_RES", time: "SL_TIME", aspect: "SL_ASPECT" },
    uniform: (slot) => `SL_U(${slot})`,
    sample: (slot, uv) => `SL_SAMPLE(${slot}, ${uv})`,
    colour: "linear",
    result: "c",
}

/** The shapes' parameter counts, so run.mjs can build the corpus from the same table. */
export { SL_SDF_PARAMS } from "../src/core"

type Result = Record<string, unknown>

function describe(p: Program): Result {
    const out: Result = { hash: p.hash, version: p.version, nodes: p.nodes.length }
    const back = fromJSON(JSON.parse(JSON.stringify(toJSON(p))))
    out.roundTrip = back.hash === p.hash
    out.fit = vmFit(p)
    try {
        const e = encode(p)
        out.vm = {
            wire: e.wire, instructions: e.instructions, registers: e.registersUsed,
            result: e.resultRegister, data: Array.from(e.data), defaults: e.defaults,
        }
    } catch (e) {
        out.vm = { refused: String((e as Error).message) }
    }
    out.hlsl = emitShader(p)
    out.wgsl = emitWGSL(p)
    out.glsl = emitGLSL(p)
    const body = emitBody(p, TARGET)
    out.body = body
    out.library = emitLibrary(body.uses.helpers, TARGET.colour)
    out.inputs = inputsUsed(p)
    out.uniforms = p.uniforms
    return out
}

function attempt(make: () => Program): Result {
    try {
        return describe(make())
    } catch (e) {
        if (e instanceof SLParseError) return { error: e.message, line: e.line, column: e.column, length: e.length }
        if (e instanceof SLError) return { error: e.message }
        throw e
    }
}

/** `sources` is `corpus/fixtures.mjs`'s map: the files and one program per shape. */
export function run(sources: Record<string, string>): Result {
    const out: Result = {}
    for (const [name, source] of Object.entries(sources)) {
        out[name] = attempt(() => parse(source, { file: name }))
    }
    out["edsl-fbm-simplex"] = attempt(() => sl.program(({ uv, time }) => {
        const v = sl.fbm(uv.mul(4).add(time.mul(0.1)), 3, "simplex")
        return sl.vec4(v, v.mul(v), sl.float(1).sub(v), 1)
    }))
    out["edsl-repeat"] = attempt(() => sl.program(({ uv }) => {
        const v = sl.repeat(5, (i, acc) => acc.add(sl.sin(uv.x.mul(i + 1))), sl.float(0))
        return sl.vec4(v, v, v, 1)
    }))
    out["error-width"] = attempt(() => parse("float4 main() { return float3(1, 2, 3); }", { file: "width.sl" }))
    out["error-unknown"] = attempt(() => parse("float4 main() {\n    return blur(uv);\n}", { file: "unknown.sl" }))
    out["error-newer-ir"] = (() => {
        try { fromJSON({ v: 999, nodes: [], result: 0 }); return { error: null } } catch (e) { return { error: String((e as Error).message) } }
    })()
    out.builtins = Object.keys(BUILTINS).sort()
    return out
}
