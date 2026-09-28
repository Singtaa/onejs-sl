// texel and centered, the inputs built from the others (Specs/SL_NEXT.md 6).
// A ring that stays round in any output shape, over cells 16 pixels wide.
float4 main() {
    float ring = smoothstep(0.02, 0.0, abs(length(centered) - 0.3));
    float2 cell = frac(uv / (texel * 16.0));
    return float4(ring, cell, 1);
}
