import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// @ts-expect-error: plain JavaScript tooling, shared with the QuickJS run and the goldens runner
import { fixtureSources } from "../corpus/fixtures.mjs"
import { emitBody, type BodyTarget } from "./emit/hlsl-body"
import { parse } from "./index"
import { BUILTINS } from "./lang"
import { LIB_HLSL } from "./lib/hlsl"
import { SL_SDF_PARAMS } from "./shapes"

/**
 * The shared subset really is shared: it compiles as Metal.
 *
 * HLSL forgives what Metal refuses (a scalar swizzled into a vector,
 * `max(float2, float)`, an int literal where overloads could take a float or a
 * half), so a body that Unity compiles can still fail in a host's Metal
 * kernel. This compiles, with Apple's own compiler, the whole library and a
 * body for every corpus program and every builtin at every width the language
 * accepts, behind the two defines a host's compatibility header supplies.
 * Only on a Mac with Xcode's `metal`; elsewhere it skips and says so.
 */

const hasMetal = process.platform === "darwin" &&
    spawnSync("xcrun", ["-sdk", "macosx", "-f", "metal"], { encoding: "utf8" }).status === 0

const PRELUDE = `#include <metal_stdlib>
using namespace metal;
// A host's compatibility defines: the only HLSL names the subset uses that
// Metal spells differently.
#define frac fract
#define lerp mix
#define SL_U(i) u[i]
#define SL_SAMPLE(slot, uv) tex.sample(smp, uv)
`

const TARGET: BodyTarget = {
    inputs: { uv: "SL_UV", fragCoord: "SL_FRAGCOORD", resolution: "SL_RES", time: "SL_TIME", aspect: "SL_ASPECT" },
    uniform: (slot) => `SL_U(${slot})`,
    sample: (slot, uv) => `SL_SAMPLE(${slot}, ${uv})`,
    colour: "linear",
    result: "c",
}

/** Every value builtin at every width the language takes, alone and with scalars beside a vector. */
function builtinPrograms(): Record<string, string> {
    const out: Record<string, string> = {}
    const value: Record<number, string> = { 1: "uv.x", 2: "uv", 3: "float3(uv, time)", 4: "float4(uv, time, aspect)" }
    const type: Record<number, string> = { 1: "float", 2: "float2", 3: "float3", 4: "float4" }
    // The call's result as a float4, whatever its width: the first that parses.
    const wrappings = (call: string) => [`float4(${call}, 0, 0, 1)`, `float4(${call}, 0, 1)`, `float4(${call}, 1)`, call]
    for (const [name, b] of Object.entries(BUILTINS)) {
        if (b.kind !== "value") continue
        const octaves = name === "fbm" || name === "turbulence" || name === "ridged"
        for (let w = 1; w <= 4; w++) {
            for (let n = b.min; n <= b.max; n++) {
                // All arguments at width w, then the first at w and the rest scalar.
                for (const mixed of n > 1 && w > 1 && !octaves ? [false, true] : [false]) {
                    const args = Array.from({ length: n }, (_, i) => (i > 0 && (mixed || octaves) ? (octaves ? "3" : "0.5") : value[w]))
                    for (const result of wrappings(`${name}(${args.join(", ")})`)) {
                        const source = `float4 main() {\n    return ${result};\n}`
                        try {
                            parse(source, { file: `${name}.sl` })
                            out[`${name} ${type[w]}${mixed ? " with scalars" : ""} x${n}`] = source
                            break
                        } catch { /* not this width, or not this wrapping */ }
                    }
                }
            }
        }
    }
    return out
}

function compile(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "onejs-sl-metal-"))
    try {
        writeFileSync(join(dir, "check.metal"), source)
        const r = spawnSync("xcrun", ["-sdk", "macosx", "metal", "-c", join(dir, "check.metal"), "-o", join(dir, "check.air")], { encoding: "utf8" })
        return r.status === 0 ? "" : r.stderr
    } finally {
        if (process.env.SL_METAL_KEEP) writeFileSync(process.env.SL_METAL_KEEP, source)
        rmSync(dir, { recursive: true, force: true })
    }
}

describe.skipIf(!hasMetal)("the shared subset, compiled as Metal", () => {
    const corpus: Record<string, string> = fixtureSources(SL_SDF_PARAMS)
    const builtins = builtinPrograms()

    it("covers every builtin at some width", () => {
        const covered = new Set(Object.keys(builtins).map((k) => k.split(" ")[0]))
        const values = Object.entries(BUILTINS).filter(([, b]) => b.kind === "value").map(([n]) => n)
        expect(values.filter((n) => !covered.has(n))).toEqual([])
    })

    for (const colour of ["linear", "gamma"] as const) {
        it(`compiles the library and every body, ${colour}`, () => {
            const library = LIB_HLSL.map((t) => (typeof t === "string" ? t : t[colour]).trim()).join("\n")
            const bodies = Object.entries({ ...corpus, ...builtins }).map(([name, source], i) => {
                const body = emitBody(parse(source, { file: name }), { ...TARGET, colour }).body
                return `// ${name}\nfloat4 program${i}(float2 SL_UV, float2 SL_FRAGCOORD, float2 SL_RES, float SL_TIME, float SL_ASPECT, ` +
                    `constant float4* u, texture2d<float> tex, sampler smp) {\n    float4 c;\n${body}\n    return c;\n}`
            })
            const errors = compile(`${PRELUDE}\n${library}\n\n${bodies.join("\n\n")}\n`)
            expect(errors.split("\n").filter((l) => l.includes("error:")).slice(0, 12).join("\n")).toBe("")
        })
    }
})
