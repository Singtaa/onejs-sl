/**
 * Writes goldens.json: every corpus fixture drawn as a Linear OneJS game stores
 * it, on WebGPU and on WebGL2, in a real Chrome with its own profile.
 *
 *     node goldens/run.mjs              # CHROME=/path/to/chrome to choose one
 *
 * The two backends have to agree within 1/255, and the anchor fixtures have
 * to match arithmetic rather than each other: `orient.sl` (orientation and the
 * linear to sRGB store), `hex.sl` (a hex colour stores as written) and
 * `texture.sl` (a texture's orientation and its sRGB decode). Two backends can
 * agree while both are wrong in the same way; an anchor cannot.
 *
 * The hashes are held tighter than that. `probes.hlsl` draws each of the
 * library's two hashes bit for bit, and `corpus/probe-hash.sl` does the same
 * through a program; `reference.mjs` says what every pixel has to be, and a
 * single pixel off fails. A hash two compilers round differently draws a
 * different noise, and 1/255 of agreement between two backends that happen to
 * round alike proves nothing about a third.
 *
 * Samples, not images: a 16 x 16 grid of pixels, at x = 2 + 4i and y = 2 + 4j,
 * rows from the top, RGBA each, per fixture per time. Small enough to diff, and
 * a wrong distance or a wrong noise anywhere in the frame still shows.
 *
 * A fixture that reads the previous frame, `frame` or `deltaTime` is stepped
 * instead (`page.html` says how): STEPS.count frames STEPS.dt apart, sampled at
 * the frames in STEPS.record, both as the element shows them and as the raw
 * `rgba16float` history holds them. `counter.sl`, `drift.sl` and
 * `frame-delta.sl` are anchors on the history, to the bit: a step taken twice,
 * a missed swap, a previous frame read upside down or history kept at 8 bits
 * each moves a value arithmetic says exactly.
 *
 *     node goldens/run.mjs --check      # compare with goldens.json, write nothing
 *
 * `--check` is the release gate on a machine other than the one that wrote
 * goldens.json: every fixture has to draw what it records, within the 1/255
 * the backends are allowed, and the exact ones and the probes to the bit.
 */
import esbuild from "esbuild"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { fixtureSources } from "../corpus/fixtures.mjs"
import { PROBE_PIXELS, intOpsPixel, loopCapLinear, probeProgramPixel } from "./reference.mjs"

const HERE = import.meta.dirname
const TIMES = [0, 1.25]
const STEPS = { count: 8, dt: 1 / 30, record: [0, 1, 7] }
const STEP = 4
const OFFSET = 2
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "../package.json"), "utf8"))
const CHECK = process.argv.includes("--check")

// Compiled in Node with the package's own emitters; the page only draws.
const bundle = esbuild.buildSync({
    entryPoints: [path.join(HERE, "compile.ts")], bundle: true, format: "iife", globalName: "__goldens",
    platform: "neutral", target: "es2020", write: false, logLevel: "silent", loader: { ".hlsl": "text" },
}).outputFiles[0].text
const context = vm.createContext({})
vm.runInContext(bundle, context)
const sources = fixtureSources(vm.runInContext("__goldens.SL_SDF_PARAMS", context))
const fixtures = JSON.parse(vm.runInContext(`JSON.stringify(__goldens.compile(${JSON.stringify(sources)}))`, context))
const irVersion = vm.runInContext("__goldens.SL_IR_VERSION", context)
const library = JSON.parse(vm.runInContext("JSON.stringify(__goldens.wholeLibrary())", context))
const probes = JSON.parse(vm.runInContext("JSON.stringify(__goldens.probes())", context))

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
    draw[backend] = await evaluate(`goldens.render(${JSON.stringify(backend)}, ${JSON.stringify(fixtures)}, ${JSON.stringify(TIMES)}, ${JSON.stringify(STEPS)})`)
    console.log(`[goldens] ${backend}: ${draw[backend].device}`)
}
const probeDraw = {}
for (const backend of ["webgpu", "webgl2"]) {
    const asFixtures = Object.fromEntries(Object.entries(probes).map(([name, p]) => [name, { ...p.draw, defaults: [] }]))
    probeDraw[backend] = (await evaluate(`goldens.render(${JSON.stringify(backend)}, ${JSON.stringify(asFixtures)}, [0])`)).images
}
// Every translated function, including the ones no fixture reaches, has to
// compile on both backends. Checked, not recorded: goldens.json is pixels.
const libraryErrors = {}
for (const [backend, source] of [["webgpu", library.wgsl], ["webgl2", library.glsl]]) {
    libraryErrors[backend] = await evaluate(`goldens.compiles(${JSON.stringify(backend)}, ${JSON.stringify(source)})`)
}
const textureBytes = await evaluate("goldens.textureBytes()")
const mips = await evaluate("goldens.mips")
const SIZE = await evaluate("goldens.size")
ws.close()
server.close()

