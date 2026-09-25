import { describe, it, expect } from "vitest"
import { sl } from "./index"
import { encode } from "./encode"

/**
 * Realistic programs, encoded, with their register pressure reported.
 *
 * This exists because eight registers is a hard refusal, not a soft cost: a
 * program that needs a ninth is rejected rather than spilled. So "does a real
 * program fit" has to be a standing check and not a thing anybody assumes.
 *
 * It has already earned its place. The textured grade case failed the first time
 * it ran, with "vec4 needs 4 components, got 7", because luminance was declared
 * through the width preserving unary helper and returned a Vec4. None of the
 * unit tests caught it; a program that looked like something somebody would
 * write did.
 */
describe("register pressure on realistic programs", () => {
    const report = (name: string, p: any) => {
        const e = encode(p)
        console.log(`  ${name.padEnd(24)} ${String(e.instructions).padStart(3)} instr, peak ${e.registersUsed}/8 regs`)
        return e
    }
    it("the spec's own plasma example", () => {
        const p = sl.program(({ uv, time }) => {
            const q = uv.mul(8).add(time.mul(0.4))
            const v = sl.sin(q.x).add(sl.sin(q.y)).add(sl.sin(q.x.add(q.y).mul(0.7)))
            const c = v.mul(0.25).add(0.5)
            return sl.vec4(c, c.mul(0.6), c.mul(0.3).add(0.2), 1)
        })
        const e = report("plasma", p)
        expect(e.registersUsed).toBeLessThanOrEqual(8)
    })
    it("fbm via repeat, 4 octaves", () => {
        const p = sl.program(({ uv, time }) => {
            const v = sl.repeat(4, (i, acc) => acc.add(sl.noise(uv.mul(2 ** i).add(time)).mul(0.5 ** i)), sl.float(0))
            return sl.vec4(v, v, v, 1)
        })
        const e = report("fbm x4", p)
        expect(e.registersUsed).toBeLessThanOrEqual(8)
    })
    it("a radial glow with uniforms", () => {
        const p = sl.program(({ uv }) => {
            const intensity = sl.uniform.float("intensity", 1)
            const tint = sl.uniform.vec4("tint", [1, 0.4, 0.1, 1])
            const d = uv.sub(0.5).length()
            const g = sl.smoothstep(0.5, 0.0, d).mul(intensity)
            return tint.mul(g) as any
        })
        const e = report("radial glow", p)
        expect(e.registersUsed).toBeLessThanOrEqual(8)
    })
    it("a textured, graded sample", () => {
        const p = sl.program(({ uv, time }) => {
            const t = sl.texture("art")
            const c = t.sample(uv.add(sl.vec2(sl.sin(time).mul(0.01), 0)))
            const lum = sl.luminance(c)
            return sl.vec4(sl.mix(lum, c.x, 0.5), c.y, c.z, c.w) as any
        })
        const e = report("textured grade", p)
        expect(e.registersUsed).toBeLessThanOrEqual(8)
    })
})
