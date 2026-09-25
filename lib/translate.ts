/**
 * The library translator: reads the helper library in `lib/*.hlsl` and prints
 * it as GLSL ES 3.00, as WGSL, and as the HLSL/Metal shared subset.
 *
 * Build time only. `lib/generate.ts` runs this over the three files and checks
 * the result in under `src/lib/`, and a test fails when regenerating changes a
 * byte. Nothing at runtime parses HLSL.
 *
 * The input is a SUBSET of HLSL, and anything outside it is an error with a
 * file and line rather than a guess:
 *
 *   - functions returning `float`, `float2..4` or `int`, with `in` or no
 *     qualifier on parameters (never `out`/`inout`), and overloads told apart
 *     by their parameter types;
 *   - locals (`const` allowed, several declarators per line allowed), `=` and
 *     the four compound assignments, onto a variable or a swizzle of one;
 *   - `if`/`else`, `for (int i = a; cond; i++)` with an optional `[unroll]`,
 *     `break`, `return`, and `switch` whose cases end in `return` or `break`;
 *   - arithmetic, comparison, `&&`/`||`/`!`, the ternary, `(int)` casts,
 *     constructors, swizzles, and the intrinsics in `BUILTINS`;
 *   - `mul(v, float2x2(a, b, c, d))`, the row vector rotation, and no other
 *     use of a matrix;
 *   - one piece of preprocessor, `#ifdef UNITY_COLORSPACE_GAMMA` / `#else` /
 *     `#endif` around functions, which becomes the target's colour setting.
 *
 * HLSL converts silently where GLSL ES and WGSL refuse, so the checker makes
 * every conversion explicit before anything is printed: an int where a float
 * is needed, and a scalar where an intrinsic wants a vector. The printers then
 * differ only in spelling. The shared subset gets the same treatment, because
 * Metal is stricter than HLSL too, and it drops what Metal has no word for:
 * `in`, `[unroll]` and `mul`.
 */

export type Lang = "glsl" | "wgsl" | "hlsl"
export type Ty = "float" | "float2" | "float3" | "float4" | "int" | "bool"
export type Colour = "gamma" | "linear"

export class TranslateError extends Error {}

// MARK: lexer

interface Tok { t: "id" | "num" | "p" | "pp" | "eof"; v: string; line: number }

const PUNCT = ["++", "--", "+=", "-=", "*=", "/=", "==", "!=", "<=", ">=", "&&", "||"]

function lex(src: string, file: string): Tok[] {
    const out: Tok[] = []
    let i = 0
    let line = 1
    let lineStart = true
    const fail = (msg: string): never => { throw new TranslateError(`${file}:${line}: ${msg}`) }
    while (i < src.length) {
        const c = src[i]!
        if (c === "\n") { line++; i++; lineStart = true; continue }
        if (c === " " || c === "\t" || c === "\r") { i++; continue }
        if (src.startsWith("//", i)) { while (i < src.length && src[i] !== "\n") i++; continue }
        if (src.startsWith("/*", i)) {
            const end = src.indexOf("*/", i + 2)
            if (end < 0) fail("unterminated comment")
            for (let j = i; j < end; j++) if (src[j] === "\n") line++
            i = end + 2
            continue
        }
        if (c === "#") {
            if (!lineStart) fail("a preprocessor line must start its line")
            let j = i
            while (j < src.length && src[j] !== "\n") j++
            out.push({ t: "pp", v: src.slice(i, j).trim(), line })
            i = j
            continue
        }
        lineStart = false
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1
            while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++
            out.push({ t: "id", v: src.slice(i, j), line })
            i = j
            continue
        }
        const prev = out[out.length - 1]
        const afterValue = prev !== undefined && (prev.t === "id" || prev.t === "num" || prev.v === ")" || prev.v === "]")
        if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? "") && !afterValue)) {
            const m = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!
            const after = src[i + m[0].length] ?? ""
            if (/[A-Za-z_]/.test(after)) fail(`a literal suffix (${m[0]}${after}) is outside the subset: write the plain number`)
            out.push({ t: "num", v: m[0], line })
            i += m[0].length
            continue
        }
        const two = src.slice(i, i + 2)
        if (PUNCT.includes(two)) { out.push({ t: "p", v: two, line }); i += 2; continue }
        if ("+-*/<>=!?:;,.(){}[]%".includes(c)) { out.push({ t: "p", v: c, line }); i++; continue }
        fail(`unexpected character "${c}"`)
    }
    out.push({ t: "eof", v: "", line })
    return out
}

// MARK: syntax tree

export type Expr =
    | { k: "num"; text: string; int: boolean; line: number; ty?: Ty }
    | { k: "id"; name: string; line: number; ty?: Ty }
    | { k: "member"; obj: Expr; field: string; line: number; ty?: Ty }
    | { k: "call"; name: string; args: Expr[]; line: number; ty?: Ty; fn?: number; ctor?: boolean }
    | { k: "cast"; to: Ty; e: Expr; line: number; ty?: Ty }
    | { k: "unary"; op: "-" | "!"; e: Expr; line: number; ty?: Ty }
    | { k: "binary"; op: string; l: Expr; r: Expr; line: number; ty?: Ty }
    | { k: "ternary"; c: Expr; t: Expr; f: Expr; line: number; ty?: Ty }
    | { k: "paren"; e: Expr; line: number; ty?: Ty }
    /** Inserted by the checker: `e` at type `ty`, a conversion HLSL makes silently. */
    | { k: "conv"; e: Expr; line: number; ty: Ty }

