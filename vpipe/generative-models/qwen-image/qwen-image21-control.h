#ifndef VPIPE_QWEN_IMAGE21_CONTROL_H
#define VPIPE_QWEN_IMAGE21_CONTROL_H
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>
namespace vpipe::genai::qi21 {
inline bool pack_control_context(const std::vector<float>& chw, int pixels,
                                 int reference_rows, std::vector<std::uint16_t>* out) {
  if (!out || pixels <= 0 || reference_rows < 0 || chw.size() != (std::size_t)pixels * 64) { return false; }
  for (float v : chw) { if (!std::isfinite(v)) { return false; } }
  out->assign(((std::size_t)reference_rows + pixels) * 129, 0);
  for (int i = 0; i < pixels; ++i) {
    for (int c = 0; c < 64; ++c) {
      std::uint32_t u;
      float v = chw[(std::size_t)c * pixels + i];
      std::memcpy(&u, &v, sizeof(u));
      u += 0x7fff + ((u >> 16) & 1);
      (*out)[((std::size_t)reference_rows + i) * 129 + c] = (std::uint16_t)(u >> 16);
    }
  }
  return true;
}
inline int control_skip_for_layer(int layer) {
  return layer >= 0 && layer < 32 && layer % 2 == 0 ? layer / 2 : -1;
}
}
#endif
