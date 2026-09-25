import { describe, it, expect } from "vitest"
import { parse, sl, inputsUsed, toJSON, fromJSON } from "./index"
import { emitBody, type BodyTarget } from "./emit/hlsl-body"
import { emitFragmentBody } from "./emit/unity"
import fs from "node:fs"
import path from "node:path"
import { reachable } from "./ir"
import { SLOP, SL_HLSL, SL_NAME, SL_UNIMPLEMENTED } from "./ops"

/**
 * Magerie's target, as its design (`docs/sl-node-design.md` section 3) spells
 * it: macros its kernel prelude defines, a result local, linear colour. Kept
 * here so an opcode change cannot land without the text Magerie compiles.
 */
const MAGERIE: BodyTarget = {
    inputs: { uv: "SL_UV", fragCoord: "SL_FRAGCOORD", resolution: "SL_RES", time: "SL_TIME", aspect: "SL_ASPECT" },
    uniform: (slot) => `SL_U(${slot})`,
    sample: (slot, uv) => `SL_SAMPLE(${slot}, ${uv})`,
    colour: "linear",
    result: "c",
}
const GAMMA: BodyTarget = { ...MAGERIE, colour: "gamma" }

const everything = parse(`texture2D grain;
uniform float amount = 0.5;
uniform float4 tint = #ff8040;
float4 main() {
    float2 p = (uv - 0.5) * aspect + time * 0.1;
    float n = fbm(p * 3, 4) + simplex(p) * 0.2 + voronoi(p * 4) * 0.1;
    float d = sdf.orientedVesica(p, -0.3, -0.1, 0.3, 0.1, 0.12);
    float3 g = tex2D(grain, fragCoord / resolution).rgb;
    float m = (p.x * 7) % 1.3;
    return float4(tint.rgb * n * amount + g * m, saturate(1 - d));
}`, { file: "everything.sl" })

