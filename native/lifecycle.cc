// Copyright 2026 Tetorica contributors. SPDX-License-Identifier: Apache-2.0
// Test native ownership and initialization without changing the audio adapter.
// Explicit new/delete accounting covers the synth and its sixteen DX7 notes;
// AddressSanitizer independently checks memory access errors.
#include <atomic>
#include <cassert>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <new>
#include "dx7.h"
static std::atomic<long> live_allocations{0};
void* operator new(std::size_t n) {
  if (void* p = std::malloc(n ? n : 1)) { ++live_allocations; return p; }
  throw std::bad_alloc();
}
void* operator new[](std::size_t n) { return ::operator new(n); }
void operator delete(void* p) noexcept { if (p) { --live_allocations; std::free(p); } }
void operator delete[](void* p) noexcept { ::operator delete(p); }
void operator delete(void* p, std::size_t) noexcept { ::operator delete(p); }
void operator delete[](void* p, std::size_t) noexcept { ::operator delete(p); }
static void load(void* h) {
  auto* voice = dx7_voice_ptr(h);
  std::memset(voice, 0, 155);
  for (int op = 0; op < 6; ++op) {
    auto* p = voice + op * 21;
    p[0] = p[1] = p[2] = 99; p[3] = 70;
    p[4] = p[5] = p[6] = 99; p[7] = 0;
    p[16] = op == 5 ? 85 : 0; p[18] = 1; p[20] = 7;
  }
  for (int i = 126; i < 130; ++i) voice[i] = 99;
  for (int i = 130; i < 134; ++i) voice[i] = 50;
  voice[134] = 31; voice[136] = 1; voice[144] = 24;
  dx7_set_voice(h);
}
int main() {
  // Exclude any one-time C++ library initialization from the ownership count.
  auto* warm = dx7_create(); load(warm); dx7_note_on(warm, 69, 100);
  dx7_render(warm, 128); dx7_destroy(warm);
  const auto baseline = live_allocations.load();
  for (int i = 0; i < 1000; ++i) {
    // Creating/destroying another core must not change the first core.
    auto* a = dx7_create(); load(a);
    auto* b = dx7_create(); load(b);
    dx7_select_voice(a, 17); dx7_select_voice(b, 17);
    dx7_note_on(a, 69, 100); dx7_note_on(b, 69, 100);
    dx7_render(a, 63); dx7_render(b, 63);
    assert(std::memcmp(dx7_output_ptr(a), dx7_output_ptr(b), 63 * sizeof(float)) == 0);
    dx7_destroy(b);
    const auto before_edit = live_allocations.load();
    dx7_voice_ptr(a)[5 * 21 + 16] = 70;
    dx7_voice_ptr(a)[5 * 21 + 18] = 2;
    dx7_voice_ptr(a)[135] = 7;
    dx7_edit_voice(a, 17);
    assert(live_allocations.load() == before_edit);
    // Exercise partial-block leftovers, release, and replacement ownership.
    dx7_render(a, 128); dx7_all_notes_off(a); dx7_render(a, 129);
    dx7_panic(a); dx7_render(a, 67);
    for (int j = 0; j < 67; ++j) assert(dx7_output_ptr(a)[j] == 0);
    dx7_note_on(a, 60, 100); dx7_render(a, 128); dx7_destroy(a);
    assert(live_allocations.load() == baseline);
  }
  std::printf("ASAN lifecycle: 2000 create/destroy, 1000 panic cycles; live allocation delta %ld; independent PCM and panic silence passed.\n", live_allocations.load() - baseline);
}
