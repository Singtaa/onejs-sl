import { describe, expect, it } from "vitest"
import { tokenize } from "./lexer"

/**
 * Tokens and the positions they carry.
 *
 * Positions are the reason this file exists as its own layer, so they are what
 * is checked. A token whose column is off by one puts an editor's squiggle
 * under the wrong character, which is worse than no squiggle: it sends the
 * reader to look at something that is fine.
 */

const kinds = (src: string) => tokenize(src, "t.sl").map((t) => `${t.kind}:${t.text}`)

describe("the lexer", () => {
    it("counts lines and columns from one, the way an editor does", () => {
        const ts = tokenize("float4 main()\n{\n    return #fff;\n}", "t.sl")
        const hex = ts.find((t) => t.kind === "hex")!
        expect([hex.line, hex.col]).toEqual([3, 12])
    })

    it("skips both comment forms without losing the line count", () => {
        const ts = tokenize("// one\n/* two\nthree */\nuv", "t.sl")
        expect(ts[0]!.line).toBe(4)
    })

    it("reads HLSL's float suffix and drops it", () => {
        const ts = tokenize("1.0f 2.5 .5 1e-3 3", "t.sl")
        expect(ts.filter((t) => t.kind === "number").map((t) => t.value)).toEqual([1, 2.5, 0.5, 1e-3, 3])
    })

    it("does not eat an identifier that begins with f", () => {
        expect(kinds("1.0 frac")).toEqual(["number:1.0", "ident:frac", "eof:"])
    })

    it("takes the longer operator when two share a prefix", () => {
        expect(kinds("a <= b").slice(1, 2)).toEqual(["punct:<="])
        expect(kinds("a < b").slice(1, 2)).toEqual(["punct:<"])
        expect(kinds("x += 1").slice(1, 2)).toEqual(["punct:+="])
    })

    it("reads every colour length as one token", () => {
        expect(kinds("#fff #ff8040 #ff8040cc")).toEqual([
            "hex:#fff", "hex:#ff8040", "hex:#ff8040cc", "eof:",
        ])
    })
})