export type Stmt =
    | { k: "decl"; ty: Ty; name: string; init?: Expr; isConst: boolean; line: number }
    | { k: "assign"; target: Expr; op: string; value: Expr; line: number }
    | { k: "if"; c: Expr; then: Stmt[]; else?: Stmt[]; line: number }
    | { k: "for"; name: string; init: Expr; c: Expr; body: Stmt[]; line: number }
    | { k: "switch"; sel: Expr; cases: Array<{ value: number | "default"; body: Stmt[] }>; line: number }
    | { k: "break"; line: number }
    | { k: "return"; e: Expr; line: number }
    | { k: "block"; body: Stmt[]; line: number }

export interface Param { name: string; ty: Ty; assigned: boolean }

export interface Fn {
    name: string
    ret: Ty
    params: Param[]
    body: Stmt[]
    colour?: Colour
    file: string
    line: number
}

const VALUE_TYPES = new Set(["float", "float2", "float3", "float4", "int"])
const WIDTH: Record<Ty, number> = { float: 1, float2: 2, float3: 3, float4: 4, int: 1, bool: 1 }
const floatOf = (w: number): Ty => (w === 1 ? "float" : (`float${w}` as Ty))

// MARK: parser

class Parser {
    private i = 0
    constructor(private toks: Tok[], private file: string) {}

    private get tok(): Tok { return this.toks[this.i]! }
    private peek(n = 1): Tok { return this.toks[Math.min(this.i + n, this.toks.length - 1)]! }
    private fail(msg: string, line = this.tok.line): never { throw new TranslateError(`${this.file}:${line}: ${msg}`) }
    private is(v: string): boolean { return this.tok.t !== "num" && this.tok.v === v }
    private eat(v: string): Tok {
        if (!this.is(v)) this.fail(`expected "${v}", found "${this.tok.v || "end of file"}"`)
        return this.toks[this.i++]!
    }
    private ident(): string {
        if (this.tok.t !== "id") this.fail(`expected a name, found "${this.tok.v}"`)
        return this.toks[this.i++]!.v
    }

    file_(): Fn[] {
        const fns: Fn[] = []
        let colour: Colour | undefined
        let opened = 0
        while (this.tok.t !== "eof") {
            if (this.tok.t === "pp") {
                const d = this.tok.v.replace(/\s+/g, " ")
                if (d === "#ifdef UNITY_COLORSPACE_GAMMA" && colour === undefined) { colour = "gamma"; opened = this.tok.line }
                else if (d === "#else" && colour === "gamma") colour = "linear"
                else if (d === "#endif" && colour === "linear") colour = undefined
                else this.fail(`"${d}" is outside the subset: the one conditional is #ifdef UNITY_COLORSPACE_GAMMA / #else / #endif`)
                this.i++
                continue
            }
            fns.push(this.fn(colour))
        }
        if (colour !== undefined) this.fail("#ifdef UNITY_COLORSPACE_GAMMA is not closed", opened)
        return fns
    }

    private fn(colour: Colour | undefined): Fn {
        const line = this.tok.line
        const ret = this.ident()
        if (!VALUE_TYPES.has(ret)) this.fail(`a top level declaration must be a function returning float, float2..4 or int, not "${ret}"`, line)
        const name = this.ident()
        this.eat("(")
        const params: Param[] = []
        while (!this.is(")")) {
            if (params.length > 0) this.eat(",")
            if (this.is("out") || this.is("inout")) this.fail(`"${this.tok.v}" parameters are outside the subset`)
            if (this.is("in")) this.i++
            const ty = this.ident()
            if (!VALUE_TYPES.has(ty)) this.fail(`a parameter must be float, float2..4 or int, not "${ty}"`)
            params.push({ name: this.ident(), ty: ty as Ty, assigned: false })
        }
        this.eat(")")
        return { name, ret: ret as Ty, params, body: this.block(), colour, file: this.file, line }
    }

    private block(): Stmt[] {
        this.eat("{")
        const body: Stmt[] = []
        while (!this.is("}")) body.push(this.stmt())
        this.eat("}")
        return body
    }

    /** A statement as a list, so `if (c) x = 1;` and `if (c) { ... }` look alike. */
    private body(): Stmt[] {
        return this.is("{") ? this.block() : [this.stmt()]
    }

