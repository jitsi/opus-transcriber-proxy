// Native libopus bindings for the transcriber proxy.
//
// Exposes two N-API classes — OpusDecoder and OpusEncoder — that wrap libopus'
// opus_decode / opus_encode directly. Unlike @discordjs/opus this surface
// supports the two things the proxy actually needs beyond plain decode/encode:
//   * FEC decode  (opus_decode with decode_fec = 1 on the *next* packet)
//   * PLC decode  (opus_decode with a NULL packet to synthesise loss
//                  concealment audio for a fully missing frame)
// plus an explicit reset (OPUS_RESET_STATE) and encoder bitrate/complexity CTLs.
//
// All buffers cross the boundary as Node Buffers of little-endian interleaved
// 16-bit PCM (decode output / encode input) or raw Opus packets (decode input /
// encode output). Error handling: libopus negative return codes are thrown as
// JS Errors carrying the opus error string; the TypeScript wrappers catch these
// and translate them into their `errors` arrays.

#include <napi.h>
#include <opus.h>

#include <vector>

namespace {

const char* OpusErrorString(int code) {
  switch (code) {
    case OPUS_BAD_ARG:
      return "OPUS_BAD_ARG: One or more invalid/out of range arguments";
    case OPUS_BUFFER_TOO_SMALL:
      return "OPUS_BUFFER_TOO_SMALL: Not enough bytes allocated in the buffer";
    case OPUS_INTERNAL_ERROR:
      return "OPUS_INTERNAL_ERROR: An internal error was detected";
    case OPUS_INVALID_PACKET:
      return "OPUS_INVALID_PACKET: The compressed data passed is corrupted";
    case OPUS_UNIMPLEMENTED:
      return "OPUS_UNIMPLEMENTED: Invalid/unsupported request number";
    case OPUS_INVALID_STATE:
      return "OPUS_INVALID_STATE: An encoder or decoder structure is invalid or already freed";
    case OPUS_ALLOC_FAIL:
      return "OPUS_ALLOC_FAIL: Memory allocation has failed";
    default:
      return "Unknown OPUS error";
  }
}

// Largest decoded frame Opus can produce for one packet: 120 ms at 48 kHz.
constexpr int kMaxFrameSamplesPerChannel = 5760;
// Generous upper bound for a single encoded Opus packet (3 * 1275 + slack).
constexpr int kMaxPacketBytes = 4000;

}  // namespace

class OpusDecoderWrap : public Napi::ObjectWrap<OpusDecoderWrap> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "OpusDecoder",
                       {
                           InstanceMethod("decode", &OpusDecoderWrap::Decode),
                           InstanceMethod("reset", &OpusDecoderWrap::Reset),
                           InstanceMethod("destroy", &OpusDecoderWrap::Destroy),
                       });
  }

  explicit OpusDecoderWrap(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<OpusDecoderWrap>(info) {
    Napi::Env env = info.Env();

    sample_rate_ = info.Length() > 0 && info[0].IsNumber()
                       ? info[0].As<Napi::Number>().Int32Value()
                       : 48000;
    channels_ = info.Length() > 1 && info[1].IsNumber()
                    ? info[1].As<Napi::Number>().Int32Value()
                    : 1;

    int error = OPUS_OK;
    decoder_ = opus_decoder_create(sample_rate_, channels_, &error);
    if (error != OPUS_OK || decoder_ == nullptr) {
      Napi::Error::New(env, OpusErrorString(error)).ThrowAsJavaScriptException();
    }
  }

  ~OpusDecoderWrap() override { DestroyDecoder(); }

 private:
  void DestroyDecoder() {
    if (decoder_ != nullptr) {
      opus_decoder_destroy(decoder_);
      decoder_ = nullptr;
    }
  }

  // decode(packet: Buffer | null, frameSize: number, fec: boolean): Buffer
  //   packet === null/undefined  -> packet-loss concealment (NULL packet)
  //   fec === true               -> recover the previous frame via in-band FEC
  Napi::Value Decode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (decoder_ == nullptr) {
      Napi::Error::New(env, "Decoder freed or not initialized")
          .ThrowAsJavaScriptException();
      return env.Null();
    }

    const unsigned char* data = nullptr;
    opus_int32 len = 0;
    if (info.Length() > 0 && info[0].IsBuffer()) {
      Napi::Buffer<unsigned char> buf = info[0].As<Napi::Buffer<unsigned char>>();
      data = buf.Data();
      len = static_cast<opus_int32>(buf.Length());
    }

    int frame_size = info.Length() > 1 && info[1].IsNumber()
                         ? info[1].As<Napi::Number>().Int32Value()
                         : kMaxFrameSamplesPerChannel;
    if (frame_size <= 0 || frame_size > kMaxFrameSamplesPerChannel) {
      frame_size = kMaxFrameSamplesPerChannel;
    }
    int fec = info.Length() > 2 && info[2].ToBoolean().Value() ? 1 : 0;

    std::vector<opus_int16> pcm(static_cast<size_t>(frame_size) * channels_);
    int samples = opus_decode(decoder_, data, len, pcm.data(), frame_size, fec);
    if (samples < 0) {
      Napi::Error::New(env, OpusErrorString(samples))
          .ThrowAsJavaScriptException();
      return env.Null();
    }

    size_t out_bytes = static_cast<size_t>(samples) * channels_ * sizeof(opus_int16);
    return Napi::Buffer<char>::Copy(env, reinterpret_cast<char*>(pcm.data()),
                                    out_bytes);
  }

  void Reset(const Napi::CallbackInfo& info) {
    if (decoder_ != nullptr) {
      opus_decoder_ctl(decoder_, OPUS_RESET_STATE);
    }
  }

  void Destroy(const Napi::CallbackInfo& info) { DestroyDecoder(); }

  OpusDecoder* decoder_ = nullptr;
  int sample_rate_ = 48000;
  int channels_ = 1;
};

