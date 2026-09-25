import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { generate, LIB_FILES } from "../../lib/generate"
import { SL_SDF_SHAPES } from "../shapes"
import { libClosure, libIndex, LIB_FUNCTIONS, SDF_CALLS } from "./index"
import { LIB_HLSL } from "./hlsl"

/**
 * The generated library matches its source.
 *
 * `lib/*.hlsl` is the one copy anyone edits. Everything else is printed from
 * it by `npm run lib`, and this fails when that was not run: the tables here
 * always, OneJS's `.cginc` files when the package sits in the container.
 */

const ROOT = resolve(__dirname, "../..")
const ONEJS = resolve(ROOT, "../../Assets/Singtaa/OneJS/Resources/OneJS")
const out = generate((source) => readFileSync(resolve(ROOT, "lib", source), "utf8"))
const stale = "is stale: run `npm run lib` in onejs-sl and commit what it writes"
/** What is on disk, as LF: a Windows checkout may have converted it, and that is not drift. */
const disk = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n")

describe("the generated library", () => {
    it("is what lib/*.hlsl prints today", () => {
        for (const [file, text] of Object.entries(out.tables)) {
            expect(disk(resolve(ROOT, file)) === text, `${file} ${stale}`).toBe(true)
        }
    })

    it.skipIf(!existsSync(ONEJS))("matches OneJS's .cginc copies, in the container", () => {
        for (const f of LIB_FILES) {
            expect(disk(resolve(ONEJS, f.cginc)) === out.cginc[f.cginc], `${f.cginc} ${stale}`).toBe(true)
        }
    })

    it("reads a call for every shape from the dispatcher, each a function it has", () => {
        // Which call belongs to which id is web.test.ts's check; this is that
        // the table read from sl_sdfDistance's switch is whole.
        expect(SDF_CALLS.length).toBe(Object.keys(SL_SDF_SHAPES).length)
        for (const call of SDF_CALLS) expect(() => libIndex(call.fn), call.fn).not.toThrow()
    })

    it("finds overloads by their parameters and refuses to guess", () => {
        expect(LIB_FUNCTIONS[libIndex("sl_toLinear", ["float3"])]!.wgsl).toBe("sl_toLinear_f3")
        expect(() => libIndex("sl_toLinear")).toThrow(/more than one/)
        expect(() => libIndex("sl_nothing")).toThrow(/no sl_nothing/)
    })

    it("closes over what a function calls, in dependency order", () => {
        const fbm = libIndex("sl_fbm")
        const names = libClosure([fbm]).map((i) => LIB_FUNCTIONS[i]!.name)
        expect(names).toContain("onejsSimplexRaw")
        expect(names).toContain("onejsHash21")
        expect(names[names.length - 1]).toBe("sl_fbm")
        expect(names).not.toContain("sdCircle")
    })

    it("keeps both colours of a colour dependent function, and only those", () => {
        LIB_FUNCTIONS.forEach((f, i) => {
            const text = LIB_HLSL[i]!
            expect(typeof text !== "string", f.name).toBe(f.colour)
        })
        const linear = LIB_HLSL[libIndex("sl_toLinear", ["float"])] as { gamma: string; linear: string }
        expect(linear.gamma).toContain("return c;")
        expect(linear.linear).toContain("sl_gammaToLinear(")
    })
})