    private stmt(): Stmt {
        const line = this.tok.line
        if (this.tok.t === "pp") this.fail("preprocessor inside a function is outside the subset")
        if (this.is("{")) return { k: "block", body: this.block(), line }
        if (this.is("[")) {
            this.eat("[")
            if (this.ident() !== "unroll") this.fail("the only attribute in the subset is [unroll]", line)
            if (this.is("(")) { this.eat("("); if (this.tok.t !== "num") this.fail("expected an unroll count"); this.i++; this.eat(")") }
            this.eat("]")
            if (!this.is("for")) this.fail("[unroll] must come before a for loop")
            return this.stmt()
        }
        if (this.is("if")) {
            this.i++
            this.eat("(")
            const c = this.expr()
            this.eat(")")
            const then = this.body()
            if (this.is("else")) { this.i++; return { k: "if", c, then, else: this.body(), line } }
            return { k: "if", c, then, line }
        }
        if (this.is("for")) {
            this.i++
            this.eat("(")
            if (!this.is("int")) this.fail("a for loop's counter must be declared int in the loop")
            this.i++
            const name = this.ident()
            this.eat("=")
            const init = this.expr()
            this.eat(";")
            const c = this.expr()
            this.eat(";")
            if (this.ident() !== name || !this.is("++")) this.fail(`a for loop must step with ${name}++`)
            this.i++
            this.eat(")")
            return { k: "for", name, init, c, body: this.body(), line }
        }
        if (this.is("switch")) {
            this.i++
            this.eat("(")
            const sel = this.expr()
            this.eat(")")
            this.eat("{")
            const cases: Array<{ value: number | "default"; body: Stmt[] }> = []
            while (!this.is("}")) {
                let value: number | "default"
                if (this.is("default")) { this.i++; value = "default" }
                else {
                    this.eat("case")
                    const neg = this.is("-") ? (this.i++, -1) : 1
                    if (this.tok.t !== "num" || !/^[0-9]+$/.test(this.tok.v)) this.fail("a case label must be an integer literal")
                    value = neg * Number(this.toks[this.i++]!.v)
                }
                this.eat(":")
                const body: Stmt[] = []
                while (!this.is("case") && !this.is("default") && !this.is("}")) body.push(this.stmt())
                const last = body[body.length - 1]
                if (last === undefined || (last.k !== "return" && last.k !== "break")) {
                    this.fail("a case must end in return or break: falling through is outside the subset")
                }
                cases.push({ value, body })
            }
            this.eat("}")
            return { k: "switch", sel, cases, line }
        }
        if (this.is("break")) { this.i++; this.eat(";"); return { k: "break", line } }
        if (this.is("return")) { this.i++; const e = this.expr(); this.eat(";"); return { k: "return", e, line } }
        if (this.is("static") || this.is("out") || this.is("inout")) this.fail(`"${this.tok.v}" is outside the subset`)
        const isConst = this.is("const")
        if (isConst) this.i++
        if (this.tok.t === "id" && VALUE_TYPES.has(this.tok.v) && this.peek().t === "id") {
            const ty = this.ident() as Ty
            const decls: Stmt[] = []
            do {
                if (decls.length > 0) this.eat(",")
                const name = this.ident()
                let init: Expr | undefined
                if (this.is("=")) { this.i++; init = this.expr() }
                else if (isConst) this.fail(`const ${name} needs a value`)
                decls.push({ k: "decl", ty, name, init, isConst, line })
            } while (this.is(","))
            this.eat(";")
            return decls.length === 1 ? decls[0]! : { k: "block", body: decls, line: -1 }
        }
        if (isConst) this.fail("expected a declaration after const")
        const target = this.postfix()
        if (!["=", "+=", "-=", "*=", "/="].includes(this.tok.v)) this.fail(`expected an assignment, found "${this.tok.v}"`)
        const op = this.toks[this.i++]!.v
        const value = this.expr()
        this.eat(";")
        return { k: "assign", target, op, value, line }
    }

    expr(): Expr {
        const c = this.binary(1)
        if (!this.is("?")) return c
        const line = this.tok.line
        this.i++
        const t = this.expr()
        this.eat(":")
        return { k: "ternary", c, t, f: this.expr(), line }
    }

    private static PREC: Record<string, number> = {
        "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
    }

    private binary(min: number): Expr {
        let l = this.unary()
        for (;;) {
            const p = this.tok.t === "p" ? Parser.PREC[this.tok.v] : undefined
            if (p === undefined || p < min) return l
            const op = this.tok.v
            const line = this.tok.line
            this.i++
            l = { k: "binary", op, l, r: this.binary(p + 1), line }
        }
    }

    private unary(): Expr {
        const line = this.tok.line
        if (this.is("-") || this.is("!")) {
            const op = this.toks[this.i++]!.v as "-" | "!"
            return { k: "unary", op, e: this.unary(), line }
        }
        if (this.is("+")) { this.i++; return this.unary() }
        if (this.is("(") && this.peek().t === "id" && VALUE_TYPES.has(this.peek().v) && this.peek(2).v === ")") {
            this.i++
            const to = this.ident() as Ty
            this.eat(")")
            return { k: "cast", to, e: this.unary(), line }
        }
        return this.postfix()
    }

    private postfix(): Expr {
        let e = this.primary()
        while (this.is(".")) {
            const line = this.tok.line
            this.i++
            e = { k: "member", obj: e, field: this.ident(), line }
        }
        return e
    }

    private primary(): Expr {
        const tok = this.tok
        const line = tok.line
        if (tok.t === "num") { this.i++; return { k: "num", text: tok.v, int: /^[0-9]+$/.test(tok.v), line } }
        if (this.is("(")) { this.i++; const e = this.expr(); this.eat(")"); return { k: "paren", e, line } }
        if (tok.t === "id") {
            this.i++
            if (!this.is("(")) return { k: "id", name: tok.v, line }
            this.i++
            const args: Expr[] = []
            while (!this.is(")")) {
                if (args.length > 0) this.eat(",")
                args.push(this.expr())
            }
            this.eat(")")
            return { k: "call", name: tok.v, args, line }
        }
        return this.fail(`unexpected "${tok.v || "end of file"}"`)
    }
}

export function parseLibrary(src: string, file: string): Fn[] {
    return new Parser(lex(src, file), file).file_()
}

// MARK: checker

/**
 * The intrinsics in the subset. `kind` is how the result's type follows from
 * the arguments; `ints` marks the ones that stay integer on integer arguments.
 * GLSL and WGSL spellings are given where they differ from HLSL's.
 */
