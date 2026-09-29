/**
 * Source to AST. A Pratt parser, because expressions are the interesting half.
 *
 * Phase A of `Specs/SL_TEXT.md` section 4. This file decides SHAPE only: what
 * is a declaration, what is a statement, how tightly `*` binds against `+`. It
 * knows nothing about types, about which names exist, or about what any of it
 * lowers to, and it never touches the IR. Everything it refuses, it refuses
 * because the characters cannot be read any other way.
 *
 * HLSL precedence, so that an expression copied out of a `.shader` file means
 * here what it meant there. That is the whole promise of choosing HLSL.
 */

import {
    type AssignOp, type Attribute, type AttributeArg, type BinaryOp, type Expr, type FuncDecl, type Param, type Stmt,
    type SwitchCase, type TextureDecl, type TypeName, type UniformDecl, type Unit,
} from "./ast"
import { SLParseError, tokenize, type Pos, type SLFix, type Token } from "./lexer"
import { KEYWORD_SET, TYPE_SET } from "./words"

/**
 * Type spellings that exist in HLSL or GLSL and not here, each with the reason.
 *
 * `Specs/SL_TEXT.md` section 2: the IR bounds what the language can say, on
 * purpose. A name in this table gets the reason; a name outside it gets
 * "unknown", and the difference is most of what makes the language learnable.
 */
const NOT_A_TYPE: Record<string, string> = {
    vec2: "use float2",
    vec3: "use float3",
    vec4: "use float4",
    int2: "there are no int vectors yet; use an int for each component",
    int3: "there are no int vectors yet; use an int for each component",
    int4: "there are no int vectors yet; use an int for each component",
    uint2: "there are no uint vectors yet; use a uint for each component",
    uint3: "there are no uint vectors yet; use a uint for each component",
    uint4: "there are no uint vectors yet; use a uint for each component",
    bool2: "there are no bool vectors; use a bool for each component",
    bool3: "there are no bool vectors; use a bool for each component",
    bool4: "there are no bool vectors; use a bool for each component",
    ivec2: "there are no int vectors yet; use an int for each component",
    half: "use float; the IR has one precision",
    double: "use float; the IR has one precision",
    fixed: "use float; the IR has one precision",
    float2x2: "there are no matrices",
    float3x3: "there are no matrices",
    float4x4: "there are no matrices",
    sampler2D: "use texture2D to declare a texture slot",
    void: "every function returns a value",
    struct: "there are no structs",
}

/** The spellings above whose replacement is certain, so the error can offer it as a fix. */
const TYPE_FIX: Record<string, TypeName> = {
    vec2: "float2", vec3: "float3", vec4: "float4", half: "float", double: "float", fixed: "float",
}

/** Binding power per binary operator, HLSL's. Higher binds tighter. */
const BINDING: Record<string, number> = {
    "||": 1,
    "&&": 2,
    "|": 3,
    "^": 4,
    "&": 5,
    "==": 6, "!=": 6,
    "<": 7, "<=": 7, ">": 7, ">=": 7,
    "<<": 8, ">>": 8,
    "+": 9, "-": 9,
    "*": 10, "/": 10, "%": 10,
}

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="])

class Parser {
    private i = 0

    constructor(
        private readonly tokens: Token[],
        private readonly file: string,
        private readonly requireMain: boolean,
        /** Collects errors and carries on, for `diagnose`; without it the first error throws. */
        private readonly errors?: SLParseError[],
    ) {}

    // MARK: token plumbing

    private peek(n = 0): Token { return this.tokens[Math.min(this.i + n, this.tokens.length - 1)]! }
    private next(): Token { return this.tokens[this.i++]! }
    private at(text: string): boolean { const t = this.peek(); return t.kind !== "eof" && t.text === text }
    private eat(text: string): boolean { if (this.at(text)) { this.i++; return true } return false }

    private fail(message: string, at: Token = this.peek(), fix?: SLFix): never {
        throw this.error(message, at, fix)
    }

