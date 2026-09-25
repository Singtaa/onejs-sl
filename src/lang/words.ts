/**
 * The words the parser reads as syntax, and the value types.
 *
 * One list, read by the parser (a name may not be one of these) and by
 * `classify` (these highlight as keywords and types), so an editor that
 * highlights with it agrees with the parser by construction rather than by a
 * list it keeps in step by hand.
 */

import { TYPE_WIDTH, type TypeName } from "./ast"

/**
 * Declaration and statement words. `int` is here rather than among the types
 * because it is only ever a for loop's counter, `for (int i = 0; i < 4; i++)`;
 * a value cannot be declared as one.
 */
export const SL_KEYWORDS = ["uniform", "texture2D", "const", "if", "else", "for", "return", "int"] as const

/** The types a value, a uniform or a function can have. */
export const SL_TYPES = Object.keys(TYPE_WIDTH) as readonly TypeName[]

export const KEYWORD_SET: ReadonlySet<string> = new Set(SL_KEYWORDS)
export const TYPE_SET: ReadonlySet<string> = new Set(SL_TYPES)
