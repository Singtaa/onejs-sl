/**
 * A pasted GLSL fragment shader, Shadertoy's `mainImage` included, rewritten as
 * a `.sl` file.
 *
 * Decision 1 kept as `Specs/SL_NEXT.md` 5 A has it: the language accepts one
 * spelling, and porting from the other is one command rather than a second
 * column in every table. So this is a converter, not an alias list, and what
 * it cannot carry over it says rather than guesses.
 *
 * A rewrite of tokens, not of a tree. Comments, layout and the author's own
 * names survive, because the result is a file somebody goes on editing. The
 * rewrites that need to know a call's arguments (`mod`, `atan`, `inversesqrt`)
 * find them by matching brackets.
 *
 * What comes back is the text, what the conversion changed that the author
 * should know (`notes`), and what still does not compile (`errors`, from
 * `diagnose`, at their places in the new text).
 */

import { INPUTS } from "../ir"
import { BUILTINS } from "./builtins"
import { diagnose } from "./index"
import type { SLParseError } from "./lexer"
import { SL_KEYWORDS, SL_TYPES } from "./words"

export interface FromGLSL {
    /** The `.sl` file. */
    source: string
    /** What the conversion changed or dropped that the author should know, each naming the line it was on. */
    notes: string[]
    /** What still does not compile, at its place in `source`. Empty when it compiles. */
    errors: SLParseError[]
}

type Kind = "ws" | "comment" | "ident" | "number" | "punct" | "directive"
interface Tok { kind: Kind; text: string; line: number }

