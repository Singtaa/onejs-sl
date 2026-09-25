import { describe, expect, it } from "vitest"
import { encode } from "../encode"
import { emitShader } from "../hlsl"
import * as sl from "../sl"
import type { Program } from "../ir"
import { parse } from "./index"

/**
 * THE TEST THIS PHASE EXISTS FOR.
 *
 * `Specs/SL_TEXT.md` section 4: for every fixture the GPU side renders and for
 * the examples on the site, a `.sl` version whose HASH EQUALS the EDSL
 * version's. Same graph, same hash, same generated shader, same pixels, without
 * rendering anything.
 *
 * The hash is a Merkle hash over the graph reachable from the result, so this
 * is a much stronger claim than "both compile". Two programs agreeing on it
 * agree on every node, every operand order, every constant to nine digits and
 * every uniform slot. And because the claim is about the IR, the existing GPU
 * fixtures, the codegen goldens and the C# VM tests all cover the text form for
 * free: they run on what comes out of here.
 *
 * When one of these fails, the lowering has quietly picked a different graph
 * for the same source. `sameShape` prints both instruction counts and both
 * shaders, because "the hashes differ" on its own says nothing about where.
 */

function pair(name: string, source: string, build: () => Program): void {
    it(name, () => {
        const text = parse(source, { file: `${name}.sl` })
        const edsl = build()
        if (text.hash !== edsl.hash) {
            expect(emitShader(text, { name: "text" })).toBe(emitShader(edsl, { name: "text" }))
        }
        expect(text.hash).toBe(edsl.hash)
        expect(encode(text).instructions).toBe(encode(edsl).instructions)
    })
}