    private error(message: string, at: Token, fix?: SLFix): SLParseError {
        // The end of the file is no character, so an error there marks the last
        // token instead of one past it, where an editor has nothing to underline.
        if (at.kind === "eof" && this.tokens.length > 1) at = this.tokens[this.tokens.length - 2]!
        return new SLParseError(message, this.file, at as Pos, Math.max(1, at.text.length), fix)
    }

    /** An error about something already read in full, so there is nothing to skip to carry on. */
    private report(message: string, at: Token): void {
        const e = this.error(message, at)
        if (this.errors === undefined) throw e
        this.errors.push(e)
    }

    // MARK: recovery

    /**
     * Runs one statement's or one declaration's parse. Collecting, an error is
     * recorded and the tokens are skipped to where the next one starts, so a
     * second mistake further down the file is found too.
     */
    private recover<T>(parse: () => T, level: "statement" | "declaration"): T | null {
        if (this.errors === undefined) return parse()
        const start = this.i
        try {
            return parse()
        } catch (e) {
            if (!(e instanceof SLParseError)) throw e
            this.errors.push(e)
            this.skip(level)
            // A parse that failed on its first token and a skip that stopped there
            // would try the same token forever.
            if (this.i === start && this.peek().kind !== "eof" && !this.at("}")) this.i++
            return null
        }
    }

    /**
     * Past the end of the broken statement: through its `;`, or through the
     * block it opened, or up to the `}` of the body it is in. A declaration
     * ends at a `;` or at the `}` of its own body.
     */
    private skip(level: "statement" | "declaration"): void {
        let depth = 0
        for (;;) {
            const t = this.peek()
            if (t.kind === "eof") return
            if (t.text === "}" && depth === 0 && level === "statement") return
            this.i++
            if (t.text === "{") depth++
            else if (t.text === "}") { depth--; if (depth <= 0) return }
            else if (t.text === ";" && depth === 0) return
        }
    }

    private expect(text: string, what: string): Token {
        if (!this.at(text)) {
            const got = this.peek()
            // Something missing at the end of a line is missing after the last
            // token on it, which is where the author will look, not at the next line.
            const prev = this.tokens[this.i - 1]
            const at = prev !== undefined && got.line > prev.line ? prev : got
            this.fail(`expected "${text}" ${what}, got ${describe(got)}`, at)
        }
        return this.next()
    }

    private expectIdent(what: string): Token {
        const t = this.peek()
        if (t.kind !== "ident") this.fail(`expected ${what}, got ${describe(t)}`, t)
        return this.next()
    }

    /** A name being declared, which may not be a word the parser reads as syntax. */
    private expectName(what: string): Token {
        const t = this.expectIdent(what)
        if (KEYWORD_SET.has(t.text)) this.fail(`"${t.text}" is a keyword, so it cannot be ${what}`, t)
        if (TYPE_SET.has(t.text)) this.fail(`"${t.text}" is a type, so it cannot be ${what}`, t)
        return t
    }

    private expectType(what: string): TypeName {
        const t = this.expectIdent(what)
        if (TYPE_SET.has(t.text)) return t.text as TypeName
        const why = NOT_A_TYPE[t.text]
        const to = TYPE_FIX[t.text]
        const fix = to === undefined ? undefined : { title: `Replace ${t.text} with ${to}`, replacement: to }
        if (why !== undefined) this.fail(`"${t.text}" is not a type here: ${why}`, t, fix)
        this.fail(`"${t.text}" is not a type; the types are float, float2, float3, float4, int, uint and bool`, t)
    }

    // MARK: the file

    parseUnit(): Unit {
        const unit: Unit = {
            file: this.file, uniforms: [], textures: [], consts: [], funcs: [], main: null,
        }

        while (this.peek().kind !== "eof") {
            this.recover(() => this.parseDeclaration(unit), "declaration")
        }

        // Collecting, a syntax error may have swallowed main (an unclosed body
        // reads to the end of the file), so "no main" only when nothing else went wrong.
        if (unit.main === null && this.requireMain && (this.errors?.length ?? 0) === 0) {
            this.report(
                "this file declares no main. A .sl file is one fragment function: add " +
                "`float4 main() { ... }`",
                this.peek(),
            )
        }
        return unit
    }

