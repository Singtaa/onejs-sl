import { describe, expect, it } from "vitest"
import { INPUTS } from "../ir"
import { SLOP, SL_HLSL, SL_CALL_NAMES, SL_GLSL_HINT, SL_UNIMPLEMENTED } from "../ops"
import { TYPE_WIDTH } from "./ast"
import * as sl from "../sl"
import { BUILTINS, NOT_YET } from "./builtins"

/**
 * The contract between the two authoring surfaces.
 *
 * `Specs/SL_TEXT.md` 3.4: "the table is not written twice". These tests are the
 * teeth behind that sentence. An opcode arriving with an EDSL helper and no
 * text spelling, or a text name that lowers to nothing, is a language whose two
 * halves disagree about what it contains, and the way that is normally
 * discovered is by an author writing something reasonable and being told it
 * does not exist.
 */

/**
 * What each `sl.*` export that is NOT a builtin call is written as instead.
 *
 * Doubles as the list of things deliberately absent from the text form's
 * vocabulary, so adding an export without a spelling fails here rather than
 * being noticed by whoever tries to use it.
 */
/**
 * EDSL exports whose text spelling is a different word, and the word.
 *
 * Checked against `SL_HLSL` rather than taken on trust, so this cannot drift
 * into claiming a name the text form does not have.
 */
const RENAMED: Record<string, string> = {
    mix: "lerp",
}

const EDSL_ONLY: Record<string, string> = {
    program: "the file itself",
    float: "float(x)",
    vec2: "float2(...)",
    vec3: "float3(...)",
    vec4: "float4(...)",
    color: "a #rrggbb literal",
    parseColor: "a #rrggbb literal",
    uniform: "uniform <type> name = <default>;",
    texture: "texture2D name;",
    repeat: "for (int i = 0; i < n; i++)",
    unrolled: "for (int i = 0; i < n; i++)",
    select: "?:",
    uniformDefaults: "not an authoring op: a host reads defaults with it",
    Val: "not an authoring op: the recorded value class",
}

describe("every opcode has a surface form", () => {
    it("SL_HLSL covers the opcode table exactly", () => {
        const codes = Object.values(SLOP).map(Number).sort((a, b) => a - b)
        const spelled = Object.keys(SL_HLSL).map(Number).sort((a, b) => a - b)
        expect(spelled).toEqual(codes)
    })

    it("a surface form is a call or a syntax, never both and never neither", () => {
        for (const [code, s] of Object.entries(SL_HLSL)) {
            const both = s.call !== undefined && s.syntax !== undefined
            const neither = s.call === undefined && s.syntax === undefined
            expect(`${code}: ${both || neither ? "ambiguous" : "ok"}`).toBe(`${code}: ok`)
        }
    })

    it("every call spelling is unique", () => {
        const names = Object.values(SL_HLSL).map((s) => s.call).filter((n): n is string => n !== undefined)
        expect(new Set(names).size).toBe(names.length)
        expect(Object.keys(SL_CALL_NAMES).length).toBe(names.length)
    })

    it("every call spelling either lowers or says why it cannot", () => {
        for (const [name, op] of Object.entries(SL_CALL_NAMES)) {
            const why = BUILTINS[name] !== undefined ? "lowers" : NOT_YET[name] !== undefined ? "explained" : "MISSING"
            expect(`${name}(${op}): ${why}`).not.toContain("MISSING")
        }
    })

    it("the names that cannot be written are exactly the unimplemented opcodes", () => {
        const unimplementedCalls = Object.keys(SL_UNIMPLEMENTED)
            .map((op) => SL_HLSL[Number(op)]!)
            .filter((s) => s.call !== undefined && s.macro !== true)
            .map((s) => s.call!)
            .sort()
        expect(Object.keys(NOT_YET).sort()).toEqual(unimplementedCalls)
    })

    it("a builtin claims the opcode its name is registered under", () => {
        for (const [name, b] of Object.entries(BUILTINS)) {
            expect(`${name} -> ${SL_HLSL[b.op]?.call}`).toBe(`${name} -> ${name}`)
        }
    })
})

describe("every EDSL builtin can be written in a file", () => {
    it("no sl.* export is unreachable from the text form", () => {
        const missing: string[] = []
        for (const [name, value] of Object.entries(sl)) {
            if (typeof value !== "function" && typeof value !== "object") continue
            if (BUILTINS[name] !== undefined) continue
            if (RENAMED[name] !== undefined) continue
            if (EDSL_ONLY[name] !== undefined) continue
            missing.push(name)
        }
        expect(missing).toEqual([])
    })

    it("a renamed export points at a name the text form really has", () => {
        for (const [edsl, text] of Object.entries(RENAMED)) {
            expect(`${edsl} -> ${text}: ${BUILTINS[text] === undefined ? "MISSING" : "ok"}`)
                .toBe(`${edsl} -> ${text}: ok`)
            expect(typeof (sl as Record<string, unknown>)[edsl]).toBe("function")
        }
    })
})

describe("GLSL spellings are recognised in order to be refused", () => {
    it("no hint shadows a name the language actually has", () => {
        for (const glsl of Object.keys(SL_GLSL_HINT)) {
            expect(`${glsl}: ${BUILTINS[glsl] === undefined ? "refused" : "CLAIMED"}`)
                .toBe(`${glsl}: refused`)
        }
    })

    it("every hint points at something that exists", () => {
        for (const [glsl, hlsl] of Object.entries(SL_GLSL_HINT)) {
            if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(hlsl)) continue
            // Built from the real tables rather than a list typed out here: a
            // hint pointing at a name that has since been removed is exactly
            // what this is meant to catch, and a hand copied allowlist would
            // hide it.
            const known = BUILTINS[hlsl] !== undefined
                || NOT_YET[hlsl] !== undefined
                || hlsl in TYPE_WIDTH
                || hlsl in INPUTS
                || hlsl === "texture2D"
            expect(`${glsl} -> ${hlsl}: ${known ? "exists" : "DANGLING"}`).toContain("exists")
        }
    })
})