/** Every character in exactly one token, so joining the texts gives the input back. */
function tokenize(src: string): Tok[] {
    const out: Tok[] = []
    let i = 0
    let line = 1
    const push = (kind: Kind, end: number) => {
        const text = src.slice(i, end)
        out.push({ kind, text, line })
        for (const c of text) if (c === "\n") line++
        i = end
    }
    const ident = /[A-Za-z_]\w*/y
    const number = /(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[uUfF]?/y
    while (i < src.length) {
        const c = src[i]!
        if (/\s/.test(c)) { let j = i; while (j < src.length && /\s/.test(src[j]!)) j++; push("ws", j); continue }
        if (src.startsWith("//", i)) { const j = src.indexOf("\n", i); push("comment", j < 0 ? src.length : j); continue }
        if (src.startsWith("/*", i)) { const j = src.indexOf("*/", i + 2); push("comment", j < 0 ? src.length : j + 2); continue }
        if (c === "#") {
            // To the end of the line, a backslash continuing it.
            let j = i
            while (j < src.length && src[j] !== "\n") j += src[j] === "\\" && src[j + 1] === "\n" ? 2 : 1
            push("directive", j)
            continue
        }
        ident.lastIndex = i
        if (ident.test(src)) { push("ident", ident.lastIndex); continue }
        number.lastIndex = i
        if (/[\d.]/.test(c) && number.test(src) && number.lastIndex > i + (c === "." ? 1 : 0)) { push("number", number.lastIndex); continue }
        push("punct", i + 1)
    }
    return out
}

const GLSL_TYPES = new Set(["float", "int", "uint", "bool", "vec2", "vec3", "vec4", "ivec2", "ivec3", "ivec4",
    "uvec2", "uvec3", "uvec4", "bvec2", "bvec3", "bvec4", "mat2", "mat3", "mat4", "void", "sampler2D"])

/** A straight rename, the meaning unchanged. */
const RENAME: Record<string, string> = {
    vec2: "float2", vec3: "float3", vec4: "float4", mix: "lerp", fract: "frac",
    texture: "tex2D", texture2D: "tex2D", iTime: "time", iGlobalTime: "time", gl_FragCoord: "fragCoord",
}

/** A rename that changes what the value can hold, so it is said. */
const NARROW: Record<string, [string, string]> = {
    ivec2: ["float2", "an ivec2 is a float2 here, so dividing one no longer truncates"],
    ivec3: ["float3", "an ivec3 is a float3 here, so dividing one no longer truncates"],
    ivec4: ["float4", "an ivec4 is a float4 here, so dividing one no longer truncates"],
    uvec2: ["float2", "a uvec2 is a float2 here"], uvec3: ["float3", "a uvec3 is a float3 here"],
    uvec4: ["float4", "a uvec4 is a float4 here"],
    bvec2: ["float2", "a bvec2 is a float2 of 0s and 1s here"], bvec3: ["float3", "a bvec3 is a float3 of 0s and 1s here"],
    bvec4: ["float4", "a bvec4 is a float4 of 0s and 1s here"],
    bool: ["float", "a bool is a float that is 0 or 1 here; a comparison already is one"],
    int: ["float", "an int is a float here, so dividing one no longer truncates; wrap it in floor() where that mattered"],
    uint: ["float", "a uint is a float here"],
}

/** Shadertoy's inputs with no counterpart yet, and why. */
const MISSING: Record<string, string> = {
    iFrame: "there is no frame counter yet",
    iTimeDelta: "there is no delta time yet",
    iFrameRate: "there is no frame rate",
    iDate: "there is no date",
    iChannelTime: "a texture has no time of its own",
    iChannelResolution: "a texture's size cannot be read yet",
    iSampleRate: "there is no audio",
    textureLod: "tex2Dlod is not implemented yet; tex2D samples with the texture's own filtering",
    texelFetch: "a texture cannot be read without filtering yet",
    textureSize: "a texture's size cannot be read yet",
    dFdx: "there are no derivatives", dFdy: "there are no derivatives", fwidth: "there are no derivatives",
}

/** Names a pasted value or function cannot keep, because the language already means something by them. */
function taken(name: string, isFunction: boolean): boolean {
    if (name in INPUTS || (SL_KEYWORDS as readonly string[]).includes(name) || (SL_TYPES as readonly string[]).includes(name)) return true
    // A value may take a builtin's name; a function may not.
    return isFunction && BUILTINS[name] !== undefined
}

/** `fromGLSL(source)`: a GLSL fragment shader as a `.sl` file, with what changed and what still does not compile. */
export function fromGLSL(glsl: string, options: { file?: string } = {}): FromGLSL {
    const toks = tokenize(glsl.replace(/\r\n/g, "\n"))
    const notes: string[] = []
    const note = (line: number, text: string) => {
        const n = `line ${line}: ${text}`
        if (!notes.includes(n)) notes.push(n)
    }
    const said = new Set<string>()
    const noteOnce = (key: string, line: number, text: string) => { if (!said.has(key)) { said.add(key); note(line, text) } }

    // ---------- token plumbing ----------

    const skip = (i: number) => { while (i < toks.length && (toks[i]!.kind === "ws" || toks[i]!.kind === "comment")) i++; return i }
    const back = (i: number) => { while (i >= 0 && (toks[i]!.kind === "ws" || toks[i]!.kind === "comment")) i--; return i }
    const is = (i: number, text: string) => i >= 0 && i < toks.length && toks[i]!.text === text && toks[i]!.kind !== "comment"
    /** The index of the bracket closing the one at `open`, or the end. */
    const closing = (open: number): number => {
        const [o, c] = toks[open]!.text === "(" ? ["(", ")"] : toks[open]!.text === "{" ? ["{", "}"] : ["[", "]"]
        let depth = 0
        for (let i = open; i < toks.length; i++) {
            if (toks[i]!.kind !== "punct") continue
            if (toks[i]!.text === o) depth++
            else if (toks[i]!.text === c && --depth === 0) return i
        }
        return toks.length
    }
    /** A call's arguments, as token ranges, for the call whose "(" is at `open`. */
    const args = (open: number, close: number): Array<[number, number]> => {
        const out: Array<[number, number]> = []
        let depth = 0
        let start = open + 1
        for (let i = open + 1; i < close; i++) {
            const t = toks[i]!
            if (t.kind !== "punct") continue
            if (t.text === "(" || t.text === "[" || t.text === "{") depth++
            else if (t.text === ")" || t.text === "]" || t.text === "}") depth--
            else if (t.text === "," && depth === 0) { out.push([start, i]); start = i + 1 }
        }
        if (skip(start) < close) out.push([start, close])
        return out
    }

    // ---------- what the file declares ----------

    /** Names the pasted file declares that the language already means something by. */
    const clashes = new Map<string, string>()
    const functions = new Set<string>()
    for (let i = 0; i < toks.length; i++) {
        if (toks[i]!.kind !== "ident" || !GLSL_TYPES.has(toks[i]!.text)) continue
        const n = skip(i + 1)
        if (toks[n]?.kind !== "ident") continue
        const name = toks[n]!.text
        const isFunction = is(skip(n + 1), "(")
        if (isFunction) functions.add(name)
        if (name === "mainImage" || name === "main") continue
        if (taken(name, isFunction)) clashes.set(name, name + "_")
    }

    // ---------- the entry point ----------

    let colour = "fragColor"
    /** The mainImage parameter that is Shadertoy's pixel position, when it is not called fragCoord. */
    let coordParam: string | null = null
    let entry: { header: [number, number]; open: number; close: number } | null = null
    /** A WebGL2 style `out vec4 name;` at the top level, which becomes the local instead. */
    let outDecl: [number, number] | null = null
    for (let i = 0; i < toks.length; i++) {
        if (!is(i, "void")) continue
        const n = skip(i + 1)
        const name = toks[n]?.text
        if (name !== "mainImage" && name !== "main") continue
        const open = skip(n + 1)
        if (!is(open, "(")) continue
        const close = closing(open)
        const body = skip(close + 1)
        if (!is(body, "{")) continue
        if (name === "mainImage") {
            for (const [a, b] of args(open, close)) {
                const words = toks.slice(a, b).filter((t) => t.kind === "ident").map((t) => t.text)
                const pname = words[words.length - 1]
                if (pname === undefined) continue
                if (words.includes("vec4")) colour = pname
                else if (words.includes("vec2") && pname !== "fragCoord") coordParam = pname
            }
        }
        entry = { header: [i, close + 1], open: body, close: closing(body) }
        // Its pixel position is the input, not a clash with it.
        if (name === "mainImage") clashes.delete("fragCoord")
        break
    }
    if (entry === null) {
        notes.push("there is no mainImage or main to convert; add `float4 main() { ... }` returning the colour")
    }
    for (let i = 0; i < toks.length; i++) {
        if (!is(i, "out")) continue
        const t = skip(i + 1)
        const n = skip(t + 1)
        const semi = skip(n + 1)
        if (is(t, "vec4") && toks[n]?.kind === "ident" && is(semi, ";") && (entry === null || i < entry.header[0])) {
            colour = toks[n]!.text
            outDecl = [i, semi + 1]
            break
        }
    }

    // ---------- the rewrite ----------

    const textures = new Set<string>()
    let mouse = false
    let uvDropped = false

    /** Tokens `from` to `to`, converted. */
    const emit = (from: number, to: number, inEntry: boolean): string => {
        let out = ""
        for (let i = from; i < to; i++) {
            const t = toks[i]!
            if (t.kind === "directive") { out += directive(t); continue }
            if (t.kind === "number") { out += t.text.replace(/[uU]$/, ""); continue }
            if (t.kind !== "ident") { out += t.text; continue }

            const name = t.text
            const prev = back(i - 1)
            if (is(prev, ".")) { out += name; continue }
            const next = skip(i + 1)
            const called = is(next, "(")

            if (name === "precision") {
                // `precision mediump float;` means nothing outside GLSL ES.
                let j = i
                while (j < to && !is(j, ";")) j++
                i = skip(j + 1) - 1
                continue
            }
            if (name === "highp" || name === "mediump" || name === "lowp" || (name === "in" && inParams(i))) {
                i = skip(i + 1) - 1
                continue
            }
            if (name === "out" || name === "inout") {
                note(t.line, `${name} parameters do not exist here; return the value instead`)
                out += name
                continue
            }
            if (name === "uniform" && is(skip(i + 1), "sampler2D")) {
                // `uniform sampler2D tex;` is `texture2D tex;`.
                out += "texture2D"
                i = skip(i + 1)
                continue
            }
            if (name === "sampler2D") { out += "texture2D"; continue }
            if (inEntry && coordParam !== null && name === coordParam) { out += "fragCoord"; continue }
            if (inEntry && name === "gl_FragColor") { out += colour; continue }
            const clash = clashes.get(name)
            if (clash !== undefined) {
                noteOnce("clash:" + name, t.line, `${name} is renamed ${clash}, since ${name} already means something here`)
                out += clash
                continue
            }
            if (RENAME[name] !== undefined && !(name === "texture" && !called)) {
                if (name === "gl_FragCoord" && !is(next, ".")) note(t.line, "gl_FragCoord is a vec4 in GLSL and fragCoord is a float2 here")
                out += RENAME[name]
                continue
            }
            if (NARROW[name] !== undefined) {
                // A for loop's counter is the one int the language has.
                const forCounter = name === "int" && is(back(i - 1), "(") && is(back(back(i - 1) - 1), "for")
                if (forCounter) { out += name; continue }
                const [to2, why] = NARROW[name]!
                noteOnce("narrow:" + name, t.line, why)
                out += to2
                continue
            }
            if (/^iChannel\d$/.test(name)) { textures.add(name); out += name; continue }
            if (name === "iMouse") {
                mouse = true
                noteOnce("mouse", t.line, "iMouse is the uniform mouse, which the host sets; Shadertoy's sign encoding of clicks is not carried over")
                out += "mouse"
                continue
            }
            if (name === "iResolution") {
                const dot = is(next, ".") ? skip(next + 1) : -1
                const member = dot >= 0 ? toks[dot]?.text ?? null : null
                if (member === null) {
                    out += "float3(resolution, 1.0)"
                } else if (/^[xy]+$/.test(member)) {
                    out += "resolution"
                } else {
                    note(t.line, `iResolution.${member}: resolution is a float2 here, and the third component was always 1`)
                    out += "resolution"
                }
                continue
            }
            if (MISSING[name] !== undefined) {
                note(t.line, `${name} has no counterpart: ${MISSING[name]}`)
                out += name
                continue
            }
            if (name === "void" && !functions.has(toks[skip(i + 1)]?.text ?? "")) { out += name; continue }
            if (name === "void") {
                note(t.line, `${toks[skip(i + 1)]!.text} returns nothing, and every function here returns a value`)
                out += name
                continue
            }

            if (called) {
                const close = closing(next)
                const a = args(next, close).map(([x, y]) => emit(x, y, inEntry).trim())
                const wrap = (s: string) => (/^[\w.]+$/.test(s) || /^[\w.]+\(.*\)$/.test(s) ? s : `(${s})`)
                let call: string | null = null
                if (name === "mod" && a.length === 2) {
                    // GLSL's mod floors; % and fmod truncate. Written out, so negative values stay right.
                    call = `(${wrap(a[0]!)} - ${wrap(a[1]!)} * floor(${wrap(a[0]!)} / ${wrap(a[1]!)}))`
                } else if (name === "atan" && a.length === 2) {
                    call = `atan2(${a[0]}, ${a[1]})`
                } else if (name === "atan" && a.length === 1) {
                    call = `atan2(${a[0]}, 1.0)`
                } else if (name === "inversesqrt" && a.length === 1) {
                    call = `(1.0 / sqrt(${a[0]}))`
                } else if (name === "radians" && a.length === 1) {
                    call = `(${wrap(a[0]!)} * 0.017453292519943295)`
                } else if (name === "degrees" && a.length === 1) {
                    call = `(${wrap(a[0]!)} * 57.29577951308232)`
                } else if (name === "exp2" && a.length === 1) {
                    call = `pow(2.0, ${a[0]})`
                } else if (name === "log2" && a.length === 1) {
                    call = `(log(${a[0]}) * 1.4426950408889634)`
                }
                if (call !== null) { out += call; i = close; continue }
            }
            out += name
        }
        return out
    }

    /** Whether the token at `i` is inside a function's parameter list. */
    function inParams(i: number): boolean {
        let depth = 0
        for (let j = i - 1; j >= 0; j--) {
            const t = toks[j]!
            if (t.kind !== "punct") continue
            if (t.text === ")") depth++
            else if (t.text === "(") { if (depth === 0) return toks[back(j - 1)]?.kind === "ident"; depth-- }
            else if (t.text === ";" || t.text === "{" || t.text === "}") return false
        }
        return false
    }

    /**
     * `#define NAME value` becomes a const, typed by a leading constructor
     * (`vec3(...)` is a float3) and a float otherwise; a macro with parameters
     * and any other directive are kept as a comment.
     */
    function directive(t: Tok): string {
        const define = /^#\s*define\s+([A-Za-z_]\w*)\s+(.+?)\s*$/s.exec(t.text)
        if (define !== null && !/^\(/.test(t.text.slice(t.text.indexOf(define[1]!) + define[1]!.length))) {
            const value = define[2]!.replace(/\\\n/g, " ").replace(/\b(vec[234]|mix|fract|iTime|iGlobalTime)\b/g, (w) => RENAME[w]!)
            const type = /^\s*(float[234])\s*\(/.exec(value)?.[1] ?? "float"
            return `const ${type} ${define[1]} = ${value};`
        }
        const guard = /^#\s*(ifdef|ifndef|if|else|elif|endif)\b/.test(t.text) && /GL_ES|^#\s*(else|endif)/.test(t.text)
        if (!guard) note(t.line, `${t.text.trim()} has no counterpart, since there is no preprocessor; it is kept as a comment`)
        return "// " + t.text
    }

    // The entry point: its header, a local for the colour, the colour returned.
    let body: string
    if (entry === null) {
        body = emit(0, toks.length, false)
    } else {
        const { header, open, close } = entry
        // In file order, so a note names the first line a name is on.
        const before = outDecl === null ? emit(0, header[0], false) : emit(0, outDecl[0], false) + emit(outDecl[1], header[0], false)
        const inner = emit(open + 1, close, true)
            .replace(/\breturn\s*;/g, `return ${colour};`)
            // Shadertoy's own uv, which is exactly the input: y up, 0 to 1 across the element.
            .replace(/\n?[ \t]*float2\s+uv_\s*=\s*fragCoord(\.xy)?\s*\/\s*resolution(\.xy)?\s*;[ \t]*/, () => {
                uvDropped = true
                return ""
            })
        const indent = /\n([ \t]+)\S/.exec(inner)?.[1] ?? "    "
        body = before + "float4 main()" + emit(header[1], open, true) + "{\n" + indent +
            `float4 ${colour} = float4(0.0);` + inner.replace(/\s*$/, "") + "\n" + indent + `return ${colour};\n}` +
            emit(close + 1, toks.length, false)
    }
    // Shadertoy's own uv line is exactly the input, so it goes, and the name is the input's again.
    if (uvDropped) {
        body = body.replace(/\buv_\b/g, "uv")
        const renamed = notes.findIndex((n) => n.includes("uv is renamed uv_"))
        if (renamed >= 0) notes.splice(renamed, 1)
        const at = toks.findIndex((t, i) => t.text === "uv" && is(back(i - 1), "vec2"))
        note(at >= 0 ? toks[at]!.line : 1, "the uv line is dropped: fragCoord / resolution is the input uv, y up")
    }

    const declared = [...textures].sort().map((t) => `texture2D ${t};`)
    if (mouse) declared.unshift("uniform float4 mouse;")
    const source = (declared.length > 0 ? declared.join("\n") + "\n" : "") + body.replace(/^\n+/, "")
    const lineOf = (n: string) => Number(/^line (\d+)/.exec(n)?.[1] ?? 0)
    notes.sort((a, b) => lineOf(a) - lineOf(b))
    return { source, notes, errors: diagnose(source, { file: options.file ?? "program.sl" }) }
}
