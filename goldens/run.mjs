/**
 * Writes goldens.json: every corpus fixture drawn as a Linear OneJS game stores
 * it, on WebGPU and on WebGL2, in a real Chrome with its own profile.
 *
 *     node goldens/run.mjs              # CHROME=/path/to/chrome to choose one
 *
 * The two backends have to agree within 1/255, and three anchor fixtures have
 * to match arithmetic rather than each other: `orient.sl` (orientation and the
 * linear to sRGB store), `hex.sl` (a hex colour stores as written) and
 * `texture.sl` (a texture's orientation and its sRGB decode). Two backends can
 * agree while both are wrong in the same way; an anchor cannot.
 *
 * Samples, not images: a 16 x 16 grid of pixels, at x = 2 + 4i and y = 2 + 4j,
 * rows from the top, RGBA each, per fixture per time. Small enough to diff, and
 * a wrong distance or a wrong noise anywhere in the frame still shows.
 */
import esbuild from "esbuild"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { fixtureSources } from "../corpus/fixtures.mjs"

const HERE = import.meta.dirname
const TIMES = [0, 1.25]
const STEP = 4
const OFFSET = 2
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "../package.json"), "utf8"))

// Compiled in Node with the package's own emitters; the page only draws.
const bundle = esbuild.buildSync({
    entryPoints: [path.join(HERE, "compile.ts")], bundle: true, format: "iife", globalName: "__goldens",
    platform: "neutral", target: "es2020", write: false, logLevel: "silent",
}).outputFiles[0].text
const context = vm.createContext({})
vm.runInContext(bundle, context)
const sources = fixtureSources(vm.runInContext("__goldens.SL_SDF_PARAMS", context))
const fixtures = JSON.parse(vm.runInContext(`JSON.stringify(__goldens.compile(${JSON.stringify(sources)}))`, context))
const irVersion = vm.runInContext("__goldens.SL_IR_VERSION", context)
const library = JSON.parse(vm.runInContext("JSON.stringify(__goldens.wholeLibrary())", context))

const page = fs.readFileSync(path.join(HERE, "page.html"))
const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" })
    res.end(page)
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))