    private parseDeclaration(unit: Unit): void {
        const t = this.peek()

        if (t.text === "[") {
            const attrs = this.parseAttributes()
            if (!this.at("uniform")) {
                this.fail(
                    `an attribute belongs on a uniform, as in \`[Range(0, 1)] uniform float amount = 0.5;\`, ` +
                    `and this one is followed by ${describe(this.peek())}`, t,
                )
            }
            unit.uniforms.push(this.parseUniform(attrs))
            return
        }
        if (t.text === "uniform") { unit.uniforms.push(this.parseUniform([])); return }
        if (t.text === "texture2D") { unit.textures.push(this.parseTexture()); return }
        if (t.text === "const") { unit.consts.push(this.parseConst()); return }
        if (t.kind === "ident") {
            const fn = this.parseFunction()
            if (fn.name !== "main") unit.funcs.push(fn)
            else if (unit.main === null) unit.main = fn
            else this.report("this file already declares main; a .sl file is exactly one fragment function", t)
            return
        }
        this.fail(
            `expected a declaration (uniform, texture2D, const, or a function), got ${describe(t)}`, t,
        )
    }

    private parseUniform(attrs: Attribute[]): UniformDecl {
        const kw = this.next()
        const type = this.expectType("a type after uniform")
        const name = this.expectName("a uniform name")
        let init: Expr | null = null
        if (this.eat("=")) init = this.parseExpr()
        this.expect(";", "after a uniform declaration")
        return { name: name.text, type, init, attrs, pos: kw }
    }

    /** `[Name]` or `[Name(arg, ...)]`, one or more. Shape only: the checker says what each means. */
    private parseAttributes(): Attribute[] {
        const out: Attribute[] = []
        while (this.eat("[")) {
            const name = this.expectIdent("an attribute's name, such as Range")
            const args: AttributeArg[] = []
            if (this.eat("(")) {
                if (!this.at(")")) {
                    do args.push(this.parseAttributeArg())
                    while (this.eat(","))
                }
                this.expect(")", "to close the attribute's arguments")
            }
            this.expect("]", "to close the attribute")
            out.push({ name: name.text, args, pos: name, length: name.text.length })
        }
        return out
    }

    private parseAttributeArg(): AttributeArg {
        const t = this.next()
        if (t.kind === "string") return { k: "str", text: t.str!, pos: t, length: t.text.length }
        if (t.kind === "ident") return { k: "ident", name: t.text, pos: t, length: t.text.length }
        if (t.kind === "number") return { k: "num", value: t.value!, pos: t, length: t.text.length }
        if (t.text === "-" && this.peek().kind === "number") {
            const n = this.next()
            return { k: "num", value: -n.value!, pos: t, length: n.offset + n.text.length - t.offset }
        }
        this.fail(`expected a number, a word or a "string" as an attribute's argument, got ${describe(t)}`, t)
    }

    private parseTexture(): TextureDecl {
        const kw = this.next()
        const name = this.expectName("a texture name")
        if (this.at("=")) {
            this.fail(
                "a texture has no default; the host binds it by name through the textures prop",
                this.peek(),
            )
        }
        this.expect(";", "after a texture declaration")
        return { name: name.text, pos: kw }
    }

    private parseConst(): Extract<Stmt, { k: "const" }> {
        const kw = this.next()
        const type = this.expectType("a type after const")
        const name = this.expectName("a const's name")
        this.expect("=", "after a const's name; a const has to have a value")
        const init = this.parseExpr()
        this.expect(";", "after a const")
        return { k: "const", type, name: name.text, init, pos: kw }
    }

