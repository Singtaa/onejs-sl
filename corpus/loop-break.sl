// A raymarched sphere that stops each ray where it hits (Specs/SL_NEXT.md 3b),
// and a light that circles it: a real loop of at most 64 turns with a break.
float4 main() {
    float2 p = (uv - 0.5) * float2(aspect, 1) * 2;
    float3 ro = float3(0, 0, -3);
    float3 rd = normalize(float3(p, 1.6));
    float t = 0;
    bool hit = false;
    for (int i = 0; i < 64; i++) {
        float d = length(ro + rd * t) - 1;
        if (d < 0.001) { hit = true; break; }
        t += d;
        if (t > 8) break;
    }
    if (!hit) return float4(0.05, 0.05, 0.08, 1);
    float3 n = normalize(ro + rd * t);
    float3 light = normalize(float3(cos(time), 0.6, sin(time)));
    float lit = max(dot(n, light), 0) * 0.9 + 0.1;
    return float4(lit, lit * 0.8, lit * 0.6, 1);
}
