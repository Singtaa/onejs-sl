// The previous frame plus 1/256 each frame (Specs/SL_NEXT.md 4). The history
// starts clear, so frame N holds (N + 1) / 256 in red, green and blue exactly:
// a missed swap, a step taken twice, or history kept at 8 bits all show.
float4 main() {
    float4 last = tex2D(previous, uv);
    return float4(last.rgb + 1.0 / 256.0, 1);
}
