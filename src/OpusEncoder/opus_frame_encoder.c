#include <opus.h>
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    OpusEncoder *encoder;
    int sample_rate;
    int channels;
    int frame_size;
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

    return encoded_bytes;
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
