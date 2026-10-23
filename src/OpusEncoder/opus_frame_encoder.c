/*
 * Copyright @ 2025 - Present, 8x8 Inc
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

#include <opus.h>
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    OpusEncoder *encoder;
    int sample_rate;
    int channels;
    int frame_size;
    // Whether the most recently encoded frame was a DTX (discontinuous-transmission) frame, per
    // OPUS_GET_IN_DTX. Meaningful only when DTX is enabled; read via opus_frame_encoder_get_last_in_dtx.
    int last_in_dtx;
} opus_encoder_context;

EMSCRIPTEN_KEEPALIVE
opus_encoder_context* opus_frame_encoder_create(int sample_rate, int channels, int application) {
    int error;
    opus_encoder_context *ctx = (opus_encoder_context*)malloc(sizeof(opus_encoder_context));

    if (!ctx) {
        return NULL;
    }

    ctx->encoder = opus_encoder_create(sample_rate, channels, application, &error);

    if (error != OPUS_OK || !ctx->encoder) {
        free(ctx);
        return NULL;
    }

    ctx->sample_rate = sample_rate;
    ctx->channels = channels;
    // Frame size for 20ms at the given sample rate
    ctx->frame_size = sample_rate / 50;  // 20ms frames
    ctx->last_in_dtx = 0;

    return ctx;
}

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_get_frame_size(opus_encoder_context *ctx) {
    return ctx ? ctx->frame_size : 0;
}

EMSCRIPTEN_KEEPALIVE
int opus_frame_encode(
    opus_encoder_context *ctx,
    const unsigned char *pcm_data,
    int pcm_length,
    unsigned char *output_buffer,
    int output_buffer_size
) {
    if (!ctx || !ctx->encoder || !pcm_data || !output_buffer) {
        return -1;
    }

    // pcm_length is in bytes, convert to samples
    int num_samples = pcm_length / sizeof(opus_int16) / ctx->channels;

    // Encode the frame
    int encoded_bytes = opus_encode(
        ctx->encoder,
        (const opus_int16*)pcm_data,
        num_samples,
        output_buffer,
        output_buffer_size
    );

    // Record whether libopus emitted this as a DTX frame (only meaningful when DTX is enabled). On a
    // ctl failure leave the flag cleared so a frame is never falsely reported as silence.
    if (encoded_bytes >= 0) {
        int in_dtx = 0;
        if (opus_encoder_ctl(ctx->encoder, OPUS_GET_IN_DTX(&in_dtx)) == OPUS_OK) {
            ctx->last_in_dtx = in_dtx;
        } else {
            ctx->last_in_dtx = 0;
        }
    } else {
        // Encode failed: clear the flag so a stale value can't be read as a false DTX (the JS wrapper
        // throws on a negative return before reading it, so this is belt-and-suspenders).
        ctx->last_in_dtx = 0;
    }

    return encoded_bytes;
}

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_get_last_in_dtx(opus_encoder_context *ctx) {
    return ctx ? ctx->last_in_dtx : 0;
}

EMSCRIPTEN_KEEPALIVE
void opus_frame_encoder_destroy(opus_encoder_context *ctx) {
    if (ctx) {
        if (ctx->encoder) {
            opus_encoder_destroy(ctx->encoder);
        }
        free(ctx);
    }
}

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_set_bitrate(opus_encoder_context *ctx, int bitrate) {
    if (!ctx || !ctx->encoder) {
        return -1;
    }
    return opus_encoder_ctl(ctx->encoder, OPUS_SET_BITRATE(bitrate));
}

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_set_complexity(opus_encoder_context *ctx, int complexity) {
    if (!ctx || !ctx->encoder) {
        return -1;
    }
    return opus_encoder_ctl(ctx->encoder, OPUS_SET_COMPLEXITY(complexity));
}

EMSCRIPTEN_KEEPALIVE
int opus_frame_encoder_set_dtx(opus_encoder_context *ctx, int enable) {
    if (!ctx || !ctx->encoder) {
        return -1;
    }
    if (enable) {
        // DTX only takes effect under VBR. VBR is libopus's default, but enforce it here so a later
        // CBR change can't silently disable DTX (and with it the voice detection built on OPUS_GET_IN_DTX).
        int vbr_ret = opus_encoder_ctl(ctx->encoder, OPUS_SET_VBR(1));
        if (vbr_ret != OPUS_OK) {
            return vbr_ret;
        }
    }
    return opus_encoder_ctl(ctx->encoder, OPUS_SET_DTX(enable ? 1 : 0));
}
