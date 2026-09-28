import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { generate, LIB_FILES } from "../../lib/generate"
import { check, parseLibrary, type Expr } from "../../lib/translate"
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
        expect(names).toContain("onejsPcg2d")
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

    /**
     * The hashes stay integer arithmetic (lib/noise2d.hlsl says why). Not a
     * text match on one formula: a rule on every function named for hashing,
     * read from the checked syntax tree, about what a compiler could round
     * differently. Floats may come in and go out, but only through operations
     * that are exact wherever they are fused: no intrinsic that computes (frac,
     * sin, dot and the rest), a float multiply only by a power of two, and no
     * float add or subtract with a multiply on either side.
     */
    it("keeps every hash free of float arithmetic a compiler could round differently", () => {
        const fns = check(LIB_FILES.flatMap((f) => parseLibrary(readFileSync(resolve(ROOT, "lib", f.source), "utf8").replace(/\r\n/g, "\n"), f.source))).fns
        const hashes = fns.filter((fn) => /hash|pcg/i.test(fn.name))
        expect(hashes.map((fn) => fn.name)).toEqual(expect.arrayContaining(["onejsPcg2d", "onejsHashKey", "onejsHash21", "sl_hash22"]))
        const EXACT_INTRINSICS = new Set(["clamp", "floor", "min", "max", "abs"])
        const float = (e: Expr) => e.ty !== undefined && e.ty.startsWith("float")
        const powerOfTwo = (e: Expr): boolean => {
            const x = e.k === "conv" || e.k === "paren" ? e.e : e
            if (x.k !== "num") return false
            const v = Math.abs(Number(x.text))
            return v > 0 && Number.isInteger(Math.log2(v))
        }
        const product = (e: Expr): boolean => (e.k === "paren" || e.k === "conv" ? product(e.e) : e.k === "binary" && e.op === "*")
        const problems: string[] = []
        const visit = (node: unknown, fn: string) => {
            if (node === null || typeof node !== "object") return
            if (Array.isArray(node)) { for (const n of node) visit(n, fn); return }
            const e = node as Expr
            if (e.k === "call" && e.fn === undefined && e.ctor !== true && !EXACT_INTRINSICS.has(e.name)) problems.push(`${fn} calls ${e.name}`)
            if (e.k === "binary" && float(e)) {
                if (e.op === "*" && !powerOfTwo(e.l) && !powerOfTwo(e.r)) problems.push(`${fn} multiplies floats by something other than a power of two, line ${e.line}`)
                if (e.op === "/") problems.push(`${fn} divides floats, line ${e.line}`)
                if ((e.op === "+" || e.op === "-") && (product(e.l) || product(e.r))) problems.push(`${fn} adds a float product, which a compiler may fuse, line ${e.line}`)
            }
            for (const v of Object.values(node)) if (typeof v === "object") visit(v, fn)
        }
        for (const fn of hashes) visit(fn.body, fn.name)
        expect(problems).toEqual([])
    })

    /**
     * Early returns there make Unity's Metal compile of OneJS's FxSources warn
     * of a potentially uninitialized variable in every project (issue #1). Only
     * this function: other early returns in the library compile clean.
     */
    it("returns once from onejsFbmKind", () => {
        const fns = check(LIB_FILES.flatMap((f) => parseLibrary(readFileSync(resolve(ROOT, "lib", f.source), "utf8").replace(/\r\n/g, "\n"), f.source))).fns
        const kind = fns.find((fn) => fn.name === "onejsFbmKind")!
        let returns = 0
        const visit = (node: unknown) => {
            if (node === null || typeof node !== "object") return
            if (Array.isArray(node)) { for (const n of node) visit(n); return }
            if ((node as { k?: string }).k === "return") returns++
            for (const v of Object.values(node)) if (typeof v === "object") visit(v)
        }
        visit(kind.body)
        expect(returns).toBe(1)
    })
})