const grid = Math.floor(SIZE / STEP)
const isStepped = (fx) => fx.reads.previous || fx.reads.frame || fx.reads.deltaTime
const timed = Object.keys(fixtures).filter((name) => !isStepped(fixtures[name]))
const stepped = Object.keys(fixtures).filter((name) => isStepped(fixtures[name]))
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
for (const name of timed) {
    for (const t of TIMES) {
        const a = draw.webgpu.images[name][t], b = draw.webgl2.images[name][t]
        let worst = 0
        for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
        agreement = Math.max(agreement, worst)
        if (worst > 1) failures.push(`${name} at ${t}s: WebGPU and WebGL2 differ by ${worst}/255`)
        if (a.every((v) => v === 0)) failures.push(`${name} at ${t}s drew nothing`)
    }
}
// Stepped: the shown bytes as above; the history to 1/255, since the two
// backends' arithmetic may round a last place apart.
let historyAgreement = 0
for (const name of stepped) {
    for (const k of STEPS.record) {
        const a = draw.webgpu.steps[name].display[k], b = draw.webgl2.steps[name].display[k]
        let worst = 0
        for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
        agreement = Math.max(agreement, worst)
        if (worst > 1) failures.push(`${name} at frame ${k}: WebGPU and WebGL2 differ by ${worst}/255`)
        if (a.every((v) => v === 0)) failures.push(`${name} at frame ${k} drew nothing`)
        const ha = draw.webgpu.steps[name].history[k], hb = draw.webgl2.steps[name].history[k]
        let hworst = 0
        for (let i = 0; i < ha.length; i++) hworst = Math.max(hworst, Math.abs(ha[i] - hb[i]))
        historyAgreement = Math.max(historyAgreement, hworst)
        if (!(hworst <= 1 / 255)) failures.push(`${name} at frame ${k}: the backends' history differs by ${hworst}`)
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
    "probe-hash.sl": { tolerance: 0, expect: (u, v, x, y) => probeProgramPixel(x, y) },
    // A ramp of colour values and of the same hexes, black where they agree.
    "ramp-values.sl": { tolerance: 0, expect: () => [0, 0, 0, 255] },
    // Noise with its octave count as a value and as a constant, black where they agree.
    "fbm-values.sl": { tolerance: 0, expect: () => [0, 0, 0, 255] },
    // Shapes measured with value parameters and with constants, black where they agree.
    "sdf-values.sl": { tolerance: 0, expect: () => [0, 0, 0, 255] },
    // Ints and uints worked out here, each channel 0 or 1.
    "int-ops.sl": { tolerance: 0, expect: (u, v) => intOpsPixel(u, v) },
    // A loop leaving at its turn limit, exactly; green and blue are stored floats, so within 1.
    "loop-cap.sl": { tolerance: 1, expect: (u, v) => loopCapLinear(u, v).map(encode).concat(255) },
    // Four bands, each one mip level: the image, then the three solid levels.
    "lod.sl": {
        tolerance: 2,
        expect: (u, v) => {
            const level = Math.floor(u * 4)
            return level === 0 ? [0, 1, 2].map((ch) => encode(bilinear(u, v, ch))).concat(255) : [...mips[level - 1], 255]
        },
    },
}
/** A fixture compared at 0/255, here and by `--check`, and marked `exact` in goldens.json for a host. */
const exact = (name) => anchors[name]?.tolerance === 0
const anchorWorst = {}

/** A half, as the history stores a value: round to nearest even, in range here. */
const toHalf = (v) => {
    if (v === 0) return 0
    const e = Math.floor(Math.log2(Math.abs(v)))
    const q = 2 ** (Math.max(e, -14) - 10)
    const n = v / q, r = Math.round(n)
    return (Math.abs(n - Math.trunc(n)) === 0.5 && r % 2 !== 0 ? r - Math.sign(n) : r) * q
}
/**
 * The stepped anchors: what the history holds at frame k, pixel (x, y) from the
 * top left, worked out here. Every one is exact in a half.
 */
const historyAnchors = {
    "counter.sl": (k) => [(k + 1) / 256, (k + 1) / 256, (k + 1) / 256, 1],
    "drift.sl": (k, x, y) => {
        const from = Math.max(SIZE - 1 - y - k, 0)
        return [Math.floor(x / 8) / 8, Math.floor(from / 8) / 8, 0.5, 1]
    },
    // deltaTime * 30 in float, stored as a half: 1 after the first frame.
    "frame-delta.sl": (k) => [k / 256, k === 0 ? 0 : toHalf(Math.fround(Math.fround(STEPS.dt) * 30)), 1, 1],
}
/** Whether a stepped fixture's history is compared to the bit, here, by `--check`, and marked so for a host. */
const historyExact = (name) => name in historyAnchors
for (const [name, expect] of Object.entries(historyAnchors)) {
    if (!stepped.includes(name)) { failures.push(`anchor ${name} is not a stepped fixture in the corpus`); continue }
    let worst = 0, first = null
    for (const backend of ["webgpu", "webgl2"]) {
        for (const k of STEPS.record) {
            const h = draw[backend].steps[name].history[k]
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const want = expect(k, x, y)
                    for (let ch = 0; ch < 4; ch++) {
                        const off = Math.abs(h[(y * SIZE + x) * 4 + ch] - want[ch])
                        if (off > worst) { worst = off; first ??= `${backend} frame ${k} (${x}, ${y}) channel ${ch}: ${h[(y * SIZE + x) * 4 + ch]}, wanted ${want[ch]}` }
                    }
                }
            }
        }
    }
    anchorWorst[name] = worst
    if (worst > 0) failures.push(`anchor ${name}'s history is off arithmetic by ${worst}; the first: ${first}`)
}
// What an element shows is its history, stored: every byte within 1 of the
// value encoded, and alpha stored as it is.
for (const name of stepped) {
    for (const backend of ["webgpu", "webgl2"]) {
        for (const k of STEPS.record) {
            const h = draw[backend].steps[name].history[k], d = draw[backend].steps[name].display[k]
            let worst = 0
            for (let i = 0; i < d.length; i++) {
                const v = Math.min(1, Math.max(0, h[i]))
                worst = Math.max(worst, Math.abs(d[i] - (i % 4 === 3 ? Math.round(v * 255) : encode(v))))
            }
            if (worst > 1) failures.push(`${name} at frame ${k} on ${backend} shows ${worst}/255 off its own history`)
        }
    }
}
for (const [name, { tolerance, expect }] of Object.entries(anchors)) {
    if (!(name in fixtures)) { failures.push(`anchor ${name} is not in the corpus`); continue }
    let worst = 0
    for (const backend of ["webgpu", "webgl2"]) {
        const image = draw[backend].images[name][0]
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const want = expect((x + 0.5) / SIZE, 1 - (y + 0.5) / SIZE, x, y)
                for (let ch = 0; ch < 4; ch++) worst = Math.max(worst, Math.abs(image[(y * SIZE + x) * 4 + ch] - want[ch]))
            }
        }
    }
    anchorWorst[name] = worst
    if (worst > tolerance) failures.push(`anchor ${name} is off arithmetic by ${worst}/255 (allowed ${tolerance})`)
}