    private parseFunction(): FuncDecl {
        const start = this.peek()
        const ret = this.expectType("a return type")
        const name = this.expectName("a function name")
        if (!this.at("(")) {
            this.fail(
                `expected "(" after ${name.text}. Only uniforms, textures, consts and functions live ` +
                `at the top level of a file; a value belongs inside main or a function`,
                this.peek(),
            )
        }
        this.next()
        const params: Param[] = []
        if (!this.at(")")) {
            for (;;) {
                const p = this.peek()
                const ptype = this.expectType("a parameter type")
                const pname = this.expectName("a parameter name")
                params.push({ type: ptype, name: pname.text, pos: p })
                if (!this.eat(",")) break
            }
        }
        this.expect(")", "after the parameters")
        const body = this.parseBlock()
        return { name: name.text, ret, params, body, pos: start, prelude: false }
    }

    // MARK: statements

    private parseBlock(): Stmt[] {
        this.expect("{", "to open a body")
        const out: Stmt[] = []
        while (!this.at("}")) {
            if (this.peek().kind === "eof") this.fail("this body is never closed", this.peek())
            const s = this.recover(() => this.parseStmt(), "statement")
            if (s !== null) out.push(s)
        }
        this.next()
        return out
    }

    /** A braced block, or the single statement HLSL lets an `if` or `for` carry. */
    private parseBody(): Stmt[] {
        if (this.at("{")) return this.parseBlock()
        return [this.parseStmt()]
    }

    private parseStmt(): Stmt {
        const t = this.peek()

        if (t.text === "const") return this.parseConst()
        if (t.text === "if") return this.parseIf()
        if (t.text === "for") return this.parseFor()
        if (t.text === "while") return this.parseWhile()
        if (t.text === "switch") return this.parseSwitch()
        if (t.text === "do") {
            this.fail("there is no do loop; write it as a while loop, `while (condition) { ... }`", t)
        }
        if (t.text === "discard") {
            this.fail("there is no discard; return a colour with alpha 0 instead", t)
        }
        if (t.text === "break" || t.text === "continue") {
            this.next()
            this.expect(";", `after ${t.text}`)
            return { k: t.text, pos: t }
        }
        if (t.text === "case" || t.text === "default") {
            this.fail(`${t.text} belongs inside a switch's braces`, t)
        }
        if (t.text === "return") {
            this.next()
            const value = this.parseExpr()
            this.expect(";", "after a return")
            return { k: "return", value, pos: t }
        }
        if (t.text === "uniform" || t.text === "texture2D") {
            this.fail(`a ${t.text} is declared at the top level of the file, not inside a body`, t)
        }

        // A declaration is a type followed by a name. Anything else starting
        // with an identifier is an expression, and the only expression a
        // statement may be is the left of an assignment.
        if (t.kind === "ident" && this.peek(1).kind === "ident") {
            const type = this.expectType("a type")
            const name = this.expectName("a local's name")
            if (this.at("(")) {
                this.fail(
                    "a function is declared at the top level of the file, not inside another function",
                    this.peek(),
                )
            }
            this.expect("=", `after ${name.text}; every local is declared with a value`)
            const init = this.parseExpr()
            this.expect(";", "after a declaration")
            return { k: "var", type, name: name.text, init, pos: t }
        }

        const s = this.parseSimple(t)
        this.expect(";", "after an assignment")
        return s
    }

    /**
     * An assignment, or `x++`, `++x`, `x--`, `--x`, with no semicolon: a
     * statement's body, and a for loop's update.
     */
    private parseSimple(t: Token): Extract<Stmt, { k: "assign" }> {
        const one = (at: Token): Expr => ({ k: "num", value: 1, whole: true, pos: at })
        if (t.text === "++" || t.text === "--") {
            this.next()
            const target = this.parseUnary()
            return { k: "assign", target, op: t.text === "++" ? "+=" : "-=", value: one(t), pos: t }
        }
        const target = this.parseExpr()
        const op = this.peek()
        if (op.kind === "punct" && ASSIGN_OPS.has(op.text)) {
            this.next()
            const value = this.parseExpr()
            return { k: "assign", target, op: op.text as AssignOp, value, pos: t }
        }
        if (op.text === "++" || op.text === "--") {
            this.next()
            return { k: "assign", target, op: op.text === "++" ? "+=" : "-=", value: one(op), pos: t }
        }
        this.fail(
            "this statement has no effect. A statement is a declaration, an assignment, an if, a " +
            "loop, a switch or a return",
            t,
        )
    }

