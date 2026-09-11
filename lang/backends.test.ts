import { describe, expect, it } from "vitest"
import { encode } from "../encode"
import { emitShader } from "../hlsl"
import { manifest } from "../manifest"
import { parse } from "./index"

/**
 * A parsed program is a program: both backends take it without being told.
 *
 * The parity test already proves the graphs match an EDSL twin, which is the
 * stronger claim. This is the cheap end to end check that nothing in the way a
 * `.sl` file reaches the IR trips the encoder or the emitter, because those are
 * the two things Phase B will hand a file to.
 */

const SOURCE = `
uniform float warp = 0.5;
uniform float4 tint = #ff8040;
texture2D grain;

float ring(float2 p, float r, float w) {
    return 1 - smoothstep(0, w, abs(length(p) - r));
}

float4 main() {
    float2 p = (uv - 0.5) * float2(aspect, 1);
    float g = tex2D(grain, uv * 4 + time * 0.05).r;
    float a = 0;
    for (int i = 0; i < 3; i++) {
        a = a + ring(p, 0.2 + i * 0.1 + g * 0.02 * warp, 0.01);
    }
    return float4(tint.rgb * a, a);
}
`

describe("both backends take a parsed program", () => {
    const program = parse(SOURCE, { file: "rings.sl" })

    it("encodes inside the VM's budgets", () => {
        const e = encode(program)
        expect(e.instructions).toBeLessThanOrEqual(256)
        expect(e.registersUsed).toBeLessThanOrEqual(8)
        expect(e.uniforms).toEqual(["warp", "tint"])
        expect(e.hash).toBe(program.hash)
    })

    it("emits a shader whose name carries the hash", () => {
        const hlsl = emitShader(program)
        expect(hlsl).toContain(`Shader "Hidden/SLGenerated/${program.hash}"`)
        expect(hlsl).toContain(`_u_warp ("warp", Vector)`)
        expect(hlsl).toContain(`_Tex0 ("grain", 2D)`)
        expect(hlsl).toContain("sl_toLinear")
    })

    it("goes into a manifest like any other program", () => {
        const m = manifest([program])
        expect(m.programs[0]!.hash).toBe(program.hash)
    })
})
