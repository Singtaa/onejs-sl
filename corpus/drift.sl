// What was drawn moves up a pixel each frame: frame 0 draws blocks, and every
// frame after reads the previous one a pixel lower. The bottom row reads
// itself, as the edge clamps. A previous frame read upside down moves it down.
float4 main() {
    if (frame == 0) return float4(floor(fragCoord / 8) / 8, 0.5, 1);
    return tex2D(previous, uv - float2(0, texel.y));
}
