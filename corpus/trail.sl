// A fading trail: a spark circles, and what it leaves behind halves every third
// of a second. Scaled by deltaTime, it fades the same at any frame rate.
float4 main() {
    float4 last = tex2D(previous, uv);
    float2 at = 0.5 + 0.3 * float2(cos(time * 6), sin(time * 6));
    float spark = smoothstep(0.08, 0.02, length(uv - at));
    return max(last * pow(0.5, deltaTime * 3), float4(1, 0.6, 0.2, 1) * spark);
}