// The probes, against reference.mjs, every pixel, on each backend.
const probeWrong = {}
const expected = Object.fromEntries(Object.keys(probes).map((name) => {
    const image = []
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) image.push(...PROBE_PIXELS[name](x, y))
    return [name, image]
}))
for (const name of Object.keys(probes)) {
    for (const backend of ["webgpu", "webgl2"]) {
        const image = probeDraw[backend][name][0], want = expected[name]
        const wrong = []
        for (let i = 0; i < SIZE * SIZE; i++) {
            if ([0, 1, 2, 3].some((ch) => image[i * 4 + ch] !== want[i * 4 + ch])) wrong.push(i)
        }
        probeWrong[`${name} on ${backend}`] = wrong.length
        if (wrong.length > 0) {
            const at = wrong[0]
            failures.push(`probe ${name} on ${backend}: ${wrong.length} of ${SIZE * SIZE} pixels are not the reference's; ` +
                `the first is (${at % SIZE}, ${Math.floor(at / SIZE)}), block ${at >> 8}, drawn ${image.slice(at * 4, at * 4 + 3)}, wanted ${want.slice(at * 4, at * 4 + 3)}`)
        }
    }
}

/** Each pixel's three bits as one digit, 4r + 2g + b, rows from the top: what goldens.json ships per probe. */
const digits = (image) => {
    let out = ""
    for (let i = 0; i < SIZE * SIZE; i++) out += String((image[i * 4] ? 4 : 0) + (image[i * 4 + 1] ? 2 : 0) + (image[i * 4 + 2] ? 1 : 0))
    return out
}

