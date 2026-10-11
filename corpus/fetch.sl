// An anchor for tex2Dfetch and textureSize. The left half fetches texels at
// pixels from -1 to 9, which hold at the edge texels past 0 and 7. The right
// half samples the same texture as it is set, at texel centres, so one texture
// is read both ways and both are exact. Blue is the texture's width over 16,
// which is 0.5.
texture2D t;
float4 main() {
    float2 size = textureSize(t);
    float2 centre = (floor(uv * size) + 0.5) / size;
    float4 c = uv.x < 0.5 ? tex2Dfetch(t, uv * 10 - 1) : tex2D(t, centre);
    return float4(c.rg, size.x / 16, 1);
}