    private parseIf(): Stmt {
        const kw = this.next()
        this.expect("(", "after if")
        const cond = this.parseExpr()
        this.expect(")", "after an if condition")
        const then = this.parseBody()
        let otherwise: Stmt[] = []
        if (this.at("else")) {
            this.next()
            otherwise = this.at("if") ? [this.parseIf()] : this.parseBody()
        }
        return { k: "if", cond, then, else: otherwise, pos: kw }
    }

    /**
     * `for (int i = A; condition; update)`, where the update changes the
     * counter: `i++`, `i--`, `i += k`, `i = i * 2`. The loop unrolls when its
     * turns are known at build time and few, and is a real loop otherwise.
     */
    private parseFor(): Stmt {
        const kw = this.next()
        this.expect("(", "after for")

        const decl = this.peek()
        if (decl.kind !== "ident" || this.peek(1).kind !== "ident") {
            this.fail(
                `a for loop starts by declaring its counter, as in \`for (int i = 0; i < 4; i++)\`, ` +
                `got ${describe(decl)}`, decl,
            )
        }
        const type = this.expectType("the counter's type")
        const counter = this.expectName("a counter name")
        this.expect("=", "after the counter")
        const from = this.parseExpr()
        this.expect(";", "after the counter's start")

        const cond = this.parseExpr()
        this.expect(";", "after the loop's condition")

        const up = this.peek()
        const update = this.parseSimple(up)
        const target = update.target.k === "ident" ? update.target.name : null
        if (target !== counter.text) {
            this.fail(`this loop counts ${counter.text}, so its update has to change ${counter.text}`, up)
        }
        this.expect(")", "after the loop's update")
        const body = this.parseBody()
        return { k: "for", type, counter: counter.text, from, cond, update, body, pos: kw }
    }

    private parseWhile(): Stmt {
        const kw = this.next()
        this.expect("(", "after while")
        const cond = this.parseExpr()
        this.expect(")", "after a while condition")
        const body = this.parseBody()
        return { k: "while", cond, body, pos: kw }
    }

    /**
     * `switch (x) { case 0: ... break; case 1: case 2: ... return c; default: ... }`.
     *
     * Cases never fall through. Labels stack, and each group of them ends in a
     * break, a return or a continue, which the checker holds it to; the closing
     * break is dropped here, since leaving the switch is all it says.
     */
    private parseSwitch(): Stmt {
        const kw = this.next()
        this.expect("(", "after switch")
        const value = this.parseExpr()
        this.expect(")", "after the switch's value")
        this.expect("{", "to open the switch's cases")
        const cases: SwitchCase[] = []
        while (!this.at("}")) {
            const t = this.peek()
            if (t.kind === "eof") this.fail("this switch is never closed", t)
            if (t.text !== "case" && t.text !== "default") {
                this.fail(`a switch holds cases, as in \`case 0: ... break;\`, got ${describe(t)}`, t)
            }
            const labels: Array<Expr | null> = []
            while (this.at("case") || this.at("default")) {
                if (this.next().text === "case") labels.push(this.parseExpr())
                else labels.push(null)
                this.expect(":", "after a case label")
            }
            const body: Stmt[] = []
            while (!this.at("case") && !this.at("default") && !this.at("}")) {
                if (this.peek().kind === "eof") this.fail("this switch is never closed", this.peek())
                const s = this.recover(() => this.parseStmt(), "statement")
                if (s !== null) body.push(s)
            }
            const closed = body.at(-1)?.k === "break"
            if (closed) body.pop()
            cases.push({ labels, body, closed, pos: t })
        }
        this.next()
        return { k: "switch", value, cases, pos: kw }
    }

    // MARK: expressions