describe("a .sl file and its EDSL twin are the same program", () => {
    // MARK: the GPU fixtures, one for one with fixtures/gen.test.ts

    pair("uv passthrough",
        `float4 main() { return float4(uv, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(uv, 0, 1)))

    pair("constant",
        `float4 main() { return float4(0.25, 0.5, 0.75, 1); }`,
        () => sl.program(() => sl.vec4(0.25, 0.5, 0.75, 1)))

    pair("add a constant",
        `float4 main() { return float4(uv.x + 0.25, 0, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(uv.x.add(0.25), 0, 0, 1)))

    pair("multiply",
        `float4 main() { return float4(uv.x * 1.5, 0, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(uv.x.mul(1.5), 0, 0, 1)))

    pair("swizzle reverses",
        `float4 main() { return float4(0.1, 0.2, 0.3, 0.4).wzyx; }`,
        () => sl.program(() => sl.vec4(0.1, 0.2, 0.3, 0.4).swz("wzyx")))

    pair("sin",
        `float4 main() { return float4(sin(uv.x - 0.5), 0, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(sl.sin(uv.x.sub(0.5)), 0, 0, 1)))

    pair("length of a float2",
        `float4 main() { return float4(length(uv), 0, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(uv.length(), 0, 0, 1)))

    pair("length is not fooled by the other channels", `
        float4 main() {
            float4 wide = float4(0.5, 0.5, 3, 4);
            return float4(length(wide.xy), 0, 0, 1);
        }`,
        () => sl.program(() => {
            const wide = sl.vec4(0.5, 0.5, 3, 4)
            return sl.vec4(wide.xy.length(), 0, 0, 1)
        }))

    pair("lerp",
        `float4 main() { return float4(lerp(0, 1, uv.x), 0, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(sl.mix(0, 1, uv.x), 0, 0, 1)))

    pair("saturate clamps",
        `float4 main() { return float4(saturate(2), saturate(-1), 0, 1); }`,
        () => sl.program(() => sl.vec4(sl.float(2).saturate(), sl.float(-1).saturate(), 0, 1)))

    pair("uniform default", `
        uniform float k = 0.375;
        float4 main() { return float4(k, 0, 0, 1); }`,
        () => sl.program(() => sl.vec4(sl.uniform.float("k", 0.375), 0, 0, 1)))

    pair("sdf circle at its centre", `
        float4 main() {
            float d = sdf.circle(uv - 0.5, 0.25);
            return float4(d, 0, 0, 1);
        }`,
        () => sl.program(({ uv }) => sl.vec4(sl.sdf("circle", uv.sub(0.5), [0.25]), 0, 0, 1)))

    pair("ramp midpoint",
        `float4 main() { return ramp(uv.x, #000000, #ffffff); }`,
        () => sl.program(({ uv }) => sl.ramp(uv.x, ["#000000", "#ffffff"])))

    pair("colour as written",
        `float4 main() { return #ff4705; }`,
        () => sl.program(() => sl.color("#ff4705")))

    // MARK: the example on play.onejs.com

    pair("the tuner's plasma", `
        uniform float warp = 0.5;
        uniform float hue = 0.5;
        uniform float speed = 0.5;

        float4 main() {
            float t = time * (speed * 1.6 + 0.1);
            float2 p = (uv - 0.5) * (warp * 14 + 2);

            float v = sin(p.x + t)
                    + sin(p.y - t * 0.8)
                    + sin((p.x + p.y) * 0.7 + t * 1.3);

            float n = saturate(v * 0.22 + 0.5);
            float3 rgb = hsv2rgb(float3(frac(hue + n * 0.18), 0.75, n * 0.7 + 0.25));
            return float4(rgb, 1);
        }`,
        () => sl.program(({ uv, time }) => {
            const warp = sl.uniform.float("warp", 0.5)
            const hue = sl.uniform.float("hue", 0.5)
            const speed = sl.uniform.float("speed", 0.5)
            const t = time.mul(speed.mul(1.6).add(0.1))
            const p = uv.sub(0.5).mul(warp.mul(14).add(2))
            const v = sl.sin(p.x.add(t))
                .add(sl.sin(p.y.sub(t.mul(0.8))))
                .add(sl.sin(p.x.add(p.y).mul(0.7).add(t.mul(1.3))))
            const n = v.mul(0.22).add(0.5).saturate()
            const rgb = sl.hsv2rgb(sl.vec3(hue.add(n.mul(0.18)).fract(), 0.75, n.mul(0.7).add(0.25)))
            return sl.vec4(rgb, 1)
        }))

    // MARK: the constructs the EDSL spells differently

    pair("a for loop is sl.repeat", `
        float4 main() {
            float v = 0;
            for (int i = 0; i < 4; i++) {
                v = v + noise(uv + i) * 0.5;
            }
            return float4(v, v, v, 1);
        }`,
        () => sl.program(({ uv }) => {
            const v = sl.repeat(4, (i, acc) => acc.add(sl.noise(uv.add(i)).mul(0.5)), sl.float(0))
            return sl.vec4(v, v, v, 1)
        }))

    pair("an if is sl.select", `
        float4 main() {
            float v = uv.x;
            if (uv.y > 0.5) {
                v = v * 2;
            }
            return float4(v, 0, 0, 1);
        }`,
        () => sl.program(({ uv }) => {
            const v = uv.x
            const cond = sl.float(1).sub(sl.step(uv.y, 0.5))
            return sl.vec4(sl.select(cond, v.mul(2), v), 0, 0, 1)
        }))

    pair("a ?: is sl.select too", `
        float4 main() {
            float v = uv.x <= 0.5 ? uv.y : 1 - uv.y;
            return float4(v, 0, 0, 1);
        }`,
        () => sl.program(({ uv }) => {
            const cond = sl.step(uv.x, 0.5)
            return sl.vec4(sl.select(cond, uv.y, sl.float(1).sub(uv.y)), 0, 0, 1)
        }))

    pair("a function costs what writing it out costs", `
        float ring(float2 p, float r) { return length(p) - r; }
        float4 main() { return float4(ring(uv - 0.5, 0.25), 0, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(uv.sub(0.5).length().sub(0.25), 0, 0, 1)))

    pair("a prelude function is an ordinary inlined function", `
        float4 main() { return float4(circle(uv - 0.5, 0.25), 0, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(uv.sub(0.5).length().sub(0.25), 0, 0, 1)))

    pair("a texture sample", `
        texture2D art;
        float4 main() { return tex2D(art, uv * 4); }`,
        () => sl.program(({ uv }) => sl.texture("art").sample(uv.mul(4))))

    pair("remap is a macro over arithmetic", `
        float4 main() { return float4(remap(uv.x, 0, 1, 0.25, 0.75), 0, 0, 1); }`,
        () => sl.program(({ uv }) => sl.vec4(sl.remap(uv.x, 0, 1, 0.25, 0.75), 0, 0, 1)))
})