const chromeBinary = process.env.CHROME ?? (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
// Its own profile, never anyone's own browser, and killed however this ends.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), `chrome-slgoldens-${process.pid}-`))
const chrome = spawn(chromeBinary, [
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions",
    "--window-size=400,300", "--enable-unsafe-webgpu", "about:blank",
], { stdio: "ignore", detached: process.platform !== "win32" })
const reap = () => {
    try {
        if (process.platform === "win32") chrome.kill()
        else process.kill(-chrome.pid, "SIGKILL")
    } catch { /* gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* in use */ }
}
process.on("exit", reap)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let endpoint = null
for (let i = 0; i < 60 && endpoint === null; i++) {
    await sleep(400)
    try {
        const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split("\n")
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
        endpoint = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null
    } catch { /* not up yet */ }
}
if (endpoint === null) throw new Error(`Chrome at ${chromeBinary} never opened a page to drive`)

const ws = new WebSocket(endpoint)
await new Promise((r) => ws.addEventListener("open", r))
let id = 0
const pending = new Map()
ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    const ex = r.result?.exceptionDetails
    if (ex) throw new Error(ex.exception?.description ?? ex.text)
    return r.result.result.value
}
await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` })
for (let i = 0; i < 50 && (await evaluate("typeof window.goldens").catch(() => "")) !== "object"; i++) await sleep(100)

const draw = {}
for (const backend of ["webgpu", "webgl2"]) {
    draw[backend] = await evaluate(`goldens.render(${JSON.stringify(backend)}, ${JSON.stringify(fixtures)}, ${JSON.stringify(TIMES)})`)
    console.log(`[goldens] ${backend}: ${draw[backend].device}`)
}
// Every translated function, including the ones no fixture reaches, has to
// compile on both backends. Checked, not recorded: goldens.json is pixels.
const libraryErrors = {}
for (const [backend, source] of [["webgpu", library.wgsl], ["webgl2", library.glsl]]) {
    libraryErrors[backend] = await evaluate(`goldens.compiles(${JSON.stringify(backend)}, ${JSON.stringify(source)})`)
}
const textureBytes = await evaluate("goldens.textureBytes()")
const SIZE = await evaluate("goldens.size")
ws.close()
server.close()

const grid = Math.floor(SIZE / STEP)
const samples = (image) => {
    const out = []
    for (let j = 0; j < grid; j++) {
        for (let i = 0; i < grid; i++) {
            const o = ((OFFSET + STEP * j) * SIZE + OFFSET + STEP * i) * 4
            out.push(image[o], image[o + 1], image[o + 2], image[o + 3])
        }
    }
    return out
}

const failures = []
for (const [backend, error] of Object.entries(libraryErrors)) {
    if (error !== "") failures.push(`the whole library does not compile on ${backend}: ${error}`)
}
// The backends against each other, over every pixel, not only the samples.
let agreement = 0
for (const name of Object.keys(fixtures)) {
    for (const t of TIMES) {
        const a = draw.webgpu.images[name][t], b = draw.webgl2.images[name][t]
        let worst = 0
        for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
        agreement = Math.max(agreement, worst)
        if (worst > 1) failures.push(`${name} at ${t}s: WebGPU and WebGL2 differ by ${worst}/255`)
        if (a.every((v) => v === 0)) failures.push(`${name} at ${t}s drew nothing`)
    }
}

// The anchors, against arithmetic.
const encode = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))
const decode = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const texel = (x, y, ch) => {
    const cx = Math.min(7, Math.max(0, x)), cy = Math.min(7, Math.max(0, y))
    return decode(textureBytes[(cy * 8 + cx) * 4 + ch])
}
const bilinear = (u, v, ch) => {
    const x = u * 8 - 0.5, y = v * 8 - 0.5
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
    const lerp = (a, b, f) => a + (b - a) * f
    return lerp(lerp(texel(x0, y0, ch), texel(x0 + 1, y0, ch), fx), lerp(texel(x0, y0 + 1, ch), texel(x0 + 1, y0 + 1, ch), fx), fy)
}
const anchors = {
    "orient.sl": { tolerance: 1, expect: (u, v) => [encode(u), encode(v), 0, 255] },
    "hex.sl": { tolerance: 0, expect: () => [255, 128, 64, 255] },
    // Filtering in linear light is to the GPU's own precision, hence 2.
    "texture.sl": { tolerance: 2, expect: (u, v) => [0, 1, 2].map((ch) => encode(bilinear(u, v, ch))).concat(255) },
}
const anchorWorst = {}
for (const [name, { tolerance, expect }] of Object.entries(anchors)) {
    if (!(name in fixtures)) { failures.push(`anchor ${name} is not in the corpus`); continue }
    let worst = 0
    for (const backend of ["webgpu", "webgl2"]) {
        const image = draw[backend].images[name][0]
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const want = expect((x + 0.5) / SIZE, 1 - (y + 0.5) / SIZE)
                for (let ch = 0; ch < 4; ch++) worst = Math.max(worst, Math.abs(image[(y * SIZE + x) * 4 + ch] - want[ch]))
            }
        }
    }
    anchorWorst[name] = worst
    if (worst > tolerance) failures.push(`anchor ${name} is off arithmetic by ${worst}/255 (allowed ${tolerance})`)
}

for (const f of failures) console.log(`[goldens] FAIL ${f}`)
console.log(`[goldens] the whole library (${library.wgsl.split("\n").length} WGSL lines, ${library.glsl.split("\n").length} GLSL) ` +
    `compiles on ${Object.entries(libraryErrors).filter(([, e]) => e === "").map(([b]) => b).join(" and ") || "neither backend"}`)
console.log(`[goldens] ${Object.keys(fixtures).length} fixtures x ${TIMES.length} times, backends agree within ${agreement}/255, ` +
    `anchors off arithmetic by ${Object.entries(anchorWorst).map(([k, v]) => `${k} ${v}`).join(", ")}`)
if (failures.length > 0) process.exit(1)

const out = {
    generatedBy: "onejs-sl goldens/run.mjs",
    package: PKG.version,
    ir: irVersion,
    target: "rgba8unorm-srgb: straight alpha, 8 bit, sRGB encoded, the stored bytes of a Linear OneJS game's element",
    size: [SIZE, SIZE],
    times: TIMES,
    samples: `a ${grid} x ${grid} grid at x = ${OFFSET} + ${STEP}i, y = ${OFFSET} + ${STEP}j, rows from the top, i fastest, RGBA each`,
    texture: "every sampled slot: 8 x 8, rgba8 sRGB, linear filter, clamp to edge; texel (x, y) with y from the top = " +
        "(32x + 16, 32y + 16, (x + y) even ? 200 : 40, 255); uv (0, 0) is the image's bottom left",
    uniforms: "each program's declared defaults; a colour uniform's default is sRGB as written",
    drawnOn: { webgpu: draw.webgpu.device, webgl2: draw.webgl2.device },
    backendsAgreeWithin: agreement,
    fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, fx]) => [name, {
        hash: fx.hash,
        source: fx.source,
        samples: Object.fromEntries(TIMES.map((t) => [t, samples(draw.webgpu.images[name][t])])),
    }])),
}
// One line per capture, so a changed golden reads as a changed line.
const json = JSON.stringify(out, (k, v) => (Array.isArray(v) && typeof v[0] === "number" && v.length > 8 ? `@@${v.join(",")}@@` : v), 1)
    .replace(/"@@([0-9,]*)@@"/g, "[$1]")
fs.writeFileSync(path.join(HERE, "goldens.json"), json + "\n")
console.log(`[goldens] wrote goldens/goldens.json, ${(json.length / 1024).toFixed(0)} KB`)
process.exit(0)
