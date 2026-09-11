# `.sl`: the shader language as a file

Phase A of `Specs/SL_TEXT.md`. Source text in, the same `Program` the EDSL
records out.

```hlsl
// plasma.sl
uniform float warp = 0.5;
uniform float hue = 0.5;

float4 main() {
    float2 p = (uv - 0.5) * (warp * 14 + 2);
    float v = sin(p.x + time) + sin(p.y - time * 0.8);
    float n = saturate(v * 0.22 + 0.5);
    return float4(hsv2rgb(float3(frac(hue + n * 0.18), 0.75, n)), 1);
}
```

```ts
import { parse } from "onejs-unity/sl"
const plasma = parse(source, { file: "plasma.sl" })
```

## The one idea

**It is not a second language.** Every construct lowers through the EDSL, so
`sin(x)` in a file is the same `sl.sin(x)` call a TypeScript author would have
written, and the two produce the same graph. `parity.test.ts` asserts that as
hash equality for every GPU fixture and for the example on play.onejs.com: same
hash means same generated shader and same pixels, established without rendering
anything. It also means the existing GPU fixtures, the codegen goldens and the
C# VM tests cover the text form for free, because they run on the IR.

If that property ever breaks, the failure is silent in the worst way: a program
whose hash does not match its generated shader falls back to the VM and nobody
is told. So parity is the test to keep green, not the parser's unit tests.

| File | What it does |
|---|---|
| `lexer.ts` | Characters to tokens, each carrying line and column |
| `ast.ts` | The node shapes, all of them, which is not many |
| `parser.ts` | Pratt parser: shape only, HLSL precedence |
| `check.ts` | Declarations, names, statement shape, budgets, recursion |
| `lower.ts` | AST to IR through the EDSL: SSA, unrolling, `select`, inlining |
| `builtins.ts` | What each name does, keyed by the spelling `ops.ts` gives it |
| `prelude.ts` | The standard library, written in the language |

## Where the types are checked

In `lower.ts`, once, by the EDSL, which computes a width as it records. A
declaration is then an **assertion** against that width rather than an input to
inference. `check.ts` deliberately does no type inference: two implementations
of a type system are two type systems, and the one that would have been written
here is the one nothing else uses.

## What surprises people

**A scalar on the left of an operator broadcasts through a swizzle.** `uv * 8`
is `uv.mul(8)`, one constant node of two components. `8 * uv` is
`sl.float(8).mul(uv)`, a one component constant and a broadcast. Same picture,
different graph, different hash. Write the vector on the left when it matters.

**Literal arithmetic folds; a builtin call never does.** `2 * 3 + 1` is the
constant 7 before the IR sees it. `sin(0.5)` is two instructions, because
folding it would mean a second implementation of `sin` in JavaScript, and a
second implementation is somewhere for the two backends to disagree.

**A hex default makes a uniform a colour.** `uniform float4 tint = #ff8040;`
stores the sRGB components as its default, which is what the host sets and what
the generated shader's Properties block shows, and every read of `tint` goes
through `toLinear`. Without that rule, `#ff8040` written as a literal and
`#ff8040` written as a default would be two different colours in one file.
A default built out of numbers (`float4(1, 0.5, 0.25, 1)`) is not a colour and
is read unconverted.

**A uniform's default has to be written out.** Numbers, constructors of numbers
and colours, and nothing else. It is baked into the program before anything
runs, so it cannot name a const, which could itself name a uniform.

**Shadowing is refused.** A local may not take the name of an input, a uniform,
a texture, a const or a builtin. Allowing it would make "is this a texture?"
depend on where the question is asked, for no gain in a language whose
functions are six lines long. A file function may shadow a *prelude* function,
which is the sanctioned way to replace one.

## Not yet spellable

Three things the EDSL or the opcode table has and a file cannot say. Each is a
recorded gap, not an oversight, and each has its own error message rather than
"unknown identifier".

| | Why |
|---|---|
| `rgb2hsv`, `tex2Dlod` | The opcodes are numbered and **neither backend implements them**. Writing one would render as whatever the VM's dispatch falls through to and fail outright in the HLSL emitter. |
| `fbm`'s simplex base | `sl.fbm(p, octaves, "simplex")` picks the base with a string, and the language has no strings. `fbm(p, octaves)` is the value base, and `turbulence` and `ridged` are the simplex family. |

Related, and worth knowing: **the EDSL lets a program declare 15 textures and
the VM has 4.** `ir.ts` picked its ceiling from the WebGL2 sampler count rather
than from `FxProgram.shader`, which declares `_Tex0` to `_Tex3` and samples
`_Tex3` for every slot past it, so slots 4 and up are silently wrong in the
browser and correct after an eject. A `.sl` file is held to the real number, 4,
reported at the declaration. The EDSL's ceiling is untouched here because
lowering it changes recorded behaviour rather than parser behaviour.

## Errors

Every one carries file, line and column, and an error that starts inside the
EDSL keeps the EDSL's wording. `"z" is component 3 of a vec2, which has 2` is
already the right sentence; what it lacked was a place. `errors.test.ts` checks
the positions as strictly as the words, because a marker under the wrong
character sends the reader to look at something that is fine.

## See also

- `Specs/SL_TEXT.md`, the whole design, including the four decisions taken
- `../README.md`, the IR, the EDSL and the hash this lowers to
- `Specs/SHADER_LANG.md`, the backends
