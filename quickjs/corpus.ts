/**
 * Everything the package does, over a corpus, as one JSON-able value.
 *
 * `run.mjs` bundles this the way Magerie bundles its scripts (one ES2020 IIFE)
 * and runs it in QuickJS-ng and in a bare Node context. The two results have
 * to be byte-identical, so a host API the package reaches for fails here, and
 * so does any arithmetic or number formatting QuickJS does differently.
 */
import { SLError, SLParseError, fromJSON, parse, sl, toJSON, SL_SDF_PARAMS, SL_SDF_SHAPES, type Program } from "../src/index"
import { BUILTINS } from "../src/tables"
import { vmFit } from "../src/limits"
import { encode } from "../src/vm"
import { emitShader } from "../src/emit/unity"
import { emitGLSL, emitWGSL } from "../src/emit/web"

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

/** A band pattern over one shape, given every parameter it takes. */
function shapeSource(kind: string, count: number): string {
    const values = [0.3, 0.2, 0.1, 0.05, 0.12, 0.02].slice(0, count)
    return `float4 main() {
    float2 p = (uv - 0.5) * 1.2;
    float d = sdf.${kind}(${["p", ...values.map(String)].join(", ")});
    return float4(0.5 + 0.5 * cos(d * 40.0), saturate(0.5 - d * 2.0), 0, 1);
}`
}

export function run(sources: Record<string, string>): Result {
    const out: Result = {}
    for (const [name, source] of Object.entries(sources)) {
        out[name] = attempt(() => parse(source, { file: name }))
    }
    for (const kind of Object.keys(SL_SDF_SHAPES)) {
        const count = SL_SDF_PARAMS[kind as keyof typeof SL_SDF_PARAMS]
        out[`sdf-${kind}`] = attempt(() => parse(shapeSource(kind, count), { file: `${kind}.sl` }))
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
