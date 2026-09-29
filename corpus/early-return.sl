// A circular window that computes its plasma only inside (Specs/SL_NEXT.md 3a):
// the early return puts the rest of main on the other side of one real branch,
// and the texture read after it is in flow that differs per pixel, so every
// backend samples it at level 0.
texture2D t;
float4 main() {
    float2 p = uv - 0.5;
    if (length(p) > 0.45) return float4(0, 0, 0, 0);
    float v = fbm(p * 5 + time * 0.2, 4);
    float4 c = tex2D(t, uv);
    return float4(lerp(c.rgb, float3(v, v * 0.6, 1 - v), 0.5), 1);
}