const BUILTINS: Record<string, { kind: "unary" | "binary" | "ternary" | "length" | "distance" | "dot"; ints?: boolean; glsl?: string; wgsl?: string }> = {
    abs: { kind: "unary", ints: true },
    sign: { kind: "unary" },
    floor: { kind: "unary" },
    ceil: { kind: "unary" },
    round: { kind: "unary" },
    frac: { kind: "unary", glsl: "fract", wgsl: "fract" },
    sqrt: { kind: "unary" },
    sin: { kind: "unary" },
    cos: { kind: "unary" },
    tan: { kind: "unary" },
    asin: { kind: "unary" },
    acos: { kind: "unary" },
    atan: { kind: "unary" },
    exp: { kind: "unary" },
    log: { kind: "unary" },
    saturate: { kind: "unary" },
    normalize: { kind: "unary" },
    min: { kind: "binary", ints: true },
    max: { kind: "binary", ints: true },
    pow: { kind: "binary" },
    step: { kind: "binary" },
    atan2: { kind: "binary", glsl: "atan" },
    clamp: { kind: "ternary", ints: true },
    lerp: { kind: "ternary", glsl: "mix", wgsl: "mix" },
    length: { kind: "length" },
    distance: { kind: "distance" },
    dot: { kind: "dot" },
}

interface Sym { ty: Ty; param?: Param; loop?: boolean; assigned: boolean }

export interface Checked {
    fns: Fn[]
    /** Each function's callees, as indices into `fns`, both colours together. */
    deps: number[][]
    /** Which functions share a name with another signature (WGSL has no overloading). */
    overloaded: Set<string>
    /** Locals and parameters that are ever assigned, per function (WGSL `var`). */
    assigned: Array<Set<string>>
}

/** A function's identity: its name and parameter types. Both colours of one share it. */
export const keyOf = (fn: { name: string; params: Array<{ ty: Ty }> }): string =>
    `${fn.name}(${fn.params.map((p) => p.ty).join(", ")})`

