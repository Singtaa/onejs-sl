/**
 * The words the parser reads as syntax, and the value types.
 *
 * One list, read by the parser (a name may not be one of these) and by
 * `classify` (these highlight as keywords and types), so an editor that
 * highlights with it agrees with the parser by construction rather than by a
 * list it keeps in step by hand.
 */

import { TYPE_WIDTH, type TypeName } from "./ast"

/** Declaration and statement words, and the two bool literals. */
export const SL_KEYWORDS = [
    "uniform", "texture2D", "const", "if", "else", "for", "while", "break", "continue", "switch", "case", "default",
    "return", "true", "false",
] as const

/** The types a value, a uniform or a function can have. */
export const SL_TYPES = Object.keys(TYPE_WIDTH) as readonly TypeName[]

export const KEYWORD_SET: ReadonlySet<string> = new Set(SL_KEYWORDS)
export const TYPE_SET: ReadonlySet<string> = new Set(SL_TYPES)
