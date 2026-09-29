/**
 * The AST the parser builds and the checker and lowering walk.
 *
 * Phase A of `Specs/SL_TEXT.md`. Deliberately small: a `.sl` file is one
 * fragment function and its declarations, so there is no module system, no
 * struct, no array and no statement that is not one of six shapes.
 *
 * Every node carries the position of the token it started at. That is what lets
 * an error from the middle of lowering say which character to underline, and it
 * is why the position lives on the node rather than being recovered by a second
 * pass over the source.
 */

import type { SLKind } from "../ir"
import type { Pos } from "./lexer"

/** The value types, under their HLSL names. `texture2D` is not one: it declares a slot. */
export type TypeName = "float" | "float2" | "float3" | "float4" | "int" | "uint" | "bool"

export const TYPE_WIDTH: Record<TypeName, 1 | 2 | 3 | 4> = {
    float: 1, float2: 2, float3: 3, float4: 4, int: 1, uint: 1, bool: 1,
}

/** What a type holds beside its width; the floats hold nothing else. */
export const TYPE_KIND: Record<TypeName, SLKind | undefined> = {
    float: undefined, float2: undefined, float3: undefined, float4: undefined, int: "int", uint: "uint", bool: "bool",
}

export type BinaryOp =
    | "+" | "-" | "*" | "/" | "%"
    | "<" | "<=" | ">" | ">=" | "==" | "!="
    | "&&" | "||"
    | "&" | "|" | "^" | "<<" | ">>"

export type Expr =
    /**
     * `whole` is a number written with no point and no exponent, `3` not `3.0`:
     * a float, except beside an int, where it is an int. `unsigned` is `3u`.
     */
    | { k: "num"; value: number; whole: boolean; unsigned?: boolean; pos: Pos }
    | { k: "bool"; value: boolean; pos: Pos }
    | { k: "hex"; hex: string; pos: Pos }
    | { k: "ident"; name: string; pos: Pos }
    /** A swizzle, or the shape half of `sdf.circle`. Which one is decided later. */
    | { k: "member"; obj: Expr; name: string; pos: Pos }
    | { k: "call"; callee: Expr; args: Expr[]; pos: Pos }
    | { k: "unary"; op: "-" | "+" | "!" | "~"; arg: Expr; pos: Pos }
    | { k: "binary"; op: BinaryOp; a: Expr; b: Expr; pos: Pos }
    | { k: "cond"; cond: Expr; then: Expr; else: Expr; pos: Pos }

export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>="

/** One `case` group of a switch: its labels, `null` for `default`, and its body without the closing break. */
export interface SwitchCase {
    labels: Array<Expr | null>
    body: Stmt[]
    /** Whether it ended in a break, which is dropped from `body`. */
    closed: boolean
    pos: Pos
}

export type Stmt =
    | { k: "var"; type: TypeName; name: string; init: Expr; pos: Pos }
    /** A compile time constant: usable as a value and as a `for` bound. */
    | { k: "const"; type: TypeName; name: string; init: Expr; pos: Pos }
    /** `x++` is `x += 1`, with the 1 whole. */
    | { k: "assign"; target: Expr; op: AssignOp; value: Expr; pos: Pos }
    | { k: "if"; cond: Expr; then: Stmt[]; else: Stmt[]; pos: Pos }
    /** `for (type counter = from; cond; update)`: the update changes the counter and nothing else. */
    | { k: "for"; type: TypeName; counter: string; from: Expr; cond: Expr; update: Extract<Stmt, { k: "assign" }>; body: Stmt[]; pos: Pos }
    | { k: "while"; cond: Expr; body: Stmt[]; pos: Pos }
    | { k: "break"; pos: Pos }
    | { k: "continue"; pos: Pos }
    /** Cases never fall through: each ends in break, return or continue, and the break is dropped here. */
    | { k: "switch"; value: Expr; cases: SwitchCase[]; pos: Pos }
    | { k: "return"; value: Expr; pos: Pos }
    /** `{ ... }` on its own: a body with its own scope, as a case's braces are. */
    | { k: "block"; body: Stmt[]; pos: Pos }

export interface Param {
    type: TypeName
    name: string
    pos: Pos
}

export interface FuncDecl {
    name: string
    ret: TypeName
    params: Param[]
    body: Stmt[]
    pos: Pos
    /** Prelude functions are shadowed by a function of the same name in the file. */
    prelude: boolean
}

/** An argument to an attribute: a number, a quoted string, or a bare word. */
export type AttributeArg =
    | { k: "num"; value: number; pos: Pos; length: number }
    | { k: "str"; text: string; pos: Pos; length: number }
    | { k: "ident"; name: string; pos: Pos; length: number }

/** `[Range(0, 2)]` before a uniform: Unity's spelling of what its control is. */
export interface Attribute {
    name: string
    args: AttributeArg[]
    /** Where the name starts, and how long it is, for a marker. */
    pos: Pos
    length: number
}

export interface UniformDecl {
    name: string
    type: TypeName
    /** Null when the declaration gave no default; the slot then starts at zero. */
    init: Expr | null
    /** In the order written. What each means is decided by the checker, not the parser. */
    attrs: Attribute[]
    pos: Pos
}

export interface TextureDecl {
    name: string
    pos: Pos
}

export interface Unit {
    file: string
    uniforms: UniformDecl[]
    textures: TextureDecl[]
    consts: Extract<Stmt, { k: "const" }>[]
    funcs: FuncDecl[]
    /** `float4 main()`. Exactly one per file, and the parser refuses a file without it. */
    main: FuncDecl | null
}