export function check(fns: Fn[]): Checked {
    const byName = new Map<string, number[]>()
    const keys = new Map<string, number[]>()
    fns.forEach((fn, i) => {
        byName.set(fn.name, [...(byName.get(fn.name) ?? []), i])
        keys.set(keyOf(fn), [...(keys.get(keyOf(fn)) ?? []), i])
    })
    for (const [key, list] of keys) {
        const colours = list.map((i) => fns[i]!.colour)
        const ok = list.length === 1 ? colours[0] === undefined : list.length === 2 && colours.includes("gamma") && colours.includes("linear")
        if (!ok) {
            const fn = fns[list[0]!]!
            throw new TranslateError(
                `${fn.file}:${fn.line}: ${key} is defined ${list.length} times. A signature appears once, ` +
                `or once in each branch of the colour switch.`,
            )
        }
        if (list.length === 2 && fns[list[0]!]!.ret !== fns[list[1]!]!.ret) {
            throw new TranslateError(`${key} returns different types in its two colour branches`)
        }
    }
    const overloaded = new Set([...byName].filter(([, l]) => new Set(l.map((i) => keyOf(fns[i]!))).size > 1).map(([n]) => n))
    const deps: number[][] = []
    const assigned: Array<Set<string>> = []

    fns.forEach((fn, index) => {
        const fail = (line: number, msg: string): never => { throw new TranslateError(`${fn.file}:${line}: ${msg}`) }
        const scopes: Array<Map<string, Sym>> = [new Map(fn.params.map((p) => [p.name, { ty: p.ty, param: p, assigned: false }]))]
        const calls = new Set<number>()
        const written = new Set<string>()
        let loops = 0
        let switches = 0

        const lookup = (name: string, line: number): Sym => {
            for (let s = scopes.length - 1; s >= 0; s--) {
                const sym = scopes[s]!.get(name)
                if (sym !== undefined) return sym
            }
            return fail(line, `"${name}" is not declared`)
        }
        const declare = (name: string, sym: Sym, line: number) => {
            if (scopes[scopes.length - 1]!.has(name)) fail(line, `"${name}" is declared twice in one scope`)
            scopes[scopes.length - 1]!.set(name, sym)
        }

        /** Converts `e` (already typed) to `want`, or refuses a conversion HLSL would make with a loss. */
        const to = (e: Expr, want: Ty, line: number, what: string): Expr => {
            const have = e.ty!
            if (have === want) return e
            if (have === "int" && want === "float") return { k: "conv", e, line, ty: "float" }
            if ((have === "float" || have === "int") && want !== "int" && want !== "bool" && WIDTH[want] > 1) {
                return { k: "conv", e: to(e, "float", line, what), line, ty: want }
            }
            return fail(line, `${what}: a ${have} where a ${want} is needed. The subset converts only int to float and a scalar to a vector.`)
        }

        const expr = (e: Expr): Expr => {
            switch (e.k) {
                case "num": e.ty = e.int ? "int" : "float"; return e
                case "id": e.ty = lookup(e.name, e.line).ty; return e
                case "paren": e.e = expr(e.e); e.ty = e.e.ty; return e
                case "conv": return e
                case "member": {
                    e.obj = expr(e.obj)
                    const w = WIDTH[e.obj.ty!]
                    if (!e.obj.ty!.startsWith("float") || w === 1) fail(e.line, `a swizzle of a ${e.obj.ty} is outside the subset`)
                    const set = /^[xyzw]+$/.test(e.field) ? "xyzw" : /^[rgba]+$/.test(e.field) ? "rgba" : ""
                    if (set === "" || e.field.length > 4) fail(e.line, `".${e.field}" is not a swizzle`)
                    for (const c of e.field) if (set.indexOf(c) >= w) fail(e.line, `".${e.field}" reads past the end of a ${e.obj.ty}`)
                    e.ty = floatOf(e.field.length)
                    return e
                }
                case "cast": {
                    e.e = expr(e.e)
                    if (WIDTH[e.e.ty!] !== 1 || e.e.ty === "bool" || WIDTH[e.to] !== 1) fail(e.line, "only a scalar cast to a scalar is in the subset")
                    e.ty = e.to
                    return e
                }
                case "unary": {
                    e.e = expr(e.e)
                    if (e.op === "!" ? e.e.ty !== "bool" : e.e.ty === "bool") fail(e.line, `"${e.op}" on a ${e.e.ty}`)
                    e.ty = e.e.ty
                    return e
                }
                case "binary": {
                    e.l = expr(e.l)
                    e.r = expr(e.r)
                    const [l, r] = [e.l.ty!, e.r.ty!]
                    if (e.op === "&&" || e.op === "||") {
                        if (l !== "bool" || r !== "bool") fail(e.line, `"${e.op}" takes two conditions`)
                        e.ty = "bool"
                        return e
                    }
                    if (l === "bool" || r === "bool") fail(e.line, `"${e.op}" on a condition`)
                    if (e.op === "%") fail(e.line, `"%" is outside the subset: HLSL's truncates and GLSL's mod floors. Write glslMod or the formula`)
                    const comparison = ["<", ">", "<=", ">=", "==", "!="].includes(e.op)
                    if (l !== r && l === "int") e.l = to(e.l, "float", e.line, `the left of "${e.op}"`)
                    if (l !== r && r === "int") e.r = to(e.r, "float", e.line, `the right of "${e.op}"`)
                    const [lw, rw] = [WIDTH[l], WIDTH[r]]
                    if (comparison) {
                        if (lw !== 1 || rw !== 1) fail(e.line, `"${e.op}" compares scalars only in the subset`)
                        e.ty = "bool"
                        return e
                    }
                    if (lw !== rw && lw !== 1 && rw !== 1) fail(e.line, `"${e.op}" between a ${l} and a ${r}`)
                    e.ty = l === "int" && r === "int" ? "int" : floatOf(Math.max(lw, rw))
                    return e
                }
                case "ternary": {
                    e.c = expr(e.c)
                    if (e.c.ty !== "bool") fail(e.line, "a ternary's condition must be a comparison")
                    e.t = expr(e.t)
                    e.f = expr(e.f)
                    const [t, f] = [e.t.ty!, e.f.ty!]
                    if (t === f) { e.ty = t; return e }
                    if (WIDTH[t] === 1 && WIDTH[f] === 1 && t !== "bool" && f !== "bool") {
                        e.t = to(e.t, "float", e.line, "a ternary branch")
                        e.f = to(e.f, "float", e.line, "a ternary branch")
                        e.ty = "float"
                        return e
                    }
                    return fail(e.line, `a ternary's branches are a ${t} and a ${f}`)
                }
                case "call": return call(e)
            }
        }

        const call = (e: Extract<Expr, { k: "call" }>): Expr => {
            if (e.name === "mul") return mul(e)
            if (e.name === "float2x2") fail(e.line, "a float2x2 is in the subset only as mul's second argument")
            e.args = e.args.map(expr)
            if (VALUE_TYPES.has(e.name)) {
                // A constructor. One scalar makes a scalar (the conversion
                // itself); otherwise the components must add up exactly, since
                // HLSL refuses float3(x) and Metal refuses x.xxx.
                e.ctor = true
                e.ty = e.name as Ty
                const w = WIDTH[e.ty]
                if (w === 1) {
                    if (e.args.length !== 1 || WIDTH[e.args[0]!.ty!] !== 1) fail(e.line, `${e.name}(...) takes one scalar`)
                    return e
                }
                let n = 0
                e.args = e.args.map((a) => {
                    if (a.ty === "bool") fail(e.line, `${e.name}(...) of a condition`)
                    n += WIDTH[a.ty!]
                    return a.ty === "int" ? to(a, "float", e.line, `an argument of ${e.name}`) : a
                })
                if (n !== w) fail(e.line, `${e.name}(...) is given ${n} components`)
                return e
            }
            const b = BUILTINS[e.name]
            if (b !== undefined) return builtin(e, b)
            const candidates = (byName.get(e.name) ?? []).filter((i) => fns[i]!.params.length === e.args.length)
            if (candidates.length === 0) fail(e.line, byName.has(e.name) ? `no ${e.name} takes ${e.args.length} arguments` : `"${e.name}" is neither a library function nor an intrinsic in the subset`)
            // Exact matches first; an int argument may then stand for a float
            // parameter. Two colours of one signature count once.
            const cost = (i: number) => fns[i]!.params.reduce((sum, p, j) => {
                const a = e.args[j]!.ty!
                return sum + (a === p.ty ? 0 : a === "int" && p.ty === "float" ? 1 : Infinity)
            }, 0)
            const scored = candidates.map((i) => ({ i, c: cost(i) })).filter((s) => s.c < Infinity)
            const best = Math.min(...scored.map((s) => s.c))
            const winners = [...new Set(scored.filter((s) => s.c === best).map((s) => keyOf(fns[s.i]!)))]
            if (winners.length !== 1) fail(e.line, `${e.name}(${e.args.map((a) => a.ty).join(", ")}) matches ${winners.length === 0 ? "no" : "more than one"} signature`)
            const target = scored.find((s) => s.c === best)!.i
            for (const i of keys.get(keyOf(fns[target]!))!) {
                if (i === index) fail(e.line, `${e.name} calls itself; recursion is outside the subset`)
                if (i > index) fail(e.line, `${e.name} is called before it is defined`)
                calls.add(i)
            }
            e.fn = target
            e.args = e.args.map((a, j) => to(a, fns[target]!.params[j]!.ty, e.line, `argument ${j + 1} of ${e.name}`))
            e.ty = fns[target]!.ret
            return e
        }

        const builtin = (e: Extract<Expr, { k: "call" }>, b: (typeof BUILTINS)[string]): Expr => {
            const arity = { unary: 1, binary: 2, ternary: 3, length: 1, distance: 2, dot: 2 }[b.kind]
            if (e.args.length !== arity) fail(e.line, `${e.name} takes ${arity} arguments`)
            for (const a of e.args) if (a.ty === "bool") fail(e.line, `${e.name} of a condition`)
            if (b.kind === "length" || b.kind === "distance" || b.kind === "dot") {
                const w = WIDTH[e.args[0]!.ty!]
                if (w === 1 || e.args.some((a) => a.ty !== e.args[0]!.ty)) fail(e.line, `${e.name} takes vectors of one width`)
                e.ty = "float"
                return e
            }
            const w = Math.max(...e.args.map((a) => WIDTH[a.ty!]))
            for (const a of e.args) if (WIDTH[a.ty!] !== 1 && WIDTH[a.ty!] !== w) fail(e.line, `${e.name} mixes a ${a.ty} with a width ${w}`)
            if (e.name === "normalize" && w === 1) fail(e.line, "normalize of a scalar")
            const ints = b.ints === true && e.args.every((a) => a.ty === "int")
            e.ty = ints ? "int" : floatOf(w)
            e.args = e.args.map((a, j) => to(a, e.ty!, e.line, `argument ${j + 1} of ${e.name}`))
            return e
        }

        /** `mul(v, float2x2(a, b, c, d))`, the row vector product, written out. */
        const mul = (e: Extract<Expr, { k: "call" }>): Expr => {
            const m = e.args[1]
            if (e.args.length !== 2 || m?.k !== "call" || m.name !== "float2x2" || m.args.length !== 4) {
                fail(e.line, "mul is in the subset only as mul(v, float2x2(a, b, c, d))")
            }
            const v = e.args[0]!
            const [a, b, c, d] = (m as Extract<Expr, { k: "call" }>).args as [Expr, Expr, Expr, Expr]
            const line = e.line
            const comp = (field: string): Expr => ({ k: "member", obj: v, field, line })
            const term = (x: Expr, y: Expr, z: Expr, u: Expr): Expr => ({
                k: "binary", op: "+", line,
                l: { k: "binary", op: "*", l: x, r: y, line },
                r: { k: "binary", op: "*", l: z, r: u, line },
            })
            const out: Expr = { k: "call", name: "float2", args: [term(comp("x"), a, comp("y"), c), term(comp("x"), b, comp("y"), d)], line }
            const typed = expr(out)
            if (v.ty !== "float2") fail(line, "mul's vector must be a float2")
            return typed
        }

        const lvalue = (e: Expr, line: number): Expr => {
            let root = e
            let depth = 0
            while (root.k === "member") { root = root.obj; depth++ }
            if (root.k !== "id" || depth > 1) fail(line, "only a variable or one swizzle of it can be assigned")
            const sym = lookup((root as Extract<Expr, { k: "id" }>).name, line)
            if (sym.loop) fail(line, "a loop counter is assigned only by its loop")
            sym.assigned = true
            if (sym.param !== undefined) sym.param.assigned = true
            written.add((root as Extract<Expr, { k: "id" }>).name)
            if (e.k === "member" && new Set(e.field).size !== e.field.length) fail(line, `".${e.field}" assigns one component twice`)
            return expr(e)
        }

        const stmts = (list: Stmt[], scoped = true) => {
            if (scoped) scopes.push(new Map())
            for (const s of list) stmt(s)
            if (scoped) scopes.pop()
        }

        const stmt = (s: Stmt): void => {
            switch (s.k) {
                case "decl":
                    if (s.init !== undefined) s.init = to(expr(s.init), s.ty, s.line, `the value of ${s.name}`)
                    declare(s.name, { ty: s.ty, assigned: false }, s.line)
                    return
                case "assign": {
                    s.target = lvalue(s.target, s.line)
                    s.value = expr(s.value)
                    const want = s.target.ty!
                    if (s.op === "=") { s.value = to(s.value, want, s.line, "the assigned value"); return }
                    // A compound assignment is the binary operation, checked as one.
                    const probe = expr({ k: "binary", op: s.op[0]!, l: s.target, r: s.value, line: s.line }) as Extract<Expr, { k: "binary" }>
                    if (probe.ty !== want) fail(s.line, `"${s.op}" would make a ${probe.ty} of a ${want}`)
                    s.value = probe.r
                    return
                }
                case "if":
                    s.c = expr(s.c)
                    if (s.c.ty !== "bool") fail(s.line, "an if's condition must be a comparison")
                    stmts(s.then)
                    if (s.else !== undefined) stmts(s.else)
                    return
                case "for": {
                    s.init = to(expr(s.init), "int", s.line, "the loop's start")
                    scopes.push(new Map([[s.name, { ty: "int", loop: true, assigned: true }]]))
                    s.c = expr(s.c)
                    if (s.c.ty !== "bool") fail(s.line, "a loop's condition must be a comparison")
                    loops++
                    stmts(s.body)
                    loops--
                    scopes.pop()
                    return
                }
                case "switch":
                    s.sel = expr(s.sel)
                    if (s.sel.ty !== "int") fail(s.line, "a switch takes an int")
                    switches++
                    for (const c of s.cases) stmts(c.body)
                    switches--
                    return
                case "break":
                    if (loops === 0 && switches === 0) fail(s.line, "break outside a loop or switch")
                    return
                case "return":
                    s.e = to(expr(s.e), fn.ret, s.line, "the returned value")
                    return
                case "block":
                    // line -1 is several declarators on one line: they belong
                    // to the enclosing scope, not a new one.
                    stmts(s.body, s.line !== -1)
                    return
            }
        }

        stmts(fn.body, false)
        deps.push([...calls].sort((a, b) => a - b))
        assigned.push(written)
    })
    return { fns, deps, overloaded, assigned }
}

