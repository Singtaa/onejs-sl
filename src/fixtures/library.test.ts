import { describe, expect, it } from "vitest"
import { existsSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
// @ts-expect-error: plain JavaScript tooling, shared with the QuickJS run and the goldens runner
import { fixtureSources } from "../../corpus/fixtures.mjs"
import { emitShader } from "../hlsl"
import { parse } from "../lang"
import { LIB_HLSL } from "../lib/hlsl"
import { SL_SDF_PARAMS } from "../shapes"

/**
 * Writes the fixture OneJS's `SLSharedLibraryTests` renders: the corpus as
 * Unity shaders, and the whole library in the shared subset.
 *
 * The test draws every program twice in Unity, once including OneJS's
 * `SLCommon.cginc` (the library's own source) and once including the
 * translated shared subset in its place, and requires the two to agree. That
 * is the one place the shared subset `emitBody` hands a host is compiled by a
 * real HLSL compiler and drawn; the web translations are drawn by the goldens
 * and by OneJS's parity harness.
 */

const OUT = resolve(__dirname, "../../../../Assets/OneJSContainer/Tests/Editor/sl-library.json")

describe("sl shared library fixture", () => {
    it("writes the corpus as Unity shaders beside the whole shared library", () => {
        const pick = (colour: "gamma" | "linear") =>
            LIB_HLSL.map((t) => (typeof t === "string" ? t : t[colour]).trim()).join("\n")
        const sources: Record<string, string> = fixtureSources(SL_SDF_PARAMS)
        const programs = Object.entries(sources).map(([name, source]) => {
            const p = parse(source, { file: name })
            return { name, hash: p.hash, hlsl: emitShader(p, { name: `Hidden/SLLibrary/${p.hash}` }) }
        })
        const out = {
            generatedBy: "onejs-sl/src/fixtures/library.test.ts",
            library: { gamma: pick("gamma"), linear: pick("linear") },
            programs,
        }
        if (existsSync(dirname(OUT))) writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n")

        expect(programs.length).toBeGreaterThan(50)
        for (const p of programs) expect(p.hlsl.split(`#include "SLCommon.cginc"`).length, p.name).toBe(2)
        expect(out.library.linear).toContain("sl_sdfDistance(")
        expect(out.library.gamma).not.toContain("sl_gammaToLinear(c)")
    })
})
