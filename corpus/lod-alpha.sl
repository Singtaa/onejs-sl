// An anchor for a fractional tex2Dlod level on a texture with alpha: the level
// runs from 0 at the left edge to 3.5 at the right, through the goldens' edge
// texture, whose levels are transparent black, opaque, half transparent and
// transparent white. A fraction weighs each level's colour by its alpha, so a
// transparent level fades the other out instead of pulling it toward the
// colour it stores.
texture2D edge;
float4 main() { return tex2Dlod(edge, uv, uv.x * 3.5); }
