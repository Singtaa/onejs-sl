import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { parse, SL_IR_VERSION, SL_SDF_PARAMS } from "./index"
// @ts-expect-error: plain JavaScript tooling, shared with the QuickJS run and the goldens runner
import { fixtureSources } from "../corpus/fixtures.mjs"

/**
 * goldens.json is drawn on a GPU by `goldens/run.mjs`, which no CI runner here
 * has. So this is the check that it still describes the corpus: every fixture,
 * at the hash the compiler gives it today. A change that moves a hash (a new IR
 * version, an edited fixture) fails here until the goldens are drawn again.
 */
describe("goldens.json", () => {
    const goldens = JSON.parse(fs.readFileSync(path.join(__dirname, "../goldens/goldens.json"), "utf8"))
    const sources: Record<string, string> = fixtureSources(SL_SDF_PARAMS)

    it("covers exactly the corpus, at this IR version", () => {
        expect(Object.keys(goldens.fixtures).sort()).toEqual(Object.keys(sources).sort())
        expect(goldens.ir).toBe(SL_IR_VERSION)
    })

    it("holds each fixture's source and today's hash", () => {
        for (const [name, source] of Object.entries(sources)) {
            const g = goldens.fixtures[name]
            expect(g.source, name).toBe(source)
            expect(g.hash, name).toBe(parse(source, { file: name }).hash)
        }
    })

    it("has a full grid of RGBA samples per time", () => {
        const [w] = goldens.size
        const cells = (w / 4) * (w / 4) * 4
        for (const g of Object.values(goldens.fixtures) as Array<{ samples: Record<string, number[]> }>) {
            expect(Object.keys(g.samples).map(Number)).toEqual(goldens.times)
            for (const s of Object.values(g.samples)) expect(s.length).toBe(cells)
        }
        expect(goldens.backendsAgreeWithin).toBeLessThanOrEqual(1)
    })
})
