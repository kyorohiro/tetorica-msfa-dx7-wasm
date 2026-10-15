// Copyright 2026 Tetorica contributors. SPDX-License-Identifier: Apache-2.0
#include <cassert>
#include <climits>
#include <cstdint>
#include <cstdio>
#include "synth.h"
#include "freqlut.h"
#include "fm_core.h"

int main() {
  Freqlut::init(44100);
  const uint32_t high = static_cast<uint32_t>(Freqlut::lookup(20 * (1 << 24)));
  for (int octave = -11; octave <= 20; ++octave) {
    const int shift = 20 - octave;
    assert(Freqlut::lookup(octave * (1 << 24)) == static_cast<int32_t>(high >> shift));
  }
  for (int octave = 21; octave < 52; ++octave) {
    assert(Freqlut::lookup(octave * (1 << 24)) ==
        static_cast<int32_t>(high << (octave - 20)));
  }
  assert(Freqlut::lookup(-12 * (1 << 24)) == 0);
  assert(Freqlut::lookup(52 * (1 << 24)) == 0);
  assert(Freqlut::lookup(INT_MIN) == 0);
  assert(Freqlut::lookup(INT_MAX) == 0);
  FmCore core;
  FmOpParams params[6] = {};
  for (auto &param : params) {
    param.phase = 0x70000000;
    param.freq = -12345;
  }
  int32_t output[N] = {};
  int32_t feedback[2] = {};
  core.compute(output, params, 31, feedback, 16);
  const auto phase = static_cast<int32_t>(uint32_t{0x70000000} +
      (static_cast<uint32_t>(-12345) << LG_N));
  for (auto &param : params) assert(param.phase == phase);
  std::puts("Frequency bounds: original shifts 0..31, high modular aliases, low silence and signed phase wrap passed (shift UBSan).");
}
