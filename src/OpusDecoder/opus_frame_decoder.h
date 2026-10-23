/*
 * Copyright @ 2025 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Portions adapted from wasm-audio-decoders (https://github.com/eshaz/wasm-audio-decoders),
// Copyright (c) Ethan Halsall, whose original source is released under the MIT License: "The
// source code that originates in this project is licensed under the MIT license. Please note
// that any external source code included by repository, such as the decoding libraries included
// as git submodules and compiled into the dist files, may have different licensing terms." The
// 8x8 notice above covers the modifications made in this repository; the MIT permission notice
// is reproduced in NOTICE at the repository root.

#include <stdlib.h>
#include <opus.h>

OpusDecoder *opus_frame_decoder_create(int sample_rate, int channels);

int opus_frame_decode(OpusDecoder *decoder, const unsigned char *in, opus_int32 in_len, opus_int16 *out, int frame_size, int enable_fec);

void opus_frame_decoder_reset(OpusDecoder *decoder);

void opus_frame_decoder_destroy(OpusDecoder *decoder);
