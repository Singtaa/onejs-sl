import { describe, it, expect } from "vitest"
import { sl } from "./index"
import { encode } from "./vm"
import { vmFit, REGISTERS, MAX_INSTRUCTIONS } from "./limits"

/** Sixteen values live at once, which no eight register file holds. */
const wide = () => sl.program(({ uv }) => {
    const live = []
    for (let i = 0; i < 16; i++) live.push(sl.sin(uv.x.add(i)))
    let sum = live[0]!
    for (let i = 1; i < live.length; i++) sum = sum.add(live[i]!)
    return sl.vec4(sum, sum, sum, 1)
})

const long = () => sl.program(({ uv }) => {
    let v = uv.x
    for (let i = 0; i < 300; i++) v = v.add(i)
    return sl.vec4(v, v, v, 1)
})

const refusal = (make: () => void): string => {
    try { make() } catch (e) { return (e as Error).message }
    throw new Error("encode did not refuse it")
}

describe("vmFit", () => {
    it("agrees with the encoder on a program that fits", () => {
        const p = sl.program(({ uv, time }) => {
            const v = sl.fbm(uv.mul(3).add(time), 4)
            return sl.vec4(v, v.mul(0.5), 1, 1)
        })
        const e = encode(p)
        expect(vmFit(p)).toEqual({ fits: true, instructions: e.instructions, registers: e.registersUsed, wire: 1 })
    })

    it("refuses what encode refuses, in encode's words", () => {
        const fit = vmFit(wide())
        expect(fit.fits).toBe(false)
        expect(fit.registers).toBeUndefined()
        expect(fit.reason).toBe(refusal(() => encode(wide())))
        expect(fit.reason).toContain(`more than ${REGISTERS} registers`)
    })

    it("still counts a program too long to run, and names the length", () => {
        const fit = vmFit(long())
        expect(fit.fits).toBe(false)
        expect(fit.instructions).toBeGreaterThan(MAX_INSTRUCTIONS)
        // Long but narrow, so the register file would have held it.
        expect(fit.registers).toBeLessThanOrEqual(REGISTERS)
        expect(fit.reason).toBe(refusal(() => encode(long())))
    })

    it("counts the constant a wide shape needs, and says it needs wire 2", () => {
        const p = sl.program(({ uv }) => {
            const d = sl.sdf("orientedVesica", uv.sub(0.5), [-0.3, -0.1, 0.3, 0.1, 0.12])
            return sl.vec4(d, d, d, 1)
        })
        const e = encode(p)
        expect(vmFit(p)).toEqual({ fits: true, instructions: e.instructions, registers: e.registersUsed, wire: 2 })
    })
})
