import { describe, it, expect } from "vitest"
import { parse, SL_SDF_PARAMS } from "./index"
import { compile } from "./compile"
import { encode } from "./encode"
// @ts-expect-error: plain JavaScript tooling, shared with the QuickJS run and the goldens runner
import { fixtureSources } from "../corpus/fixtures.mjs"

const sources: Record<string, string> = fixtureSources(SL_SDF_PARAMS)
const programs = Object.entries(sources).map(([name, source]) => [name, parse(source, { file: name })] as const)

describe("compile", () => {
    it("gives every program encode can take exactly what encode gave a host, less the buffer", () => {
        let compared = 0
        for (const [name, p] of programs) {
            let e: ReturnType<typeof encode>
            try { e = encode(p) } catch { continue }
            const c = compile(p)
            expect(c.hash, name).toBe(e.hash)
            expect(c.uniforms, name).toEqual(e.uniforms)
            expect(c.defaults, name).toEqual(e.defaults)
            expect(c.textures, name).toEqual(e.textures)
            expect(c.hlsl, name).toBe(e.hlsl)
            expect(c.wgsl, name).toBe(e.wgsl)
            expect(c.glsl, name).toBe(e.glsl)
            compared++
        }
        expect(compared).toBeGreaterThan(50)
    })

    it("carries no VM buffer, and its sources are not enumerable", () => {
        const c = compile(programs[0]![1])
        expect(Object.keys(c).sort()).toEqual(["defaults", "hash", "textures", "uniforms"])
        expect(typeof c.hlsl).toBe("string")
    })

    /**
     * No budget. These two are why: `long.sl` is over a thousand operations and
     * `probe-hash.sl` holds more than 8 values at once, and the VM refused
     * both. Every compiled backend draws them, and the goldens hold what they
     * draw.
     */
    it("takes a program past the VM's instructions and past its registers", () => {
        for (const name of ["long.sl", "probe-hash.sl"]) {
            const p = programs.find(([n]) => n === name)![1]
            expect(() => encode(p), name).toThrow(/VM/)
            const c = compile(p)
            expect(c.hash, name).toBe(p.hash)
            for (const text of [c.hlsl, c.wgsl, c.glsl]) expect(text.length, name).toBeGreaterThan(0)
        }
    })
})

describe("compile holds a program to the caps", () => {
    // Every program passes through compile on its way to a host, however it
    // was made, so this is the check nothing can go around.
    const base = parse("texture2D t0;\nuniform float u0 = 0;\nfloat4 main() { return tex2D(t0, uv) * u0; }")

    it("refuses a fifth texture", () => {
        const textures = Array.from({ length: 5 }, (_, i) => ({ name: "t" + i, slot: i }))
        expect(() => compile({ ...base, textures })).toThrow(/this program declares 5 textures and a program may sample 4\./)
    })

    it("refuses a seventeenth uniform", () => {
        const uniforms = Array.from({ length: 17 }, (_, i) => ({ name: "u" + i, type: 1 as const, value: [0] }))
        expect(() => compile({ ...base, uniforms })).toThrow(/this program declares 17 uniforms and a program may hold 16\./)
    })

    it("takes a program at both caps", () => {
        const textures = Array.from({ length: 4 }, (_, i) => ({ name: "t" + i, slot: i }))
        const uniforms = Array.from({ length: 16 }, (_, i) => ({ name: "u" + i, type: 1 as const, value: [0] }))
        expect(compile({ ...base, textures, uniforms }).textures).toHaveLength(4)
    })
})
