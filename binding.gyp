{
  "variables": {
    "opus": "src/OpusDecoder/opus",
    "opus_warning_cflags": [
      "-Wno-unused-parameter",
      "-Wno-sign-compare",
      "-Wno-unused-function"
    ],
    # Portable C float build of libopus (no architecture-specific files). The
    # SIMD-accelerated files live in the per-ISA static_library targets below
    # and are selected at *runtime* via libopus' RTCD (x86) or are NEON which
    # is architecturally guaranteed on aarch64.
    "opus_base_sources": [
      "<(opus)/src/opus.c",
      "<(opus)/src/opus_decoder.c",
      "<(opus)/src/opus_encoder.c",
      "<(opus)/src/extensions.c",
      "<(opus)/src/opus_multistream.c",
      "<(opus)/src/opus_multistream_encoder.c",
      "<(opus)/src/opus_multistream_decoder.c",
      "<(opus)/src/repacketizer.c",
      "<(opus)/src/opus_projection_encoder.c",
      "<(opus)/src/opus_projection_decoder.c",
      "<(opus)/src/mapping_matrix.c",
      "<(opus)/src/analysis.c",
      "<(opus)/src/mlp.c",
      "<(opus)/src/mlp_data.c",

      "<(opus)/celt/bands.c",
      "<(opus)/celt/celt.c",
      "<(opus)/celt/celt_encoder.c",
      "<(opus)/celt/celt_decoder.c",
      "<(opus)/celt/cwrs.c",
      "<(opus)/celt/entcode.c",
      "<(opus)/celt/entdec.c",
      "<(opus)/celt/entenc.c",
      "<(opus)/celt/kiss_fft.c",
      "<(opus)/celt/laplace.c",
      "<(opus)/celt/mathops.c",
      "<(opus)/celt/mdct.c",
      "<(opus)/celt/modes.c",
      "<(opus)/celt/pitch.c",
      "<(opus)/celt/celt_lpc.c",
      "<(opus)/celt/quant_bands.c",
      "<(opus)/celt/rate.c",
      "<(opus)/celt/vq.c",

      "<(opus)/silk/CNG.c",
      "<(opus)/silk/code_signs.c",
      "<(opus)/silk/init_decoder.c",
      "<(opus)/silk/decode_core.c",
      "<(opus)/silk/decode_frame.c",
      "<(opus)/silk/decode_parameters.c",
      "<(opus)/silk/decode_indices.c",
      "<(opus)/silk/decode_pulses.c",
      "<(opus)/silk/decoder_set_fs.c",
      "<(opus)/silk/dec_API.c",
      "<(opus)/silk/enc_API.c",
      "<(opus)/silk/encode_indices.c",
      "<(opus)/silk/encode_pulses.c",
      "<(opus)/silk/gain_quant.c",
      "<(opus)/silk/interpolate.c",
      "<(opus)/silk/LP_variable_cutoff.c",
      "<(opus)/silk/NLSF_decode.c",
      "<(opus)/silk/NSQ.c",
      "<(opus)/silk/NSQ_del_dec.c",
      "<(opus)/silk/PLC.c",
      "<(opus)/silk/shell_coder.c",
      "<(opus)/silk/tables_gain.c",
      "<(opus)/silk/tables_LTP.c",
      "<(opus)/silk/tables_NLSF_CB_NB_MB.c",
      "<(opus)/silk/tables_NLSF_CB_WB.c",
      "<(opus)/silk/tables_other.c",
      "<(opus)/silk/tables_pitch_lag.c",
      "<(opus)/silk/tables_pulses_per_block.c",
      "<(opus)/silk/VAD.c",
      "<(opus)/silk/control_audio_bandwidth.c",
      "<(opus)/silk/quant_LTP_gains.c",
      "<(opus)/silk/VQ_WMat_EC.c",
      "<(opus)/silk/HP_variable_cutoff.c",
      "<(opus)/silk/NLSF_encode.c",
      "<(opus)/silk/NLSF_VQ.c",
      "<(opus)/silk/NLSF_unpack.c",
      "<(opus)/silk/NLSF_del_dec_quant.c",
      "<(opus)/silk/process_NLSFs.c",
      "<(opus)/silk/stereo_LR_to_MS.c",
      "<(opus)/silk/stereo_MS_to_LR.c",
      "<(opus)/silk/check_control_input.c",
      "<(opus)/silk/control_SNR.c",
      "<(opus)/silk/init_encoder.c",
      "<(opus)/silk/control_codec.c",
      "<(opus)/silk/A2NLSF.c",
      "<(opus)/silk/ana_filt_bank_1.c",
      "<(opus)/silk/biquad_alt.c",
      "<(opus)/silk/bwexpander_32.c",
      "<(opus)/silk/bwexpander.c",
      "<(opus)/silk/debug.c",
      "<(opus)/silk/decode_pitch.c",
      "<(opus)/silk/inner_prod_aligned.c",
      "<(opus)/silk/lin2log.c",
      "<(opus)/silk/log2lin.c",
      "<(opus)/silk/LPC_analysis_filter.c",
      "<(opus)/silk/LPC_inv_pred_gain.c",
      "<(opus)/silk/table_LSF_cos.c",
      "<(opus)/silk/NLSF2A.c",
      "<(opus)/silk/NLSF_stabilize.c",
      "<(opus)/silk/NLSF_VQ_weights_laroia.c",
      "<(opus)/silk/pitch_est_tables.c",
      "<(opus)/silk/resampler.c",
      "<(opus)/silk/resampler_down2_3.c",
      "<(opus)/silk/resampler_down2.c",
      "<(opus)/silk/resampler_private_AR2.c",
      "<(opus)/silk/resampler_private_down_FIR.c",
      "<(opus)/silk/resampler_private_IIR_FIR.c",
      "<(opus)/silk/resampler_private_up2_HQ.c",
      "<(opus)/silk/resampler_rom.c",
      "<(opus)/silk/sigm_Q15.c",
      "<(opus)/silk/sort.c",
      "<(opus)/silk/sum_sqr_shift.c",
      "<(opus)/silk/stereo_decode_pred.c",
      "<(opus)/silk/stereo_encode_pred.c",
      "<(opus)/silk/stereo_find_predictor.c",
      "<(opus)/silk/stereo_quant_pred.c",
      "<(opus)/silk/LPC_fit.c",

      "<(opus)/silk/float/apply_sine_window_FLP.c",
      "<(opus)/silk/float/corrMatrix_FLP.c",
      "<(opus)/silk/float/encode_frame_FLP.c",
      "<(opus)/silk/float/find_LPC_FLP.c",
      "<(opus)/silk/float/find_LTP_FLP.c",
      "<(opus)/silk/float/find_pitch_lags_FLP.c",
      "<(opus)/silk/float/find_pred_coefs_FLP.c",
      "<(opus)/silk/float/LPC_analysis_filter_FLP.c",
      "<(opus)/silk/float/LTP_analysis_filter_FLP.c",
      "<(opus)/silk/float/LTP_scale_ctrl_FLP.c",
      "<(opus)/silk/float/noise_shape_analysis_FLP.c",
      "<(opus)/silk/float/process_gains_FLP.c",
      "<(opus)/silk/float/regularize_correlations_FLP.c",
      "<(opus)/silk/float/residual_energy_FLP.c",
      "<(opus)/silk/float/warped_autocorrelation_FLP.c",
      "<(opus)/silk/float/wrappers_FLP.c",
      "<(opus)/silk/float/autocorrelation_FLP.c",
      "<(opus)/silk/float/burg_modified_FLP.c",
      "<(opus)/silk/float/bwexpander_FLP.c",
      "<(opus)/silk/float/energy_FLP.c",
      "<(opus)/silk/float/inner_product_FLP.c",
      "<(opus)/silk/float/k2a_FLP.c",
      "<(opus)/silk/float/LPC_inv_pred_gain_FLP.c",
      "<(opus)/silk/float/pitch_analysis_core_FLP.c",
      "<(opus)/silk/float/scale_copy_vector_FLP.c",
      "<(opus)/silk/float/scale_vector_FLP.c",
      "<(opus)/silk/float/schur_FLP.c",
      "<(opus)/silk/float/sort_FLP.c"
    ]
  },

  # Shared include paths and per-architecture feature macros. RTCD (run-time CPU
  # detection) lets libopus probe the *running* CPU and pick SSE/SSE2/SSE4.1/AVX2
  # paths only when present — nothing is presumed on x86. On aarch64 NEON is part
  # of the base ISA, so it is used directly (PRESUME_AARCH64_NEON_INTR); on 32-bit
  # ARM NEON is probed via RTCD.
  "target_defaults": {
    "include_dirs": [
      "native/opus-config",
      "<(opus)",
      "<(opus)/include",
      "<(opus)/celt",
      "<(opus)/silk",
      "<(opus)/silk/float",
      "<(opus)/src"
    ],
    "defines": [ "HAVE_CONFIG_H=1" ],
    "conditions": [
      [ "target_arch in \"x64 ia32\"", {
        "defines": [
          "OPUS_HAVE_RTCD",
          "CPU_INFO_BY_C",
          "OPUS_X86_MAY_HAVE_SSE",
          "OPUS_X86_MAY_HAVE_SSE2",
          "OPUS_X86_MAY_HAVE_SSE4_1",
          "OPUS_X86_MAY_HAVE_AVX2"
        ]
      } ],
      [ "target_arch==\"arm64\"", {
        "defines": [
          "OPUS_ARM_MAY_HAVE_NEON_INTR",
          "OPUS_ARM_PRESUME_NEON_INTR",
          "OPUS_ARM_PRESUME_AARCH64_NEON_INTR"
        ]
      } ],
      [ "target_arch==\"arm\"", {
        "defines": [
          "OPUS_HAVE_RTCD",
          "OPUS_ARM_MAY_HAVE_NEON_INTR"
        ]
      } ]
    ]
  },

  "targets": [
    {
      "target_name": "libopus",
      "type": "static_library",
      "cflags": [ "-fPIC", "<@(opus_warning_cflags)" ],
      "xcode_settings": {
        "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "10.13",
        "OTHER_CFLAGS": [ "<@(opus_warning_cflags)" ]
      },
      "sources": [ "<@(opus_base_sources)" ],
      "conditions": [
        [ "target_arch in \"x64 ia32\"", {
          "sources": [
            "<(opus)/celt/x86/x86cpu.c",
            "<(opus)/celt/x86/x86_celt_map.c",
            "<(opus)/silk/x86/x86_silk_map.c"
          ]
        } ],
        [ "target_arch==\"arm\"", {
          "sources": [
            "<(opus)/celt/arm/armcpu.c",
            "<(opus)/celt/arm/arm_celt_map.c",
            "<(opus)/silk/arm/arm_silk_map.c"
          ]
        } ]
      ]
    },
    {
      "target_name": "opus_native",
      "dependencies": [ "libopus" ],
      "sources": [ "native/opus_addon.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(opus)/include"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.13"
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      },
      "conditions": [
        [ "target_arch in \"x64 ia32\"", {
          "dependencies": [ "libopus_sse", "libopus_sse2", "libopus_sse4_1", "libopus_avx2" ]
        } ],
        [ "target_arch in \"arm64 arm\"", {
          "dependencies": [ "libopus_neon" ]
        } ]
      ]
    }
  ],

  # Per-ISA SIMD object groups. Each is compiled with only its own instruction
  # set enabled, so the resulting code is reached exclusively through libopus'
  # runtime dispatch — the addon never executes an instruction the CPU lacks.
  "conditions": [
    [ "target_arch in \"x64 ia32\"", {
      "targets": [
        {
          "target_name": "libopus_sse",
          "type": "static_library",
          "cflags": [ "-fPIC", "-msse", "<@(opus_warning_cflags)" ],
          "xcode_settings": { "OTHER_CFLAGS": [ "-msse", "<@(opus_warning_cflags)" ], "MACOSX_DEPLOYMENT_TARGET": "10.13" },
          "sources": [ "<(opus)/celt/x86/pitch_sse.c" ]
        },
        {
          "target_name": "libopus_sse2",
          "type": "static_library",
          "cflags": [ "-fPIC", "-msse2", "<@(opus_warning_cflags)" ],
          "xcode_settings": { "OTHER_CFLAGS": [ "-msse2", "<@(opus_warning_cflags)" ], "MACOSX_DEPLOYMENT_TARGET": "10.13" },
          "sources": [
            "<(opus)/celt/x86/pitch_sse2.c",
            "<(opus)/celt/x86/vq_sse2.c"
          ]
        },
        {
          "target_name": "libopus_sse4_1",
          "type": "static_library",
          "cflags": [ "-fPIC", "-msse4.1", "<@(opus_warning_cflags)" ],
          "xcode_settings": { "OTHER_CFLAGS": [ "-msse4.1", "<@(opus_warning_cflags)" ], "MACOSX_DEPLOYMENT_TARGET": "10.13" },
          "sources": [
            "<(opus)/celt/x86/celt_lpc_sse4_1.c",
            "<(opus)/celt/x86/pitch_sse4_1.c",
            "<(opus)/silk/x86/NSQ_sse4_1.c",
            "<(opus)/silk/x86/NSQ_del_dec_sse4_1.c",
            "<(opus)/silk/x86/VAD_sse4_1.c",
            "<(opus)/silk/x86/VQ_WMat_EC_sse4_1.c"
          ]
        },
        {
          "target_name": "libopus_avx2",
          "type": "static_library",
          "cflags": [ "-fPIC", "-mavx2", "-mfma", "-mavx", "<@(opus_warning_cflags)" ],
          "xcode_settings": { "OTHER_CFLAGS": [ "-mavx2", "-mfma", "-mavx", "<@(opus_warning_cflags)" ], "MACOSX_DEPLOYMENT_TARGET": "10.13" },
          "sources": [
            "<(opus)/celt/x86/pitch_avx.c",
            "<(opus)/silk/x86/NSQ_del_dec_avx2.c",
            "<(opus)/silk/float/x86/inner_product_FLP_avx2.c"
          ]
        }
      ]
    } ],
    [ "target_arch in \"arm64 arm\"", {
      "targets": [
        {
          "target_name": "libopus_neon",
          "type": "static_library",
          "cflags": [ "-fPIC", "<@(opus_warning_cflags)" ],
          "xcode_settings": { "OTHER_CFLAGS": [ "<@(opus_warning_cflags)" ], "MACOSX_DEPLOYMENT_TARGET": "10.13" },
          "conditions": [
            [ "target_arch==\"arm\"", { "cflags": [ "-mfpu=neon" ] } ]
          ],
          "sources": [
            "<(opus)/celt/arm/celt_neon_intr.c",
            "<(opus)/celt/arm/pitch_neon_intr.c",
            "<(opus)/silk/arm/biquad_alt_neon_intr.c",
            "<(opus)/silk/arm/LPC_inv_pred_gain_neon_intr.c",
            "<(opus)/silk/arm/NSQ_del_dec_neon_intr.c",
            "<(opus)/silk/arm/NSQ_neon.c"
          ]
        }
      ]
    } ]
  ]
}