class OpusEncoderWrap : public Napi::ObjectWrap<OpusEncoderWrap> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "OpusEncoder",
                       {
                           InstanceMethod("encode", &OpusEncoderWrap::Encode),
                           InstanceMethod("setBitrate", &OpusEncoderWrap::SetBitrate),
                           InstanceMethod("setComplexity", &OpusEncoderWrap::SetComplexity),
                           InstanceMethod("destroy", &OpusEncoderWrap::Destroy),
                       });
  }

  explicit OpusEncoderWrap(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<OpusEncoderWrap>(info) {
    Napi::Env env = info.Env();

    sample_rate_ = info.Length() > 0 && info[0].IsNumber()
                       ? info[0].As<Napi::Number>().Int32Value()
                       : 48000;
    channels_ = info.Length() > 1 && info[1].IsNumber()
                    ? info[1].As<Napi::Number>().Int32Value()
                    : 1;
    int application = info.Length() > 2 && info[2].IsNumber()
                          ? info[2].As<Napi::Number>().Int32Value()
                          : OPUS_APPLICATION_VOIP;

    int error = OPUS_OK;
    encoder_ = opus_encoder_create(sample_rate_, channels_, application, &error);
    if (error != OPUS_OK || encoder_ == nullptr) {
      Napi::Error::New(env, OpusErrorString(error)).ThrowAsJavaScriptException();
    }
  }

  ~OpusEncoderWrap() override { DestroyEncoder(); }

 private:
  void DestroyEncoder() {
    if (encoder_ != nullptr) {
      opus_encoder_destroy(encoder_);
      encoder_ = nullptr;
    }
  }

  // encode(pcm: Buffer, frameSize: number): Buffer
  //   pcm is little-endian interleaved int16; frameSize is samples per channel.
  Napi::Value Encode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (encoder_ == nullptr) {
      Napi::Error::New(env, "Encoder freed or not initialized")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    if (info.Length() < 1 || !info[0].IsBuffer()) {
      Napi::TypeError::New(env, "Expected pcm Buffer argument")
          .ThrowAsJavaScriptException();
      return env.Null();
    }

    Napi::Buffer<char> buf = info[0].As<Napi::Buffer<char>>();
    const opus_int16* pcm = reinterpret_cast<const opus_int16*>(buf.Data());
    int frame_size = info.Length() > 1 && info[1].IsNumber()
                         ? info[1].As<Napi::Number>().Int32Value()
                         : static_cast<int>(buf.Length() / sizeof(opus_int16) / channels_);

    unsigned char out[kMaxPacketBytes];
    int bytes = opus_encode(encoder_, pcm, frame_size, out, kMaxPacketBytes);
    if (bytes < 0) {
      Napi::Error::New(env, OpusErrorString(bytes))
          .ThrowAsJavaScriptException();
      return env.Null();
    }

    return Napi::Buffer<char>::Copy(env, reinterpret_cast<char*>(out), bytes);
  }

  void SetBitrate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (encoder_ == nullptr || info.Length() < 1 || !info[0].IsNumber()) {
      return;
    }
    int bitrate = info[0].As<Napi::Number>().Int32Value();
    if (opus_encoder_ctl(encoder_, OPUS_SET_BITRATE(bitrate)) != OPUS_OK) {
      Napi::Error::New(env, "Invalid bitrate").ThrowAsJavaScriptException();
    }
  }

  void SetComplexity(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (encoder_ == nullptr || info.Length() < 1 || !info[0].IsNumber()) {
      return;
    }
    int complexity = info[0].As<Napi::Number>().Int32Value();
    if (opus_encoder_ctl(encoder_, OPUS_SET_COMPLEXITY(complexity)) != OPUS_OK) {
      Napi::Error::New(env, "Invalid complexity").ThrowAsJavaScriptException();
    }
  }

  void Destroy(const Napi::CallbackInfo& info) { DestroyEncoder(); }

  OpusEncoder* encoder_ = nullptr;
  int sample_rate_ = 48000;
  int channels_ = 1;
};

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  exports.Set("OpusDecoder", OpusDecoderWrap::Init(env));
  exports.Set("OpusEncoder", OpusEncoderWrap::Init(env));
  return exports;
}

NODE_API_MODULE(opus_native, InitAll)
