// Copyright 2026 Tetorica contributors. SPDX-License-Identifier: Apache-2.0
#include <stdio.h>
#include <stdlib.h>
#include "dx7.h"

int main(int argc, char** argv) {
  if (argc != 5) {
    fprintf(stderr, "Usage: dx7-reference voice.bin output-frames note off-at-frame\n");
    return 1;
  }
  FILE* voice_file = fopen(argv[1], "rb");
  if (!voice_file) return 2;
  auto* synth = dx7_create();
  const auto read = fread(dx7_voice_ptr(synth), 1, 155, voice_file);
  fclose(voice_file);
  if (read != 155) { dx7_destroy(synth); return 3; }
  dx7_set_voice(synth);
  const int frames = atoi(argv[2]);
  const int note = atoi(argv[3]);
  const int off_at = atoi(argv[4]);
  if (frames < 0 || frames > 10000000 || note < 0 || note > 127 || off_at < 0 || off_at > frames) {
    dx7_destroy(synth); return 4;
  }
  dx7_note_on(synth, note, 100);
  for (int offset = 0; offset < frames;) {
    if (offset == off_at) dx7_note_off(synth, note);
    int count = frames - offset;
    if (count > 1024) count = 1024;
    if (offset < off_at && offset + count > off_at) count = off_at - offset;
    dx7_render(synth, count);
    if (fwrite(dx7_output_ptr(synth), sizeof(float), count, stdout) != static_cast<size_t>(count)) {
      dx7_destroy(synth); return 5;
    }
    offset += count;
  }
  dx7_destroy(synth);
  return 0;
}
