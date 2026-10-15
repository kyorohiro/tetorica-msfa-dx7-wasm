// Copyright 2026 Tetorica contributors. SPDX-License-Identifier: Apache-2.0
// Native probe for the live-control ABI, envelope state and cohort isolation.
#include <cassert>
#include <cstdio>
#include <cstring>
#include "synth.h"
#include "env.h"
#include "dx7.h"

static int output(int level) { return Env::scaleoutlevel(level) * 32; }
static void envelope_probe() {
  const int rates[4] = {99, 99, 99, 70};
  const int levels[4] = {99, 99, 99, 0};
  Env a, reference, silent;
  a.init(rates, levels, output(85), 0);
  reference.init(rates, levels, output(65), 0);
  silent.init(rates, levels, output(0), 0);
  for (int i = 0; i < 128; ++i) {
    a.getsample(); reference.getsample(); silent.getsample();
  }
  a.setoutlevel(output(65));
  assert(a.getsample() == reference.getsample());
  silent.setoutlevel(output(65));
  assert(silent.getsample() == reference.getsample());
  for (int i = 0; i < 100; ++i) {
    a.setoutlevel(output(0));
    a.getsample();
    a.setoutlevel(output(65));
    assert(a.getsample() == reference.getsample());
  }
  // The output-level delta preserves elapsed release rather than retriggering.
  a.setoutlevel(output(85));
  a.keydown(false); reference.keydown(false);
  for (int i = 0; i < 8; ++i) { a.getsample(); reference.getsample(); }
  a.setoutlevel(output(65));
  assert(a.getsample() == reference.getsample());
  for (int i = 0; i < 10000; ++i) a.getsample();
  const auto ended = a.getsample();
  assert(ended == (16 << 16));
  a.setoutlevel(output(99));
  assert(a.getsample() == ended);

  // Mute is attenuation: it must not consume the still-progressing slow tail.
  const int slow_rates[4] = {99, 99, 99, 0};
  a.init(slow_rates, levels, output(85), 0);
  reference.init(slow_rates, levels, output(85), 0);
  for (int i = 0; i < 128; ++i) { a.getsample(); reference.getsample(); }
  a.keydown(false); reference.keydown(false);
  a.setoutlevel(output(0));
  for (int i = 0; i < 128; ++i) { a.getsample(); reference.getsample(); }
  a.setoutlevel(output(85));
  assert(a.getsample() == reference.getsample());

  // Both live paths retain the same attack progression even while one is muted.
  const int attack_rates[4] = {35, 99, 99, 70};
  a.init(attack_rates, levels, output(85), 0);
  reference.init(attack_rates, levels, output(85), 0);
  a.getsample(); reference.getsample();
  a.setoutlevel(output(0));
  reference.setoutlevel(output(84)); reference.setoutlevel(output(85));
  for (int i = 0; i < 16; ++i) { a.getsample(); reference.getsample(); }
  a.setoutlevel(output(85));
  assert(a.getsample() == reference.getsample());
}

static void load(void* synth, uint32_t id) {
  auto* voice = dx7_voice_ptr(synth);
  std::memset(voice, 0, 155);
  for (int op = 0; op < 6; ++op) {
    auto* p = voice + op * 21;
    p[0] = p[1] = p[2] = 99; p[3] = 70;
    p[4] = p[5] = p[6] = 99;
    p[16] = op == 5 ? 85 : 0; p[18] = 1; p[20] = 7;
  }
  for (int i = 126; i < 130; ++i) voice[i] = 99;
  for (int i = 130; i < 134; ++i) voice[i] = 50;
  voice[134] = 31; voice[136] = 1; voice[144] = 24;
  dx7_select_voice(synth, id);
}

static void same(void* a, void* b, int count) {
  dx7_render(a, count); dx7_render(b, count);
  assert(std::memcmp(dx7_output_ptr(a), dx7_output_ptr(b), count * sizeof(float)) == 0);
}

static void adapter_probe() {
  auto* a = dx7_create(); auto* b = dx7_create();
  load(a, 1); load(b, 1);
  dx7_note_on(a, 69, 100); dx7_note_on(b, 69, 100);
  same(a, b, 1001);
  // No-op edits and partial-block leftovers are bit exact.
  dx7_edit_voice(a, 1);
  same(a, b, 1024);
  // Slot 2 has no notes. Editing it must leave slot 1's notes alone.
  dx7_select_voice(a, 2); dx7_select_voice(b, 2);
  dx7_voice_ptr(a)[5 * 21 + 16] = 0;
  dx7_edit_voice(a, 2);
  same(a, b, 1024);
  // Reselecting slot 1 recovers its cohort and a level edit is audible.
  load(a, 1); load(b, 1);
  dx7_voice_ptr(a)[5 * 21 + 16] = 0;
  dx7_edit_voice(a, 1);
  dx7_render(a, 1024); dx7_render(b, 1024);
  assert(std::memcmp(dx7_output_ptr(a), dx7_output_ptr(b), 1024 * sizeof(float)) != 0);
  // Panic must restore the selected identity, so later notes remain editable.
  dx7_panic(a);
  dx7_note_on(a, 69, 100); dx7_render(a, 1024);
  dx7_voice_ptr(a)[5 * 21 + 16] = 85;
  dx7_edit_voice(a, 1); dx7_render(a, 1024);
  float peak = 0;
  for (int i = 0; i < 1024; ++i) {
    float value = dx7_output_ptr(a)[i];
    if (value < 0) value = -value;
    if (value > peak) peak = value;
  }
  assert(peak > 0.001f);
  dx7_destroy(a); dx7_destroy(b);
}

int main() {
  envelope_probe();
  adapter_probe();
  std::puts("Live native: reversible held level, preserved release, no resurrection, no-op PCM, cohort isolation, panic identity passed.");
}