    parseExpr(): Expr { return this.parseBinary(0) }

    private parseBinary(min: number): Expr {
        let left = this.parseUnary()
        for (;;) {
            const t = this.peek()
            if (t.kind !== "punct") break
            const bp = BINDING[t.text]
            if (bp === undefined || bp < min) break
            this.next()
            const right = this.parseBinary(bp + 1)
            left = { k: "binary", op: t.text as BinaryOp, a: left, b: right, pos: t }
        }
        // The conditional binds looser than every binary operator and is right
        // associative, so `a ? b : c ? d : e` groups to the right, as in HLSL.
        if (min === 0 && this.at("?")) {
            const q = this.next()
            const then = this.parseExpr()
            this.expect(":", "in a ?: conditional")
            const otherwise = this.parseExpr()
            return { k: "cond", cond: left, then, else: otherwise, pos: q }
        }
        return left
    }

    private parseUnary(): Expr {
        const t = this.peek()
        if (t.kind === "punct" && (t.text === "-" || t.text === "+" || t.text === "!" || t.text === "~")) {
            this.next()
            return { k: "unary", op: t.text, arg: this.parseUnary(), pos: t }
        }
        if (t.text === "++" || t.text === "--") {
            this.fail(`${t.text} changes a local, so it is a statement of its own, \`i++;\`, and not part of an expression`, t)
        }
        return this.parsePostfix(this.parsePrimary())
    }

    private parsePostfix(expr: Expr): Expr {
        for (;;) {
            if (this.at(".")) {
                this.next()
                const name = this.expectIdent("a component or a shape name after \".\"")
                expr = { k: "member", obj: expr, name: name.text, pos: name }
                continue
            }
            if (this.at("(")) {
                const open = this.next()
                const args: Expr[] = []
                if (!this.at(")")) {
                    for (;;) {
                        args.push(this.parseExpr())
                        if (!this.eat(",")) break
                    }
                }
                this.expect(")", "after the arguments")
                expr = { k: "call", callee: expr, args, pos: open }
                continue
            }
            if (this.at("[")) {
                this.fail("there are no arrays; index a component with .x, .y, .z or .w", this.peek())
            }
            return expr
        }
    }

    private parsePrimary(): Expr {
        const t = this.next()
        if (t.kind === "number") return t.unsigned === true
            ? { k: "num", value: t.value!, whole: true, unsigned: true, pos: t }
            : { k: "num", value: t.value!, whole: t.whole === true, pos: t }
        if (t.text === "true" || t.text === "false") return { k: "bool", value: t.text === "true", pos: t }
        if (t.kind === "hex") return { k: "hex", hex: t.text, pos: t }
        if (t.kind === "ident") return { k: "ident", name: t.text, pos: t }
        if (t.kind === "string") {
            this.fail(`a string is only an attribute's argument, as in [Label("Glow colour")]; a value is a number`, t)
        }
        if (t.text === "(") {
            const inner = this.parseExpr()
            this.expect(")", "to close a group")
            return inner
        }
        this.fail(`expected a value, got ${describe(t)}`, t)
    }
}

function describe(t: Token): string {
    if (t.kind === "eof") return "the end of the file"
    return `"${t.text}"`
}

export interface ParseOptions {
    file?: string
    /**
     * Where to collect errors instead of throwing the first: the parse carries
     * on past each one and returns what it could read. What `diagnose` uses.
     */
    errors?: SLParseError[]
    /**
     * Off for the prelude, which is a library of functions and has no main.
     * Nothing else should turn it off: a `.sl` file without a main renders
     * nothing, and finding that out at parse time is the point.
     */
    requireMain?: boolean
    /** What `/` does with two ints (`LowerOptions`). Undecided, so a parse can pick either. */
    intDivision?: "truncate" | "float"
}

export function parseUnit(source: string, options: ParseOptions = {}): Unit {
    const file = options.file ?? "program.sl"
    return new Parser(tokenize(source, file), file, options.requireMain ?? true, options.errors).parseUnit()
}