// MARK: printers

const TYPE_NAME: Record<Lang, Record<Ty, string>> = {
    glsl: { float: "float", float2: "vec2", float3: "vec3", float4: "vec4", int: "int", bool: "bool" },
    wgsl: { float: "f32", float2: "vec2f", float3: "vec3f", float4: "vec4f", int: "i32", bool: "bool" },
    hlsl: { float: "float", float2: "float2", float3: "float3", float4: "float4", int: "int", bool: "bool" },
}

const TYPE_CODE: Record<Ty, string> = { float: "f", float2: "f2", float3: "f3", float4: "f4", int: "i", bool: "b" }

/** The name a function is printed under: WGSL has no overloading, so an overloaded name carries its signature. */
export function printedName(c: Checked, i: number, lang: Lang): string {
    const fn = c.fns[i]!
    if (lang !== "wgsl" || !c.overloaded.has(fn.name)) return fn.name
    return `${fn.name}_${fn.params.map((p) => TYPE_CODE[p.ty]).join("_")}`
}

export interface PrintOptions {
    /** Web targets: the condition that is true in a Linear project, read at runtime. */
    linear?: string
}

const PREC: Record<string, number> = {
    "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 5, ">": 5, "<=": 5, ">=": 5, "+": 6, "-": 6, "*": 7, "/": 7,
}

