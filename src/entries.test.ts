import { describe, it, expect } from "vitest"
import * as main from "./index"
import * as core from "./core"
import * as tables from "./tables"
import * as limits from "./limits"
import * as vm from "./vm"
import * as unity from "./emit/unity"
import * as web from "./emit/web"
import * as body from "./emit/hlsl-body"

/**
 * The public surface, entry by entry. Another host pins a version of this
 * package and imports these names, so removing or renaming one is a breaking
 * change and should fail here first, where it can be a decision.
 */
const names = (m: object) => Object.keys(m).sort()

describe("entry points", () => {
    it("core is a program without the parser", () => {
        expect(names(core)).toEqual([
            "INPUTS", "INPUT_ID", "MAX_NODES", "MAX_TEXTURES", "SLError", "SLOP", "SL_ARITY", "SL_IR_VERSION",
            "SL_NAME", "SL_SDF_PARAMS", "SL_SDF_SHAPES", "TYPE", "fromJSON", "hashProgram", "inputsUsed",
            "isSampling", "parseColor", "sl", "toJSON", "widthName",
        ])
    })

    it("the main entry is core plus the parser", () => {
        const parser = [
            "PRELUDE_SOURCE", "SLParseError", "analyze", "classify", "diagnose", "fromGLSL", "parse", "parseUnit",
            "preludeFunctions", "tokenize",
        ]
        expect(names(main)).toEqual([...names(core), ...parser].sort())
    })

    it("the others", () => {
        expect(names(tables)).toEqual([
            "BUILTINS", "BUILTIN_DOCS", "BUILTIN_PARAMS", "INPUTS", "INPUT_DOCS", "LIB_SIGNATURES", "NOT_YET",
            "PRELUDE_DOCS", "PRELUDE_NAMES", "SLOP", "SL_ARITY", "SL_CALL_NAMES", "SL_GLSL_HINT", "SL_HLSL",
            "SL_KEYWORDS", "SL_NAME", "SL_SDF_PARAMS", "SL_SDF_PARAM_NAMES", "SL_SDF_SHAPES", "SL_TYPES",
            "SL_UNIMPLEMENTED", "TYPE_WIDTH",
        ])
        expect(names(limits)).toEqual(["MAX_INSTRUCTIONS", "REGISTERS", "VM_TEXTURES", "VM_UNIFORMS", "vmFit"])
        expect(names(vm)).toEqual([
            "INPUT_ID", "MAX_INSTRUCTIONS", "REGISTERS", "SL_WIRE_VERSION", "TEXELS_PER_INSTRUCTION", "VM_TEXTURES",
            "VM_UNIFORMS", "encode", "forVm", "liveRanges", "reachable",
        ])
        expect(names(unity)).toEqual(["emitFragmentBody", "emitShader", "uniformProperty"])
        expect(names(body)).toEqual(["emitBody", "emitLibrary"])
        expect(names(web)).toEqual(["WEB_UNIFORM_SLOTS", "emitGLSL", "emitWGSL"])
    })

    it("every entry in package.json exists and is one of these", async () => {
        const pkg = (await import("../package.json")).default as { exports: Record<string, string> }
        expect(Object.keys(pkg.exports).sort()).toEqual(
            [".", "./core", "./emit/hlsl-body", "./emit/unity", "./emit/web", "./goldens.json", "./limits", "./tables", "./vm"],
        )
        // The one entry that is data: what a host's own renderer is held to.
        expect(pkg.exports["./goldens.json"]).toBe("./goldens/goldens.json")
    })
})
