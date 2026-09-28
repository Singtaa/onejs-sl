// Longer than the VM ever ran: the loop unrolls to several hundred
// instructions, past the 256 the VM had room for, so only a compiled backend
// can draw it. Forty eight soft rings on a circle, each tinted by its place.
// Smooth everywhere, so every backend agrees on it to within a level.
float4 main() {
    float2 p = (uv - 0.5) * 2.0;
    float3 c = 0.0;
    for (int i = 0; i < 48; i++) {
        float a = i * 0.1309;
        float2 q = p - float2(0.6 * cos(a), 0.6 * sin(a));
        float ring = smoothstep(0.06, 0.0, abs(length(q) - 0.2));
        c = c + ring * float3(0.5 + 0.5 * cos(i * 0.4), 0.5 + 0.5 * sin(i * 0.3), 0.6) * 0.12;
    }
    return float4(saturate(c), 1.0);
}
