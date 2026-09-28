/**
 * A uniform's attributes, read into what its control is (`Specs/SL_NEXT.md` 1).
 *
 * Unity's names, so a Unity developer already knows them: `[Range(0, 2)]`,
 * `[Toggle]`, `[Enum(Soft, Hard, Glow)]`, `[Header("Shape")]`,
 * `[Label("Glow colour")]`, `[Color]` and `[Hide]`. The parser reads their
 * shape only; this says what each one means and what is wrong with it, for the
 * checker to report and for lowering to build. What depends on the default
 * (a default outside its range, say) is `controlProblem`'s, which the EDSL
 * shares.
 */

import type { UniformControl } from "../ir"
import { TYPE_WIDTH, type Attribute, type AttributeArg, type UniformDecl } from "./ast"
import type { Pos, SLFix } from "./lexer"

export interface AttributeProblem {
    message: string
    pos: Pos
    length: number
    fix?: SLFix
}

export interface ReadAttributes {
    /** Every attribute that could be read. One that could not is left out, and is in `problems`. */
    control: UniformControl
    /** `[Color]`: the value is a colour as written, the same as a hex default. */
    colour: boolean
    /** The attribute that wrote each field, to mark when the default does not fit it. */
    from: Partial<Record<keyof UniformControl, Attribute>>
    problems: AttributeProblem[]
}

/** Every attribute, in the order the docs list them. */
export const ATTRIBUTE_NAMES = ["Range", "Toggle", "Enum", "Header", "Label", "Color", "Hide"] as const
export type AttributeName = (typeof ATTRIBUTE_NAMES)[number]

/** Spellings from Unity, from other engines, or from English, that mean one of ours. */
const ALIASES: Record<string, AttributeName> = {
    Colour: "Color", HideInInspector: "Hide", ToggleUI: "Toggle", KeywordEnum: "Enum", IntRange: "Range",
}

const LIST = "Range, Toggle, Enum, Header, Label, Color and Hide"

export function readAttributes(u: UniformDecl): ReadAttributes {
    const out: ReadAttributes = { control: {}, colour: false, from: {}, problems: [] }
    const seen = new Set<string>()
    const problem = (at: Attribute | AttributeArg, message: string, fix?: SLFix) => {
        out.problems.push({ message, pos: at.pos, length: at.length, ...(fix === undefined ? {} : { fix }) })
    }
    const text = (a: AttributeArg): string | null => a.k === "str" ? a.text : a.k === "ident" ? a.name : null
    const none = (a: Attribute) => {
        if (a.args.length === 0) return true
        problem(a.args[0]!, `[${a.name}] takes no arguments`)
        return false
    }
    const one = (a: Attribute, what: string): string | null => {
        const t = a.args.length === 1 ? text(a.args[0]!) : null
        if (t === null) problem(a.args[0] ?? a, `[${a.name}] takes ${what} in quotes, as in [${a.name}("${a.name === "Header" ? "Shape" : "Glow colour"}")]`)
        return t
    }

    for (const a of u.attrs) {
        const known = (ATTRIBUTE_NAMES as readonly string[]).includes(a.name)
        if (!known) {
            const to = ALIASES[a.name] ?? ATTRIBUTE_NAMES.find((n) => n.toLowerCase() === a.name.toLowerCase())
            const hint = a.name === "IntRange" ? "; a whole number slider is [Range(min, max, 1)]" : ""
            problem(a, `"${a.name}" is not an attribute; the attributes are ${LIST}${to === undefined ? "" : `. Did you mean ${to}?`}${hint}`,
                to === undefined || a.name === "IntRange" ? undefined : { title: `Replace ${a.name} with ${to}`, replacement: to })
            continue
        }
        if (seen.has(a.name)) { problem(a, `this uniform already has [${a.name}]`); continue }
        seen.add(a.name)
        switch (a.name) {
            case "Range": {
                const n = a.args.map((x) => x.k === "num" ? x.value : null)
                if ((n.length !== 2 && n.length !== 3) || n.includes(null)) {
                    problem(a, "[Range] takes a minimum, a maximum and an optional step, all numbers: [Range(0, 1)] or [Range(1, 16, 1)]")
                    break
                }
                out.control.range = n.length === 3 ? { min: n[0]!, max: n[1]!, step: n[2]! } : { min: n[0]!, max: n[1]! }
                out.from.range = a
                break
            }
            case "Toggle":
                if (none(a)) { out.control.toggle = true; out.from.toggle = a }
                break
            case "Enum": {
                const num = a.args.find((x) => x.k === "num")
                if (num !== undefined) {
                    problem(num, "[Enum] lists names only, as in [Enum(Soft, Hard, Glow)]; the value is the chosen name's index, from 0")
                    break
                }
                out.control.options = a.args.map((x) => text(x)!)
                out.from.options = a
                break
            }
            case "Header":
            case "Label": {
                const t = one(a, a.name === "Header" ? "a heading" : "a name")
                const f = a.name === "Header" ? "header" : "label"
                if (t !== null) { out.control[f] = t; out.from[f] = a }
                break
            }
            case "Color":
                if (!none(a)) break
                if (TYPE_WIDTH[u.type] < 3) problem(a, `[Color] is for a float3 or a float4, and this is a ${u.type}`)
                else out.colour = true
                break
            case "Hide":
                if (none(a)) { out.control.hide = true; out.from.hide = a }
                break
        }
    }
    return out
}