function prec(e: Expr, lang: Lang): number {
    switch (e.k) {
        case "ternary": return lang === "wgsl" ? 9 : 1
        case "binary": return PREC[e.op]!
        case "unary": return 8
        case "cast": return lang === "hlsl" ? 8 : 9
        default: return 9
    }
}

export class Printer {
    constructor(private c: Checked, private lang: Lang) {}

    private get T() { return TYPE_NAME[this.lang] }

    expr(e: Expr, min = 0): string {
        const s = this.raw(e)
        return prec(e, this.lang) < min ? `(${s})` : s
    }

    private raw(e: Expr): string {
        const L = this.lang
        switch (e.k) {
            case "num": return e.text
            case "id": return e.name
            case "paren": return `(${this.expr(e.e)})`
            case "member": return `${this.expr(e.obj, 9)}.${e.field}`
            case "cast": return L === "hlsl" ? `(${e.to})${this.expr(e.e, 8)}` : `${this.T[e.to]}(${this.expr(e.e)})`
            case "unary": return `${e.op}${this.expr(e.e, e.e.k === "unary" ? 9 : 8)}`
            case "binary": {
                const p = PREC[e.op]!
                const logical = e.op === "&&" || e.op === "||"
                // WGSL refuses `a || b && c` without parentheses.
                // A unary on the right is parenthesised, so `a - -b` never prints.
                const side = (x: Expr, m: number) =>
                    L === "wgsl" && logical && x.k === "binary" && (x.op === "&&" || x.op === "||") && x.op !== e.op
                        ? `(${this.expr(x)})`
                        : this.expr(x, m)
                return `${side(e.l, p)} ${e.op} ${side(e.r, e.r.k === "unary" ? 9 : p + 1)}`
            }
            case "ternary":
                if (L === "wgsl") return `select(${this.expr(e.f)}, ${this.expr(e.t)}, ${this.expr(e.c)})`
                return `${this.expr(e.c, 2)} ? ${this.expr(e.t, 1)} : ${this.expr(e.f, 1)}`
            case "conv": return this.conv(e)
            case "call": {
                const args = e.args.map((a) => this.expr(a)).join(", ")
                if (e.ctor === true) return `${this.T[e.ty!]}(${args})`
                if (e.fn !== undefined) return `${printedName(this.c, e.fn, L)}(${args})`
                if (e.name === "saturate" && L === "glsl") return `clamp(${args}, ${this.splatText("0.0", e.ty!)}, ${this.splatText("1.0", e.ty!)})`
                const b = BUILTINS[e.name]!
                return `${(L === "glsl" ? b.glsl : L === "wgsl" ? b.wgsl : undefined) ?? e.name}(${args})`
            }
        }
    }

    private splatText(literal: string, ty: Ty): string {
        return WIDTH[ty] === 1 ? literal : `${this.T[ty]}(${this.lang === "hlsl" ? Array(WIDTH[ty]).fill(literal).join(", ") : literal})`
    }

    private conv(e: Extract<Expr, { k: "conv" }>): string {
        const inner = e.e
        if (e.ty === "float") {
            if (inner.k === "num") return `${inner.text}.0`
            if (inner.k === "unary" && inner.op === "-" && inner.e.k === "num") return `-${inner.e.text}.0`
            return `${this.T.float}(${this.expr(inner)})`
        }
        // A scalar to a vector. GLSL and WGSL splat with one argument. HLSL
        // refuses float3(x) and Metal refuses x.xxx, so the shared subset
        // repeats the scalar, which it can do only for something with no cost
        // or effect to repeat.
        if (this.lang !== "hlsl") return `${this.T[e.ty]}(${this.expr(inner)})`
        const simple = (x: Expr): boolean => x.k === "num" || x.k === "id" || (x.k === "member" && simple(x.obj)) || (x.k === "conv" && simple(x.e))
        if (!simple(inner)) throw new TranslateError(`line ${e.line}: the shared subset cannot widen this scalar to a ${e.ty} without repeating it; widen it in the source`)
        const one = this.expr(inner)
        return `${this.T[e.ty]}(${Array(WIDTH[e.ty]).fill(one).join(", ")})`
    }