// --check: what this machine drew, against what goldens.json records.
let recordedFrom = null
if (CHECK) {
    const recorded = JSON.parse(fs.readFileSync(path.join(HERE, "goldens.json"), "utf8"))
    recordedFrom = recorded.drawnOn
    for (const name of Object.keys(recorded.fixtures)) {
        if (!(name in fixtures)) failures.push(`goldens.json records ${name}, which the corpus no longer has: regenerate it`)
    }
    for (const [name, fx] of Object.entries(fixtures)) {
        const r = recorded.fixtures[name]
        if (r === undefined) { failures.push(`${name} is not in goldens.json: regenerate it`); continue }
        if (r.hash !== fx.hash) { failures.push(`${name} compiles to ${fx.hash}, and goldens.json has ${r.hash}: regenerate it`); continue }
        if (isStepped(fx)) {
            if (r.frames === undefined || r.history === undefined) { failures.push(`${name} is stepped, and goldens.json has no frames for it: regenerate it`); continue }
            const allowedHistory = historyExact(name) ? 0 : 1 / 255
            for (const k of STEPS.record) {
                for (const backend of ["webgpu", "webgl2"]) {
                    const got = samples(draw[backend].steps[name].display[k]), want = r.frames[k]
                    let worst = 0
                    for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]))
                    if (worst > 1) failures.push(`${name} at frame ${k} on ${backend} is ${worst}/255 from goldens.json (allowed 1)`)
                    const gotH = samples(draw[backend].steps[name].history[k]), wantH = r.history[k]
                    let worstH = 0
                    for (let i = 0; i < wantH.length; i++) worstH = Math.max(worstH, Math.abs(gotH[i] - wantH[i]))
                    if (!(worstH <= allowedHistory)) failures.push(`${name}'s history at frame ${k} on ${backend} is ${worstH} from goldens.json (allowed ${allowedHistory})`)
                }
            }
            continue
        }
        const allowed = exact(name) ? 0 : 1
        for (const t of TIMES) {
            for (const backend of ["webgpu", "webgl2"]) {
                const got = samples(draw[backend].images[name][t]), want = r.samples[t]
                let worst = 0
                for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]))
                if (worst > allowed) failures.push(`${name} at ${t}s on ${backend} is ${worst}/255 from goldens.json (allowed ${allowed})`)
            }
        }
    }
    for (const [name, p] of Object.entries(probes)) {
        const r = recorded.probes?.[name]
        if (r === undefined) { failures.push(`probe ${name} is not in goldens.json: regenerate it`); continue }
        for (const lang of ["hlsl", "wgsl", "glsl"]) {
            if (r[lang] !== p[lang]) failures.push(`probe ${name}'s ${lang} differs from goldens.json: regenerate it`)
        }
        if (r.bits !== digits(expected[name])) failures.push(`probe ${name}'s reference differs from goldens.json: regenerate it`)
    }
}

for (const f of failures) console.log(`[goldens] FAIL ${f}`)
console.log(`[goldens] the whole library (${library.wgsl.split("\n").length} WGSL lines, ${library.glsl.split("\n").length} GLSL) ` +
    `compiles on ${Object.entries(libraryErrors).filter(([, e]) => e === "").map(([b]) => b).join(" and ") || "neither backend"}`)
console.log(`[goldens] ${timed.length} fixtures x ${TIMES.length} times and ${stepped.length} stepped x ${STEPS.record.length} frames, ` +
    `backends agree within ${agreement}/255 and their histories within ${historyAgreement}, ` +
    `anchors off arithmetic by ${Object.entries(anchorWorst).map(([k, v]) => `${k} ${v}`).join(", ")}`)
