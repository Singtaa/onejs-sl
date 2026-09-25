/**
 * `npm run lib`: regenerates everything that comes from `lib/*.hlsl`.
 *
 * Writes the tables under `src/lib/`, and, when this package sits in the OneJS
 * container at `JSModules/onejs-sl`, OneJS's three `.cginc` files as well.
 * `src/lib/lib.test.ts` runs the same generator and fails on any difference,
 * so a change to the HLSL that was not regenerated cannot pass.
 */
import esbuild from "esbuild"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const HERE = import.meta.dirname
const ROOT = path.join(HERE, "..")
export const ONEJS_RESOURCES = path.join(ROOT, "../../Assets/Singtaa/OneJS/Resources/OneJS")

const bundle = esbuild.buildSync({
    entryPoints: [path.join(HERE, "generate.ts")],
    bundle: true, format: "esm", platform: "neutral", target: "es2020", write: false, logLevel: "silent",
}).outputFiles[0].text
const { generate } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`)

const out = generate((source) => readFileSync(path.join(HERE, source), "utf8"))
const write = (file, text) => {
    const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
    if (before === text) return
    writeFileSync(file, text)
    console.log(`[lib] wrote ${path.relative(process.cwd(), file)}`)
}
for (const [file, text] of Object.entries(out.tables)) write(path.join(ROOT, file), text)
if (existsSync(ONEJS_RESOURCES)) {
    for (const [file, text] of Object.entries(out.cginc)) write(path.join(ONEJS_RESOURCES, file), text)
} else {
    console.log("[lib] not inside the OneJS container, so the .cginc copies were left alone")
}