    /** One function, printed under `name`. */
    fn(i: number, name: string): string {
        const fn = this.c.fns[i]!
        const L = this.lang
        const T = this.T
        const lines: string[] = []
        const copies: string[] = []
        const params = fn.params.map((p) => {
            if (L === "wgsl") {
                if (!p.assigned) return `${p.name}: ${T[p.ty]}`
                const inName = `${p.name}In`
                if (fn.params.some((q) => q.name === inName)) throw new TranslateError(`${fn.name}: ${inName} is taken`)
                copies.push(`var ${p.name}: ${T[p.ty]} = ${inName};`)
                return `${inName}: ${T[p.ty]}`
            }
            return `${T[p.ty]} ${p.name}`
        })
        lines.push(L === "wgsl" ? `fn ${name}(${params.join(", ")}) -> ${T[fn.ret]} {` : `${T[fn.ret]} ${name}(${params.join(", ")}) {`)
        for (const c of copies) lines.push(`    ${c}`)
        this.stmts(fn.body, 1, lines, this.c.assigned[i]!)
        lines.push("}")
        return lines.join("\n")
    }

    private stmts(list: Stmt[], depth: number, out: string[], assigned: Set<string>): void {
        for (const s of list) this.stmt(s, depth, out, assigned)
    }

    private stmt(s: Stmt, depth: number, out: string[], assigned: Set<string>): void {
        const pad = "    ".repeat(depth)
        const L = this.lang
        const T = this.T
        switch (s.k) {
            case "block":
                if (s.line === -1) { this.stmts(s.body, depth, out, assigned); return }
                out.push(`${pad}{`)
                this.stmts(s.body, depth + 1, out, assigned)
                out.push(`${pad}}`)
                return
            case "decl": {
                const init = s.init === undefined ? "" : ` = ${this.expr(s.init)}`
                if (L === "wgsl") {
                    const mutable = s.init === undefined || assigned.has(s.name)
                    out.push(`${pad}${mutable ? "var" : "let"} ${s.name}: ${T[s.ty]}${init};`)
                } else {
                    out.push(`${pad}${s.isConst && L === "hlsl" ? "const " : ""}${T[s.ty]} ${s.name}${init};`)
                }
                return
            }
            case "assign": {
                const t = s.target
                if (L === "wgsl" && t.k === "member" && t.field.length > 1) {
                    // WGSL cannot assign through a swizzle of several components,
                    // so the vector is rebuilt whole around the new ones.
                    const root = t.obj as Extract<Expr, { k: "id" }>
                    const set = /^[xyzw]+$/.test(t.field) ? "xyzw" : "rgba"
                    const value = s.op === "=" ? this.expr(s.value) : `${this.expr(t, PREC[s.op[0]!]!)} ${s.op[0]} ${this.expr(s.value, PREC[s.op[0]!]! + 1)}`
                    const parts = Array.from({ length: WIDTH[root.ty!] }, (_, j) => {
                        const at = [...t.field].findIndex((c) => set.indexOf(c) === j)
                        return at >= 0 ? `sl_v.${"xyzw"[at]}` : `${root.name}.${"xyzw"[j]}`
                    })
                    out.push(`${pad}{`)
                    out.push(`${pad}    let sl_v: ${T[t.ty!]} = ${value};`)
                    out.push(`${pad}    ${root.name} = ${T[root.ty!]}(${parts.join(", ")});`)
                    out.push(`${pad}}`)
                    return
                }
                out.push(`${pad}${this.expr(t)} ${s.op} ${this.expr(s.value)};`)
                return
            }
            case "if": {
                out.push(`${pad}if (${this.expr(s.c)}) {`)
                this.stmts(s.then, depth + 1, out, assigned)
                let rest = s.else
                while (rest !== undefined) {
                    const only = rest.length === 1 ? rest[0]! : undefined
                    if (only?.k === "if") {
                        out.push(`${pad}} else if (${this.expr(only.c)}) {`)
                        this.stmts(only.then, depth + 1, out, assigned)
                        rest = only.else
                    } else {
                        out.push(`${pad}} else {`)
                        this.stmts(rest, depth + 1, out, assigned)
                        rest = undefined
                    }
                }
                out.push(`${pad}}`)
                return
            }
            case "for": {
                const init = L === "wgsl" ? `var ${s.name}: i32 = ${this.expr(s.init)}` : `int ${s.name} = ${this.expr(s.init)}`
                out.push(`${pad}for (${init}; ${this.expr(s.c)}; ${s.name}++) {`)
                this.stmts(s.body, depth + 1, out, assigned)
                out.push(`${pad}}`)
                return
            }
            case "switch": {
                out.push(`${pad}switch (${this.expr(s.sel)}) {`)
                for (const c of s.cases) {
                    const label = c.value === "default" ? "default" : `case ${c.value}`
                    if (L === "wgsl") {
                        out.push(`${pad}    ${label}: {`)
                        this.stmts(c.body, depth + 2, out, assigned)
                        out.push(`${pad}    }`)
                    } else {
                        out.push(`${pad}    ${label}:`)
                        this.stmts(c.body, depth + 2, out, assigned)
                    }
                }
                out.push(`${pad}}`)
                return
            }
            case "break": out.push(`${pad}break;`); return
            case "return": out.push(`${pad}return ${this.expr(s.e)};`); return
        }
    }
}