console.log(`[goldens] hash probes, pixels off the reference: ${Object.entries(probeWrong).map(([k, v]) => `${k} ${v}`).join(", ")}`)
if (CHECK) {
    console.log(`[goldens] --check: drawn on WebGPU ${draw.webgpu.device} and WebGL2 ${draw.webgl2.device}; ` +
        `goldens.json was drawn on WebGPU ${recordedFrom?.webgpu} and WebGL2 ${recordedFrom?.webgl2}`)
    console.log(failures.length > 0 ? `[goldens] --check FAILED, ${failures.length} problems` : "[goldens] --check passed; goldens.json left as it was")
    process.exit(failures.length > 0 ? 1 : 0)
}
if (failures.length > 0) process.exit(1)

const out = {
    generatedBy: "onejs-sl goldens/run.mjs",
    package: PKG.version,
    ir: irVersion,
    target: "rgba8unorm-srgb: straight alpha, 8 bit, sRGB encoded, the stored bytes of a Linear OneJS game's element",
    size: [SIZE, SIZE],
    times: TIMES,
    steps: `a fixture that reads previous, frame or deltaTime is stepped rather than drawn at times: ${STEPS.count} frames, ` +
        `frame k at time k / ${Math.round(1 / STEPS.dt)} with frame k and deltaTime 1 / ${Math.round(1 / STEPS.dt)} (0 on frame 0), ` +
        "each drawn raw into one half of an rgba16float history pair that starts clear, the other half its previous frame " +
        "(bilinear, clamp to edge), then copied texel for texel into the target. frames holds the target's samples at " +
        `frames ${STEPS.record.join(", ")}, and history the same samples of the raw history, as floats`,
    stepFrames: STEPS.record,
    historyExact: "a stepped fixture marked historyExact has to hold its history samples to the bit",
    samples: `a ${grid} x ${grid} grid at x = ${OFFSET} + ${STEP}i, y = ${OFFSET} + ${STEP}j, rows from the top, i fastest, RGBA each`,
    texture: "every sampled slot: 8 x 8, rgba8 sRGB, linear filter, clamp to edge; texel (x, y) with y from the top = " +
        "(32x + 16, 32y + 16, (x + y) even ? 200 : 40, 255); uv (0, 0) is the image's bottom left. Mip levels 1 to 3 " +
        `(4 x 4, 2 x 2, 1 x 1) are each one colour, ${mips.map((c) => `(${c.join(", ")}, 255)`).join(", ")}, ` +
        "sampled nearest between levels",
    uniforms: "each program's declared defaults; a colour uniform's default is sRGB as written",
    drawnOn: { webgpu: draw.webgpu.device, webgl2: draw.webgl2.device },
    backendsAgreeWithin: agreement,
    historiesAgreeWithin: historyAgreement,
    exact: "a fixture marked exact has to draw its samples to the byte, not within 1/255",
    fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, fx]) => [name, isStepped(fx) ? {
        hash: fx.hash,
        ...(historyExact(name) ? { historyExact: true } : {}),
        source: fx.source,
        frames: Object.fromEntries(STEPS.record.map((k) => [k, samples(draw.webgpu.steps[name].display[k])])),
        history: Object.fromEntries(STEPS.record.map((k) => [k, samples(draw.webgpu.steps[name].history[k])])),
    } : {
        hash: fx.hash,
        ...(exact(name) ? { exact: true } : {}),
        source: fx.source,
        samples: Object.fromEntries(TIMES.map((t) => [t, samples(draw.webgpu.images[name][t])])),
    }])),
    probeContract: `each probe is a function of a pixel of a ${SIZE} x ${SIZE} frame, x and y whole numbers from the top left, ` +
        "calling the library's own functions (the host's, in its own frame); it returns 0 or 1 per channel and alpha 1. " +
        "bits has one digit per pixel, rows from the top, 4r + 2g + b, and every pixel has to match",
    probes: Object.fromEntries(Object.entries(probes).map(([name, p]) => [name, {
        entry: p.entry, call: p.call, hlsl: p.hlsl, wgsl: p.wgsl, glsl: p.glsl, bits: digits(expected[name]),
    }])),
}
// One line per capture, so a changed golden reads as a changed line.
const json = JSON.stringify(out, (k, v) => (Array.isArray(v) && typeof v[0] === "number" && v.length > 8 ? `@@${v.join(",")}@@` : v), 1)
    .replace(/"@@([0-9,.e+-]*)@@"/g, "[$1]")
fs.writeFileSync(path.join(HERE, "goldens.json"), json + "\n")
console.log(`[goldens] wrote goldens/goldens.json, ${(json.length / 1024).toFixed(0)} KB`)
process.exit(0)
