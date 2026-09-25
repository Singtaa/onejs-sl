/**
 * Runs the corpus in QuickJS-ng and in Node, and fails unless the two agree.
 *
 * The package promises it runs anywhere plain ES2020 runs, and Magerie runs it
 * in QuickJS-ng as one IIFE. A grep for host APIs cannot see what a dependency
 * or a library method calls, and a test under Node cannot see QuickJS
 * formatting a number differently, so this runs the real thing: bundled the way
 * Magerie bundles it, then evaluated in both engines, and compared byte for
 * byte. Node's side runs in a bare context, with no Node globals either.
 */
import esbuild from "esbuild"
import path from "node:path"
import vm from "node:vm"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import variant from "@jitl/quickjs-ng-wasmfile-release-sync"
import { fixtureSources } from "../corpus/fixtures.mjs"

const HERE = import.meta.dirname
const bundle = esbuild.buildSync({
    entryPoints: [path.join(HERE, "corpus.ts")],
    bundle: true, format: "iife", globalName: "__corpus", platform: "neutral", target: "es2020",
    write: false, logLevel: "silent",
}).outputFiles[0].text

const context = vm.createContext({})
vm.runInContext(bundle, context)
const sources = fixtureSources(vm.runInContext("__corpus.SL_SDF_PARAMS", context))
const call = `JSON.stringify(__corpus.run(${JSON.stringify(sources)}))`
const expected = vm.runInContext(call, context)

const QuickJS = await newQuickJSWASMModuleFromVariant(variant)
const runtime = QuickJS.newRuntime()
const ctx = runtime.newContext()
const result = ctx.evalCode(bundle + "\n;" + call, "corpus.js")
if (result.error) {
    const error = ctx.dump(result.error)
    result.error.dispose()
    ctx.dispose(); runtime.dispose()
    console.error("[quickjs] the corpus threw inside QuickJS:", error)
    process.exit(1)
}
const got = ctx.getString(result.value)
result.value.dispose()
ctx.dispose(); runtime.dispose()

const a = JSON.parse(expected)
const b = JSON.parse(got)
const cases = Object.keys(a)
const differ = cases.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
const missing = Object.keys(b).filter((k) => !(k in a))
const programs = cases.filter((k) => a[k] && typeof a[k] === "object" && "hash" in a[k]).length
const refused = cases.filter((k) => a[k]?.vm?.refused !== undefined)
if (differ.length > 0 || missing.length > 0 || got !== expected) {
    for (const k of differ) {
        const x = JSON.stringify(a[k]), y = JSON.stringify(b[k])
        let i = 0
        while (i < x.length && x[i] === y[i]) i++
        console.error(`[quickjs] ${k} differs at ${i}: node ${x.slice(i, i + 80)} | quickjs ${y.slice(i, i + 80)}`)
    }
    for (const k of missing) console.error(`[quickjs] ${k} is only in QuickJS's result`)
    process.exit(1)
}
console.log(`[quickjs] ${cases.length} cases (${programs} programs, ${refused.length} over the VM's limits) agree with Node, ` +
    `${(got.length / 1024).toFixed(0)} KB byte for byte, bundle ${(bundle.length / 1024).toFixed(0)} KB`)