describe("emitBody for Magerie's target", () => {
    const out = emitBody(everything, MAGERIE)

    it("speaks only the host's names for inputs, uniforms and samples", () => {
        for (const macro of ["SL_UV", "SL_FRAGCOORD", "SL_RES", "SL_TIME", "SL_ASPECT", "SL_U(0)", "SL_U(1)", "SL_SAMPLE(0, "]) {
            expect(out.body).toContain(macro)
        }
        // Nothing of OneJS's Unity frame leaks through.
        for (const unity of ["i.uv", "_Res", "_Secs", "_u_", "_Tex", "tex2D", "fixed4", "return "]) {
            expect(out.body).not.toContain(unity)
        }
    })

    it("swizzles a narrow uniform out of its float4 slot", () => {
        expect(out.body).toMatch(/float n\d+ = SL_U\(0\)\.x;/)
    })

    it("assigns the result to the host's local rather than returning it", () => {
        const last = out.body.split("\n").pop()!
        expect(last).toMatch(/^ {4}c = n\d+;$/)
    })

    it("is in the shared subset: HLSL spelling, no mul, no %, no derivatives", () => {
        expect(out.body).not.toMatch(/\bmul\(|%|\bddx\b|\bddy\b|\bfwidth\b|\bstatic\b/)
        // fmod is the truncating remainder in HLSL and in Metal alike.
        expect(out.body).toContain("fmod(")
        expect(out.body).toMatch(/\bfloat[234]?\b/)
        expect(out.body).not.toMatch(/\bvec[234]\b|\bf32\b/)
    })

    it("says which slots and library functions the body uses", () => {
        expect(out.uses.uniforms).toEqual([0, 1])
        expect(out.uses.textures).toEqual([0])
        expect(out.uses.helpers).toEqual(["sl_fbm", "sl_sdfDistance", "sl_simplex", "sl_toLinear", "sl_voronoi"])
    })

    it("passes a wide shape's fifth and sixth parameters as literals (#129)", () => {
        expect(out.body).toContain("sl_sdfDistance(24, ")
        expect(out.body).toContain("float2(0.12, 0.0)")
    })

    it("reads toLinear as real in linear colour and as the identity in gamma", () => {
        expect(out.body).toContain("sl_toLinear(")
        const gamma = emitBody(everything, GAMMA)
        expect(gamma.body).not.toContain("sl_toLinear")
        expect(gamma.uses.helpers).not.toContain("sl_toLinear")
        // The same number of locals: the conversion becomes a copy, not a gap.
        expect(gamma.body.split("\n").length).toBe(out.body.split("\n").length)
    })

    it("has a case for every opcode, over the whole corpus", () => {
        // The corpus (corpus/*.sl, which the QuickJS run and the goldens use
        // too) plus one shape between them reach every opcode a program can
        // hold, and every one prints for Magerie.
        const dir = path.join(__dirname, "../corpus")
        const programs = fs.readdirSync(dir).filter((f) => f.endsWith(".sl"))
            .map((f) => parse(fs.readFileSync(path.join(dir, f), "utf8"), { file: f }))
        programs.push(parse("float4 main() { return float4(sdf.circle(uv - 0.5, 0.3), 0, 0, 1); }", { file: "circle.sl" }))
        const seen = new Set<number>()
        for (const p of programs) {
            for (const r of reachable(p.nodes, p.result)) {
                const n = p.nodes[r]
                if (n.k === "call") seen.add(n.op)
            }
            expect(() => emitBody(p, MAGERIE)).not.toThrow()
        }
        // Not calls in a graph: node kinds, a builtin that lowers to other ops,
        // and the VM's own encoding of a wide shape.
        const notCalls = new Set<number>([SLOP.CONST, SLOP.INPUT, SLOP.UNIFORM, SLOP.SWIZZLE, SLOP.RAMP, SLOP.SDF_WIDE])
        const missing = Object.keys(SL_HLSL).map(Number)
            .filter((op) => !(op in SL_UNIMPLEMENTED) && !notCalls.has(op) && !seen.has(op))
        expect(missing.map((op) => SL_NAME[op])).toEqual([])
    })

    it("is the body the Unity frame prints, under OneJS's names", () => {
        // One printer: the Unity frame is emitBody with OneJS's target, so the
        // two differ exactly where the targets do.
        const unity = emitFragmentBody(everything)
        const rename = out.body
            .replace(/^ {4}/gm, " ".repeat(16))
            .replace(/SL_SAMPLE\((\d+), /g, "tex2D(_Tex$1, ")
            .replace(/SL_U\(0\)/g, "_u_amount").replace(/SL_U\(1\)/g, "_u_tint")
            .replace(/SL_FRAGCOORD/g, "i.uv * _Res.xy").replace(/SL_UV/g, "i.uv").replace(/SL_RES/g, "_Res.xy")
            .replace(/SL_TIME/g, "_Secs").replace(/SL_ASPECT/g, "(_Res.x / max(_Res.y, 1.0))")
            .replace(/^( +)c = (n\d+);$/m, "$1return $2;")
        expect(unity).toBe(rename)
    })
})

describe("colour uniforms", () => {
    it("marks a hex default as a colour, with its value as written", () => {
        const u = everything.uniforms.find((x) => x.name === "tint")!
        expect(u.colour).toBe(true)
        expect(u.value).toEqual(sl.parseColor("#ff8040"))
        expect(everything.uniforms.find((x) => x.name === "amount")!.colour).toBeUndefined()
    })

    it("marks a float3 colour, dropping the alpha", () => {
        const p = parse("uniform float3 sky = #80c0ff80;\nfloat4 main() { return float4(sky, 1); }", { file: "sky.sl" })
        expect(p.uniforms[0]).toEqual({ name: "sky", type: 3, value: sl.parseColor("#80c0ff80").slice(0, 3), colour: true })
    })

    it("is the same graph, and hash, as the TypeScript form", () => {
        const file = parse("uniform float4 tint = #ff8040;\nfloat4 main() { return tint; }", { file: "t.sl" })
        const ts = sl.program(() => sl.uniform.colour("tint", "#ff8040"))
        expect(ts.hash).toBe(file.hash)
        expect(ts.uniforms).toEqual(file.uniforms)
    })

    it("does not change the hash, since the conversion is already in the graph", () => {
        const marked = sl.program(() => sl.uniform.colour("tint", "#ff8040"))
        const unmarked = sl.program(() => sl.toLinear(sl.uniform.vec4("tint", sl.parseColor("#ff8040"))) as never)
        expect(marked.hash).toBe(unmarked.hash)
        expect(unmarked.uniforms[0]!.colour).toBeUndefined()
    })

    it("survives the JSON round trip", () => {
        expect(fromJSON(JSON.parse(JSON.stringify(toJSON(everything)))).uniforms).toEqual(everything.uniforms)
    })

    it("refuses one name declared both ways", () => {
        expect(() => sl.program(() => {
            const a = sl.uniform.colour("tint", "#fff")
            const b = sl.uniform.vec4("tint")
            return a.add(b) as never
        })).toThrow(/both as a colour and as plain numbers/)
    })
})

describe("inputsUsed", () => {
    it("lists what the result reads, in INPUTS order", () => {
        expect(inputsUsed(everything)).toEqual(["uv", "fragCoord", "resolution", "time", "aspect"])
        expect(inputsUsed(parse("float4 main() { return float4(uv, 0, 1); }", { file: "a.sl" }))).toEqual(["uv"])
    })

    it("ignores a value computed from time and never used", () => {
        const p = sl.program(({ uv, time }) => {
            sl.sin(time)
            return sl.vec4(uv, 0, 1)
        })
        expect(p.nodes.some((n) => n.k === "input" && n.name === "time")).toBe(true)
        expect(inputsUsed(p)).toEqual(["uv"])
    })
})
