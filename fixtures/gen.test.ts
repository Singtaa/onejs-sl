import { describe, it, expect } from "vitest"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { sl } from "../index"
import { encode } from "../encode"

/**
 * Emits the fixtures the Unity side renders and checks.
 *
 * The expected colours here are worked out ANALYTICALLY, not by running a
 * reference evaluator. That matters: a reference implementation shares its
 * author's misunderstandings with the thing it is checking, so if I had both
 * encoded and evaluated the graph, a wrong opcode number would agree with
 * itself and the test would pass. `uv.x + 0.25` at the centre of a pixel is
 * 0.75 because of arithmetic, not because of anything in this repository.
 *
 * The buffers, though, come from the real encoder. Hand writing them in the
 * C# test would check the VM against my idea of the encoding rather than
 * against the encoding.
 */

const OUT = resolve(__dirname, "../../../../../Assets/OneJSContainer/Tests/Editor/sl-fixtures.json")

interface Fixture {
    name: string
    note: string
    data: number[]
    instructions: number
    resultRegister: number
    /** Flat float4 per uniform slot, so the host can seed declared defaults. */
    uniforms: number[]
    /** Expected colour at uv = (0.5, 0.5), the centre of a 1x1 render. */
    expected: [number, number, number, number]
}

describe("sl GPU fixtures", () => {
    it("writes fixtures with analytically known answers", () => {
        const fx: Fixture[] = []
        const add = (name: string, note: string, p: any, expected: [number, number, number, number]) => {
            const e = encode(p)
            fx.push({
                name, note, data: [...e.data], instructions: e.instructions,
                resultRegister: e.resultRegister, uniforms: sl.uniformDefaults(p), expected,
            })
        }

        // uv at the centre of a single pixel target is (0.5, 0.5).
        add("uv passthrough", "vec4(uv, 0, 1) at the pixel centre is (0.5, 0.5, 0, 1)",
            sl.program(({ uv }) => sl.vec4(uv, 0, 1)), [0.5, 0.5, 0, 1])

        add("constant", "every channel is the literal it was given",
            sl.program(() => sl.vec4(0.25, 0.5, 0.75, 1)), [0.25, 0.5, 0.75, 1])

        add("add a constant", "0.5 + 0.25 is 0.75",
            sl.program(({ uv }) => sl.vec4(uv.x.add(0.25), 0, 0, 1)), [0.75, 0, 0, 1])

        add("multiply", "0.5 * 1.5 is 0.75",
            sl.program(({ uv }) => sl.vec4(uv.x.mul(1.5), 0, 0, 1)), [0.75, 0, 0, 1])

        add("swizzle reverses", "vec4(1,2,3,4).wzyx is (4,3,2,1), scaled to stay in range",
            sl.program(() => sl.vec4(0.1, 0.2, 0.3, 0.4).swz("wzyx")), [0.4, 0.3, 0.2, 0.1])

        add("sin", "sin(0) is 0, and 0.5 - 0.5 is 0",
            sl.program(({ uv }) => sl.vec4(sl.sin(uv.x.sub(0.5)), 0, 0, 1)), [0, 0, 0, 1])

        // length((0.5,0.5)) = sqrt(0.5) = 0.7071..., which is also the check that
        // operand width reaches the VM: length of four components would be
        // sqrt(0.5) too if z and w were zero, so the vec2 case is made distinct
        // by using a value whose extra channels are NOT zero.
        add("length of a vec2", "length((0.5, 0.5)) is sqrt(0.5)",
            sl.program(({ uv }) => sl.vec4(uv.length(), 0, 0, 1)), [Math.SQRT1_2, 0, 0, 1])

        add("length is not fooled by the other channels",
            "length of the vec2 (0.5,0.5) stays sqrt(0.5) even though the register also holds 3 and 4",
            sl.program(() => {
                const wide = sl.vec4(0.5, 0.5, 3, 4)
                return sl.vec4(wide.xy.length(), 0, 0, 1)
            }), [Math.SQRT1_2, 0, 0, 1])

        add("mix", "mix(0, 1, 0.5) is 0.5",
            sl.program(({ uv }) => sl.vec4(sl.mix(0, 1, uv.x), 0, 0, 1)), [0.5, 0, 0, 1])

        add("saturate clamps", "saturate(2) is 1 and saturate(-1) is 0",
            sl.program(() => sl.vec4(sl.float(2).saturate(), sl.float(-1).saturate(), 0, 1)), [1, 0, 0, 1])

        add("uniform default", "an unset uniform reads its declared default",
            sl.program(() => sl.vec4(sl.uniform.float("k", 0.375), 0, 0, 1)), [0.375, 0, 0, 1])

        add("ramp midpoint", "halfway along a black to white ramp is 0.5 grey",
            sl.program(({ uv }) => sl.ramp(uv.x, ["#000000", "#ffffff"])), [0.5, 0.5, 0.5, 1])

        mkdirSync(dirname(OUT), { recursive: true })
        writeFileSync(OUT, JSON.stringify({ generatedBy: "onejs-unity/src/sl/fixtures/gen.test.ts", fixtures: fx }, null, 1))
        expect(fx.length).toBeGreaterThan(10)
        // Every fixture must be inside the register file, or the GPU side will
        // reject it for a reason that has nothing to do with what it tests.
        for (const f of fx) expect(f.resultRegister).toBeLessThan(8)
    })
})
