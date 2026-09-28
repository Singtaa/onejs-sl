/**
 * The Unity backend: prints a program as real HLSL, compiled at build time.
 *
 * Phase 3 of `Specs/SHADER_LANG.md` section 6. Unity cannot compile a shader
 * at runtime in a player build, so the editor generates one per program and the
 * build ships it; a browser compiles the web emitters' output instead
 * (`web.ts`). The same source draws both ways with no edit in between.
 *
 * The IR's types become the HLSL types directly, so `float2` is a `float2` and nothing needs padding or
 * explaining. One local per node also gives common subexpression elimination for
 * free: a node is emitted once no matter how many nodes reference it.
 *
 * The generated names are `n<index>` and are unreadable on purpose. Generated
 * code that looks hand written invites hand editing, and a hand edit is lost the
 * next time it is generated.
 */

import { SLError, SL_HASH_VERSION, type Program } from "./ir"
import { emitBody, lit, type BodyTarget } from "./body"

/** The property name a uniform gets. Prefixed so it cannot collide with ours. */
export function uniformProperty(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SLError(`uniform "${name}" is not a usable shader property name`)
    }
    return "_u_" + name
}

export interface EmitOptions {
    /** Shader name. Defaults to a name derived from the program hash. */
    name?: string
    /**
     * Path used for the shared helpers include. Unity resolves this relative to
     * the generated shader's own folder, so a generator writing somewhere other
     * than beside SLCommon.cginc has to say where it went.
     */
    include?: string
}

/**
 * Emits a complete `.shader` for a program.
 *
 * The shader's name carries the program hash, which is how the runtime finds it
 * again. If that link breaks, the program has no shader and draws nothing. See
 * `hashProgram`.
 */
export function emitShader(p: Program, options: EmitOptions = {}): string {
    const name = options.name ?? `Hidden/SLGenerated/${p.hash}`
    const include = options.include ?? "SLCommon.cginc"
    const body = emitFragmentBody(p)

    const props: string[] = [
        `        _Secs ("Seconds", Float) = 0`,
        `        _FlipY ("Flip Y", Float) = 0`,
        `        _Res ("Target size", Vector) = (1, 1, 0, 0)`,
    ]
    const decls: string[] = [`            float _Secs;`, `            float _FlipY;`, `            float4 _Res;`]

    for (const u of p.uniforms) {
        const prop = uniformProperty(u.name)
        // Declared as a float4 whatever its width, so the host sets uniforms the
        // same way for every program and a widening edit does not change the
        // binding. The body swizzles down to the width the program uses.
        const d = [u.value[0] ?? 0, u.value[1] ?? 0, u.value[2] ?? 0, u.value[3] ?? 1]
        props.push(`        ${prop} ("${u.name}", Vector) = (${d.map(lit).join(", ")})`)
        decls.push(`            float4 ${prop};`)
    }
    for (const t of p.textures) {
        props.push(`        _Tex${t.slot} ("${t.name}", 2D) = "white" {}`)
        decls.push(`            sampler2D _Tex${t.slot};`)
    }

    return `// GENERATED from a shader language program. Do not edit.
//
// Source of truth is the program this was emitted from; edits here are lost the
// next time it is generated. The name carries the program hash, which is how the
// runtime pairs the two. See Specs/SHADER_LANG.md section 6. The scheme that
// hash was made under, which a build compares with the apps' manifests:
// SL_HASH_VERSION ${SL_HASH_VERSION}
Shader "${name}"
{
    Properties
    {
${props.join("\n")}
    }

    SubShader
    {
        Cull Off ZWrite Off ZTest Always
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"
            // Shared with the web frame, so every backend computes the same noise.
            #include "${include}"

${decls.join("\n")}

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                // Origin corrected here, so a Unity build is not upside down
                // relative to the same program in a browser.
                o.uv = float2(v.uv.x, lerp(v.uv.y, 1.0 - v.uv.y, _FlipY));
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
${body}
            }
            ENDCG
        }
    }
}
`
}

/**
 * The frame's side of the body: OneJS's names for the inputs, a uniform's
 * material property, and `tex2D` and `tex2Dlod` on the slot's sampler. `sl_toLinear` stays a
 * call because `SLCommon.cginc` decides Gamma or Linear per project, at the
 * shader compile, so this target always emits it.
 */
function unityTarget(p: Program): BodyTarget {
    return {
        // `_Res` is the TARGET's size, set by the host, not `_ScreenParams`.
        //
        // A program is drawn with Graphics.Blit into the element's own render
        // texture, and Unity leaves _ScreenParams at whatever the last camera
        // set: blitting into a 64x256 target reads it as the game view's
        // 1737x1226. So `resolution` and `fragCoord` were the window's and
        // `aspect` was the window's ratio, identically wrong on both backends,
        // which is why nothing caught it. Aspect correction, the thing `aspect`
        // exists for, stretched every circle by the shape of the window it
        // happened to be in.
        inputs: {
            uv: "i.uv",
            fragCoord: "i.uv * _Res.xy",
            resolution: "_Res.xy",
            time: "_Secs",
            aspect: "(_Res.x / max(_Res.y, 1.0))",
        },
        uniform: (slot) => uniformProperty(p.uniforms[slot]!.name),
        sample: (slot, uv) => `tex2D(_Tex${slot}, ${uv})`,
        sampleLevel: (slot, uv, lod) => `tex2Dlod(_Tex${slot}, float4(${uv}, 0.0, ${lod}))`,
        colour: "linear",
        indent: "                ",
        loopAttribute: "[loop]",
    }
}

/** The straight line body: one local per reachable node, in order. */
export function emitFragmentBody(p: Program): string {
    return emitBody(p, unityTarget(p)).body
}
