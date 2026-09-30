// An anchor for a fractional tex2Dlod level: the level runs from 0 at the left
// edge to 4.5 at the right. A fraction blends the level below and the level
// above by that fraction, whatever the texture's own filter between levels,
// and past level 3, the smallest, both are level 3.
texture2D t;
float4 main() { return tex2Dlod(t, uv, uv.x * 4.5); }
