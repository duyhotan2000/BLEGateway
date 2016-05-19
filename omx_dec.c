/*
 * OMX Video encoder
 * Copyright (C) 2011 Martin Storsjo
 *
 * This file is part of Libav.
 *
 * Libav is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * Libav is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with Libav; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

#include "config.h"

#if CONFIG_OMX_RPI
#define OMX_SKIP64BIT
#endif

#include <dlfcn.h>
#include <OMX_Core.h>
#include <OMX_Component.h>
#include <OMXR_Extension_video.h>
#include <OMXR_Extension_vdcmn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include "libavutil/avstring.h"
#include "libavutil/avutil.h"
#include "libavutil/common.h"
#include "libavutil/imgutils.h"
#include "libavutil/log.h"
#include "libavutil/opt.h"

#include "avcodec.h"
#include "h264.h"
#include "internal.h"
#include "mmngr_buf_user_public.h"
#include "mmngr_user_public.h"

#ifdef OMX_SKIP64BIT
static OMX_TICKS to_omx_ticks(int64_t value)
{
    OMX_TICKS s;
    s.nLowPart  = value & 0xffffffff;
    s.nHighPart = value >> 32;
    return s;
}
static int64_t from_omx_ticks(OMX_TICKS value)
{
    return (((int64_t)value.nHighPart) << 32) | value.nLowPart;
}
#else
#define to_omx_ticks(x) (x)
#define from_omx_ticks(x) (x)
#endif

#define INIT_STRUCT(x) do {                                               \
        x.nSize = sizeof(x);                                              \
        x.nVersion = s->version;                                          \
    } while (0)
#define CHECK(x) do {                                                     \
        if (x != OMX_ErrorNone) {                                         \
            av_log(avctx, AV_LOG_ERROR,                                   \
                   "err %x (%d) on line %d\n", x, x, __LINE__);           \
            return AVERROR_UNKNOWN;                                       \
        }                                                                 \
    } while (0)


typedef struct OMXContext {
    void *lib;
    void *lib2;
    OMX_ERRORTYPE (*ptr_Init)(void);
    OMX_ERRORTYPE (*ptr_Deinit)(void);
    OMX_ERRORTYPE (*ptr_ComponentNameEnum)(OMX_STRING, OMX_U32, OMX_U32);
    OMX_ERRORTYPE (*ptr_GetHandle)(OMX_HANDLETYPE*, OMX_STRING, OMX_PTR, OMX_CALLBACKTYPE*);
    OMX_ERRORTYPE (*ptr_FreeHandle)(OMX_HANDLETYPE);
    OMX_ERRORTYPE (*ptr_GetComponentsOfRole)(OMX_STRING, OMX_U32*, OMX_U8**);
    OMX_ERRORTYPE (*ptr_GetRolesOfComponent)(OMX_STRING, OMX_U32*, OMX_U8**);
    void (*host_init)(void);

    void *mmngr_lib;
    int (*ptr_mmngr_export_start_in_user)(int*, size_t, unsigned int, int*);
} OMXContext;

static av_cold void *dlsym_prefixed(void *handle, const char *symbol, const char *prefix)
{
    char buf[50];
    snprintf(buf, sizeof(buf), "%s%s", prefix ? prefix : "", symbol);
    return dlsym(handle, buf);
}

static av_cold int mmngr_try_load(OMXContext *s, void *logctx)
{
    s->mmngr_lib = dlopen("libmmngrbuf.so", RTLD_NOW | RTLD_GLOBAL);
    if (!s->mmngr_lib) {
        av_log(logctx, AV_LOG_WARNING, "libmmngrbuf.so not found\n");
        return AVERROR_DECODER_NOT_FOUND;
    }
    s->ptr_mmngr_export_start_in_user = dlsym(s->mmngr_lib, "mmngr_export_start_in_user");
    if (!s->ptr_mmngr_export_start_in_user) {
        av_log(logctx, AV_LOG_WARNING, "mmngr_export_start_in_user not found\n");
        dlclose(s->mmngr_lib);
        s->mmngr_lib = NULL;
        return AVERROR_DECODER_NOT_FOUND;
    }
    return 0;
}

static av_cold int omx_try_load(OMXContext *s, void *logctx,
                                const char *libname, const char *prefix,
                                const char *libname2)
{
    if (libname2) {
        s->lib2 = dlopen(libname2, RTLD_NOW | RTLD_GLOBAL);
        if (!s->lib2) {
            av_log(logctx, AV_LOG_WARNING, "%s not found\n", libname);
            return AVERROR_DECODER_NOT_FOUND;
        }
        s->host_init = dlsym(s->lib2, "bcm_host_init");
        if (!s->host_init) {
            av_log(logctx, AV_LOG_WARNING, "bcm_host_init not found\n");
            dlclose(s->lib2);
            s->lib2 = NULL;
            return AVERROR_DECODER_NOT_FOUND;
        }
    }
    s->lib = dlopen(libname, RTLD_NOW | RTLD_GLOBAL);
    if (!s->lib) {
        av_log(logctx, AV_LOG_WARNING, "%s not found\n", libname);
        return AVERROR_DECODER_NOT_FOUND;
    }
    s->ptr_Init                = dlsym_prefixed(s->lib, "OMX_Init", prefix);
    s->ptr_Deinit              = dlsym_prefixed(s->lib, "OMX_Deinit", prefix);
    s->ptr_ComponentNameEnum   = dlsym_prefixed(s->lib, "OMX_ComponentNameEnum", prefix);
    s->ptr_GetHandle           = dlsym_prefixed(s->lib, "OMX_GetHandle", prefix);
    s->ptr_FreeHandle          = dlsym_prefixed(s->lib, "OMX_FreeHandle", prefix);
    s->ptr_GetComponentsOfRole = dlsym_prefixed(s->lib, "OMX_GetComponentsOfRole", prefix);
    s->ptr_GetRolesOfComponent = dlsym_prefixed(s->lib, "OMX_GetRolesOfComponent", prefix);
    if (!s->ptr_Init || !s->ptr_Deinit || !s->ptr_ComponentNameEnum ||
        !s->ptr_GetHandle || !s->ptr_FreeHandle ||
        !s->ptr_GetComponentsOfRole || !s->ptr_GetRolesOfComponent) {
        av_log(logctx, AV_LOG_WARNING, "Not all functions found in %s\n", libname);
        dlclose(s->lib);
        s->lib = NULL;
        if (s->lib2)
            dlclose(s->lib2);
        s->lib2 = NULL;
        return AVERROR_DECODER_NOT_FOUND;
    }
    return 0;
}

static av_cold OMXContext *omx_init(void *logctx, const char *libname, const char *prefix)
{
    static const char * const libnames[] = {
#if CONFIG_OMX_RPI
        "/opt/vc/lib/libopenmaxil.so", "/opt/vc/lib/libbcm_host.so",
#else
        "libomxr_core.so", NULL,
#endif
        NULL
    };
    const char* const* nameptr;
    int ret = AVERROR_DECODER_NOT_FOUND;
    OMXContext *omx_context;

    omx_context = av_mallocz(sizeof(*omx_context));
    if (!omx_context)
        return NULL;
    if (libname) {
        ret = omx_try_load(omx_context, logctx, libname, prefix, NULL);
        if (ret < 0) {
            av_free(omx_context);
            return NULL;
        }
    } else {
        for (nameptr = libnames; *nameptr; nameptr += 2)
        {
            if (!(ret = omx_try_load(omx_context, logctx, nameptr[0], prefix, nameptr[1])))
                break;
        }
        if (!*nameptr) {
            av_free(omx_context);
            return NULL;
        }
    }

    if (omx_context->host_init)
        omx_context->host_init();
    omx_context->ptr_Init();
    return omx_context;
}

static av_cold void omx_deinit(OMXContext *omx_context)
{
    if (!omx_context)
        return;
    omx_context->ptr_Deinit();
    dlclose(omx_context->lib);
    av_free(omx_context);
}

typedef struct OMXCodecContext {
    const AVClass *class;
    char *libname;
    char *libprefix;
    OMXContext *omx_context;

    AVCodecContext *avctx;

    char component_name[OMX_MAX_STRINGNAME_SIZE];
    OMX_VERSIONTYPE version;
    OMX_HANDLETYPE handle;
    int in_port, out_port;
    int out_port_buffer_size;
    OMX_COLOR_FORMATTYPE color_format;
    int stride, plane_size;

    int num_in_buffers, num_out_buffers;
    OMX_BUFFERHEADERTYPE **in_buffer_headers;
    OMX_BUFFERHEADERTYPE **out_buffer_headers;
    int num_free_in_buffers;
    OMX_BUFFERHEADERTYPE **free_in_buffers;
    int num_done_out_buffers;
    OMX_BUFFERHEADERTYPE **done_out_buffers;
    pthread_mutex_t input_mutex;
    pthread_cond_t input_cond;
    pthread_mutex_t output_mutex;
    pthread_cond_t output_cond;

    pthread_mutex_t state_mutex;
    pthread_cond_t state_cond;
    OMX_STATETYPE state;
    OMX_ERRORTYPE error;

    int mutex_cond_inited;

    int num_in_frames, num_out_frames;

    uint8_t *output_buf;
    int output_buf_size;
    uint8_t *input_buf;
    int input_buf_size;

    int input_zerocopy;
    int firstFrame;

    AVBitStreamFilterContext *avbsfc;
    int mmngr_id[3];

} OMXCodecContext;

static void append_buffer(pthread_mutex_t *mutex, pthread_cond_t *cond,
                          int* array_size, OMX_BUFFERHEADERTYPE **array,
                          OMX_BUFFERHEADERTYPE *buffer)
{
    pthread_mutex_lock(mutex);
    array[(*array_size)++] = buffer;
    pthread_cond_broadcast(cond);
    pthread_mutex_unlock(mutex);
}

static OMX_BUFFERHEADERTYPE *get_buffer(pthread_mutex_t *mutex, pthread_cond_t *cond,
                                        int* array_size, OMX_BUFFERHEADERTYPE **array,
                                        int wait)
{
    OMX_BUFFERHEADERTYPE *buffer;
    pthread_mutex_lock(mutex);
    if (wait) {
        while (!*array_size){
           pthread_cond_wait(cond, mutex);
        }
       
    }
    if (*array_size > 0) {
        buffer = array[0];
        (*array_size)--;
        memmove(&array[0], &array[1], (*array_size) * sizeof(OMX_BUFFERHEADERTYPE*));
    } else {
        buffer = NULL;
    }
    pthread_mutex_unlock(mutex);
    return buffer;
}

static OMX_ERRORTYPE event_handler(OMX_HANDLETYPE component, OMX_PTR app_data, OMX_EVENTTYPE event,
                                   OMX_U32 data1, OMX_U32 data2, OMX_PTR event_data)
{
    OMXCodecContext *s = app_data;
    // This uses casts in the printfs, since OMX_U32 actually is a typedef for
    // unsigned long in official header versions (but there are also modified
    // versions where it is something else).
    switch (event) {
    case OMX_EventError:
        pthread_mutex_lock(&s->state_mutex);
        av_log(s->avctx, AV_LOG_ERROR, "OMX error %"PRIx32"\n", (uint32_t) data1);
        s->error = data1;
        pthread_cond_broadcast(&s->state_cond);
        pthread_mutex_unlock(&s->state_mutex);
        break;
    case OMX_EventCmdComplete:
        if (data1 == OMX_CommandStateSet) {
            pthread_mutex_lock(&s->state_mutex);
            s->state = data2;
            av_log(s->avctx, AV_LOG_VERBOSE, "OMX state changed to %"PRIu32"\n", (uint32_t) data2);
            pthread_cond_broadcast(&s->state_cond);
            pthread_mutex_unlock(&s->state_mutex);
        } else if (data1 == OMX_CommandPortDisable) {
            av_log(s->avctx, AV_LOG_VERBOSE, "OMX port %"PRIu32" disabled\n", (uint32_t) data2);
        } else if (data1 == OMX_CommandPortEnable) {
            av_log(s->avctx, AV_LOG_VERBOSE, "OMX port %"PRIu32" enabled\n", (uint32_t) data2);
        } else {
            av_log(s->avctx, AV_LOG_VERBOSE, "OMX command complete, command %"PRIu32", value %"PRIu32"\n",
                                             (uint32_t) data1, (uint32_t) data2);
        }
        break;
    case OMX_EventPortSettingsChanged:
        av_log(s->avctx, AV_LOG_VERBOSE, "OMX port %"PRIu32" settings changed\n", (uint32_t) data1);
        break;
    default:
        av_log(s->avctx, AV_LOG_VERBOSE, "OMX event %d %"PRIx32" %"PRIx32"\n",
                                         event, (uint32_t) data1, (uint32_t) data2);
        break;
    }
    return OMX_ErrorNone;
}

static OMX_ERRORTYPE empty_buffer_done(OMX_HANDLETYPE component, OMX_PTR app_data,
                                       OMX_BUFFERHEADERTYPE *buffer)
{
    OMXCodecContext *s = app_data;
    if (s->input_zerocopy) {
        if (buffer->pAppPrivate) {
            if (buffer->pOutputPortPrivate)
                av_free(buffer->pAppPrivate);
            else
                av_frame_free((AVFrame**)&buffer->pAppPrivate);
            buffer->pAppPrivate = NULL;
        }
    }
    append_buffer(&s->input_mutex, &s->input_cond,
                  &s->num_free_in_buffers, s->free_in_buffers, buffer);
    return OMX_ErrorNone;
}

static OMX_ERRORTYPE fill_buffer_done(OMX_HANDLETYPE component, OMX_PTR app_data,
                                      OMX_BUFFERHEADERTYPE *buffer)
{
    OMXCodecContext *s = app_data;
    append_buffer(&s->output_mutex, &s->output_cond,
                  &s->num_done_out_buffers, s->done_out_buffers, buffer);
    return OMX_ErrorNone;
}

static const OMX_CALLBACKTYPE callbacks = {
    event_handler,
    empty_buffer_done,
    fill_buffer_done
};

static av_cold int find_component(OMXContext *omx_context, void *logctx,
                                  const char *role, char *str, int str_size)
{
    OMX_U32 i, num = 0;
    char **components;
    int ret = 0;

//#if CONFIG_OMX_RPI
//     if (av_strstart(role, "video_encoder.", NULL)) {
//         av_strlcpy(str, "OMX.broadcom.video_encode", str_size);
//         return 0;
//     }
// #endif

    if (av_strstart(role, "video_decoder.", NULL)) {
        av_strlcpy(str, "OMX.RENESAS.VIDEO.DECODER.H264", str_size);
        return 0;
    }

    omx_context->ptr_GetComponentsOfRole((OMX_STRING) role, &num, NULL);
    if (!num) {
        av_log(logctx, AV_LOG_WARNING, "No component for role %s found\n", role);
        return AVERROR_DECODER_NOT_FOUND;
    }
    components = av_mallocz(sizeof(char*) * num);
    if (!components)
        return AVERROR(ENOMEM);
    for (i = 0; i < num; i++) {
        components[i] = av_mallocz(OMX_MAX_STRINGNAME_SIZE);
        if (!components) {
            ret = AVERROR(ENOMEM);
            goto end;
        }
    }
    omx_context->ptr_GetComponentsOfRole((OMX_STRING) role, &num, (OMX_U8**) components);
    av_strlcpy(str, components[0], str_size);
end:
    for (i = 0; i < num; i++)
        av_free(components[i]);
    av_free(components);
    return ret;
}

static av_cold int wait_for_state(OMXCodecContext *s, OMX_STATETYPE state)
{
    int ret = 0;
    pthread_mutex_lock(&s->state_mutex);
    while (s->state != state && s->error == OMX_ErrorNone)
        pthread_cond_wait(&s->state_cond, &s->state_mutex);
    if (s->error != OMX_ErrorNone)
        ret = AVERROR_DECODER_NOT_FOUND;
    pthread_mutex_unlock(&s->state_mutex);
    return ret;
}

static av_cold int omx_component_init(AVCodecContext *avctx, const char *role)
{
    OMXCodecContext *s = avctx->priv_data;
    OMX_PARAM_COMPONENTROLETYPE role_params = { 0 };
    OMX_PORT_PARAM_TYPE video_port_params = { 0 };
    OMX_PARAM_PORTDEFINITIONTYPE in_port_params = { 0 }, out_port_params = { 0 };
    OMX_VIDEO_PARAM_PORTFORMATTYPE video_port_format = { 0 };
    OMX_VIDEO_PARAM_BITRATETYPE vid_param_bitrate = { 0 };
    OMX_ERRORTYPE err;
    int i;

    s->version.s.nVersionMajor = 1;
    s->version.s.nVersionMinor = 1;
    s->version.s.nRevision     = 2;
    s->firstFrame = 0;

    err = s->omx_context->ptr_GetHandle(&s->handle, s->component_name, s, (OMX_CALLBACKTYPE*) &callbacks);
    if (err != OMX_ErrorNone) {
        av_log(avctx, AV_LOG_ERROR, "OMX_GetHandle(%s) failed: %x\n", s->component_name, err);
        return AVERROR_UNKNOWN;
    }

    // This one crashes the mediaserver on qcom, if used over IOMX
    INIT_STRUCT(role_params);
    av_strlcpy(role_params.cRole, role, sizeof(role_params.cRole));
    // Intentionally ignore errors on this one
    OMX_SetParameter(s->handle, OMX_IndexParamStandardComponentRole, &role_params);

    INIT_STRUCT(video_port_params);
    err = OMX_GetParameter(s->handle, OMX_IndexParamVideoInit, &video_port_params);
    CHECK(err);

    s->in_port = s->out_port = -1;
    for (i = 0; i < video_port_params.nPorts; i++) {
        int port = video_port_params.nStartPortNumber + i;
        OMX_PARAM_PORTDEFINITIONTYPE port_params = { 0 };
        INIT_STRUCT(port_params);
        port_params.nPortIndex = port;
        err = OMX_GetParameter(s->handle, OMX_IndexParamPortDefinition, &port_params);
        if (err != OMX_ErrorNone) {
            av_log(avctx, AV_LOG_WARNING, "port %d error %x\n", port, err);
            break;
        }
        if (port_params.eDir == OMX_DirInput && s->in_port < 0) {
            in_port_params = port_params;
            s->in_port = port;
        } else if (port_params.eDir == OMX_DirOutput && s->out_port < 0) {
            out_port_params = port_params;
            s->out_port = port;
        }
    }
    if (s->in_port < 0 || s->out_port < 0) {
        av_log(avctx, AV_LOG_ERROR, "No in or out port found (in %d out %d)\n", s->in_port, s->out_port);
        return AVERROR_UNKNOWN;
    }

    //For out_port
    s->color_format = 0;
    for (i = 0; ; i++) {
        INIT_STRUCT(video_port_format);
        video_port_format.nIndex = i;
        video_port_format.nPortIndex = s->out_port;
        if (OMX_GetParameter(s->handle, OMX_IndexParamVideoPortFormat, &video_port_format) != OMX_ErrorNone)
            break;
        if (video_port_format.eColorFormat == OMX_COLOR_FormatYUV420Planar ||
            video_port_format.eColorFormat == OMX_COLOR_FormatYUV420SemiPlanar) {
            //s->color_format = video_port_format.eColorFormat;
            s->color_format = OMX_COLOR_FormatYUV420Planar;
            break;
        }
    }
    if (s->color_format == 0) {
        av_log(avctx, AV_LOG_ERROR, "No supported pixel formats (%d formats available)\n", i);
        return AVERROR_UNKNOWN;
    }

    //Set in_port_params
    err = OMX_GetParameter(s->handle, OMX_IndexParamPortDefinition, &in_port_params);
    in_port_params.eDomain    = OMX_PortDomainVideo;
    in_port_params.format.video.nFrameWidth   = avctx->width;
    in_port_params.format.video.nFrameHeight  = avctx->height;
    in_port_params.format.video.nStride       = avctx->width;
    in_port_params.format.video.nSliceHeight  = avctx->height;
    in_port_params.format.video.nBitrate      = avctx->bit_rate;
    if (avctx->codec->id == AV_CODEC_ID_MPEG4)
        in_port_params.format.video.eCompressionFormat = OMX_VIDEO_CodingMPEG4;
    else if (avctx->codec->id == AV_CODEC_ID_H264){
        in_port_params.format.video.eCompressionFormat = OMX_VIDEO_CodingAVC;
    }

    err = OMX_SetParameter(s->handle, OMX_IndexParamPortDefinition, &in_port_params);

    CHECK(err);
    err = OMX_GetParameter(s->handle, OMX_IndexParamPortDefinition, &in_port_params);
    CHECK(err);
    s->stride         = in_port_params.format.video.nStride;
    s->plane_size     = in_port_params.format.video.nSliceHeight;
    s->num_in_buffers = in_port_params.nBufferCountActual;

    //Set out_port_params
    out_port_params.eDomain    = OMX_PortDomainVideo;
    out_port_params.format.video.eColorFormat          = s->color_format;
    // If specific codecs need to manually override the stride/plane_size,
    // that can be done here.
    out_port_params.format.video.nStride      = s->stride;
    out_port_params.format.video.nSliceHeight = s->plane_size;
    out_port_params.format.video.nFrameWidth  = avctx->width;
    out_port_params.format.video.nFrameHeight = avctx->height;
    err = OMX_SetParameter(s->handle, OMX_IndexParamPortDefinition, &out_port_params);
    CHECK(err);
    err = OMX_GetParameter(s->handle, OMX_IndexParamPortDefinition, &out_port_params);
    CHECK(err);
    s->num_out_buffers = out_port_params.nBufferCountActual;
    s->stride         = out_port_params.format.video.nStride;
    s->plane_size     = out_port_params.format.video.nSliceHeight;
    s->out_port_buffer_size = out_port_params.nBufferSize;

    err = OMX_SendCommand(s->handle, OMX_CommandStateSet, OMX_StateIdle, NULL);
    CHECK(err);

    //TODO: check input_zerocopy before mallocz
    s->in_buffer_headers  = av_mallocz(sizeof(OMX_BUFFERHEADERTYPE*) * s->num_in_buffers);
    s->free_in_buffers    = av_mallocz(sizeof(OMX_BUFFERHEADERTYPE*) * s->num_in_buffers);
    s->out_buffer_headers = av_mallocz(sizeof(OMX_BUFFERHEADERTYPE*) * s->num_out_buffers);
    s->done_out_buffers   = av_mallocz(sizeof(OMX_BUFFERHEADERTYPE*) * s->num_out_buffers);
    if (!s->in_buffer_headers || !s->free_in_buffers || !s->out_buffer_headers || !s->done_out_buffers)
        return AVERROR(ENOMEM);
    for (i = 0; i < s->num_in_buffers && err == OMX_ErrorNone; i++) {
        if (s->input_zerocopy)
            err = OMX_UseBuffer(s->handle, &s->in_buffer_headers[i], s->in_port, s, in_port_params.nBufferSize, NULL);
        else
            err = OMX_AllocateBuffer(s->handle, &s->in_buffer_headers[i],  s->in_port,  s, in_port_params.nBufferSize);
        if (err == OMX_ErrorNone)
            s->in_buffer_headers[i]->pAppPrivate = s->in_buffer_headers[i]->pOutputPortPrivate = NULL;
    }
    CHECK(err);
    s->num_in_buffers = i;
    printf("NUM-IN BUF: %d\n", i);
    for (i = 0; i < s->num_out_buffers && err == OMX_ErrorNone; i++)
        err = OMX_AllocateBuffer(s->handle, &s->out_buffer_headers[i], s->out_port, s, out_port_params.nBufferSize);
    CHECK(err);
    s->num_out_buffers = i;
    printf("NUM-OUT BUF: %d\n", i);
    if (wait_for_state(s, OMX_StateIdle) < 0) {
        av_log(avctx, AV_LOG_ERROR, "Didn't get OMX_StateIdle\n");
        return AVERROR_UNKNOWN;
    }
    err = OMX_SendCommand(s->handle, OMX_CommandStateSet, OMX_StateExecuting, NULL);
    CHECK(err);
    if (wait_for_state(s, OMX_StateExecuting) < 0) {
        av_log(avctx, AV_LOG_ERROR, "Didn't get OMX_StateExecuting\n");
        return AVERROR_UNKNOWN;
    }

    //Queue buffers
    for (i = 0; i < s->num_out_buffers && err == OMX_ErrorNone; i++)
        err = OMX_FillThisBuffer(s->handle, s->out_buffer_headers[i]);
    if (err != OMX_ErrorNone) {
        for (i = 0; i < s->num_out_buffers; i++)
            s->done_out_buffers[s->num_done_out_buffers++] = s->out_buffer_headers[i];
    }
    for (i = 0; i < s->num_in_buffers; i++)
        s->free_in_buffers[s->num_free_in_buffers++] = s->in_buffer_headers[i];
    return err != OMX_ErrorNone ? AVERROR_UNKNOWN : 0;
}

static av_cold void cleanup(OMXCodecContext *s)
{
    int i, executing;

    pthread_mutex_lock(&s->state_mutex);
    executing = s->state == OMX_StateExecuting;
    pthread_mutex_unlock(&s->state_mutex);

    if (executing) {
        OMX_SendCommand(s->handle, OMX_CommandStateSet, OMX_StateIdle, NULL);
        wait_for_state(s, OMX_StateIdle);
        OMX_SendCommand(s->handle, OMX_CommandStateSet, OMX_StateLoaded, NULL);
        for (i = 0; i < s->num_in_buffers; i++) {
            OMX_BUFFERHEADERTYPE *buffer = get_buffer(&s->input_mutex, &s->input_cond,
                                                      &s->num_free_in_buffers, s->free_in_buffers, 1);
            if (s->input_zerocopy)
                buffer->pBuffer = NULL;
            OMX_FreeBuffer(s->handle, s->in_port, buffer);
        }
        for (i = 0; i < s->num_out_buffers; i++) {
            OMX_BUFFERHEADERTYPE *buffer = get_buffer(&s->output_mutex, &s->output_cond,
                                                      &s->num_done_out_buffers, s->done_out_buffers, 1);
            OMX_FreeBuffer(s->handle, s->out_port, buffer);
        }
        wait_for_state(s, OMX_StateLoaded);
    }
    if (s->handle) {
        s->omx_context->ptr_FreeHandle(s->handle);
        s->handle = NULL;
    }

    omx_deinit(s->omx_context);
    s->omx_context = NULL;
    if (s->mutex_cond_inited) {
        pthread_cond_destroy(&s->state_cond);
        pthread_mutex_destroy(&s->state_mutex);
        pthread_cond_destroy(&s->input_cond);
        pthread_mutex_destroy(&s->input_mutex);
        pthread_cond_destroy(&s->output_cond);
        pthread_mutex_destroy(&s->output_mutex);
        s->mutex_cond_inited = 0;
    }
    av_freep(&s->in_buffer_headers);
    av_freep(&s->out_buffer_headers);
    av_freep(&s->free_in_buffers);
    av_freep(&s->done_out_buffers);
    av_freep(&s->output_buf);
    av_freep(&s->input_buf);

    if(s->avbsfc)
        av_bitstream_filter_close(s->avbsfc);
}

static av_cold int omx_decode_init(AVCodecContext *avctx)
{
    OMXCodecContext *s = avctx->priv_data;
    int ret = AVERROR_DECODER_NOT_FOUND;
    const char *role;
    OMX_BUFFERHEADERTYPE *buffer;
    OMX_ERRORTYPE err;

#if CONFIG_OMX_RPI
    s->input_zerocopy = 1;
#endif

    s->omx_context = omx_init(avctx, s->libname, s->libprefix);
    if (!s->omx_context)
        return AVERROR_DECODER_NOT_FOUND;
    
    if(mmngr_try_load(s->omx_context, avctx)<0)
        return AVERROR_DECODER_NOT_FOUND;

    pthread_mutex_init(&s->state_mutex, NULL);
    pthread_cond_init(&s->state_cond, NULL);
    pthread_mutex_init(&s->input_mutex, NULL);
    pthread_cond_init(&s->input_cond, NULL);
    pthread_mutex_init(&s->output_mutex, NULL);
    pthread_cond_init(&s->output_cond, NULL);
    s->mutex_cond_inited = 1;
    s->avctx = avctx;
    s->state = OMX_StateLoaded;
    s->error = OMX_ErrorNone;

    switch (avctx->codec->id) {
    case AV_CODEC_ID_MPEG4:
        role = "video_decoder.mpeg4";
        break;
    case AV_CODEC_ID_H264:
        role = "video_decoder.avc";
        break;
    default:
        return AVERROR(ENOSYS);
    }

    if ((ret = find_component(s->omx_context, avctx, role, s->component_name, sizeof(s->component_name))) < 0)
        goto fail;

    av_log(avctx, AV_LOG_INFO, "Using %s\n", s->component_name);

    if ((ret = omx_component_init(avctx, role)) < 0){
        goto fail;
    }

    s->avbsfc = av_bitstream_filter_init("h264_mp4toannexb");

    return 0;
fail:
    return ret;
}

static void blank_function(void *opaque, uint8_t* data)
{
    return;
}

static int omx_decode_frame(AVCodecContext *avctx, 
                            AVFrame *data, int *got_frame, AVPacket *pkt)
{
    
    OMXCodecContext *s = avctx->priv_data;
    int ret = 0;
    OMX_BUFFERHEADERTYPE* buffer;
    OMX_ERRORTYPE err;
    AVFrame *frame = data;
    OMX_PTR phy_add;
    int dma_buf_add[3];
    int mmngr_err;
    int plane_length[3];
    struct timeval t1, t2;
    double elapsedTime = 0;
    
    // printf("DECODE FRAME\n");

    if (pkt && pkt->data && pkt->size) {
        
        av_bitstream_filter_filter(s->avbsfc, avctx, NULL, &pkt->data, &pkt->size, pkt->data, pkt->size, 0);

        buffer = get_buffer(&s->input_mutex, &s->input_cond,
                            &s->num_free_in_buffers, s->free_in_buffers, 1);

       
        buffer->nFilledLen = pkt->size;
        
        memcpy(buffer->pBuffer, pkt->data, pkt->size);

        
        buffer->nFlags |= OMX_BUFFERFLAG_ENDOFFRAME;
        buffer->nOffset = 0;

        buffer->nTimeStamp = pkt->pts;
        err = OMX_EmptyThisBuffer(s->handle, buffer);
        if (err != OMX_ErrorNone) {
            append_buffer(&s->input_mutex, &s->input_cond, &s->num_free_in_buffers, s->free_in_buffers, buffer);
            av_log(avctx, AV_LOG_ERROR, "OMX_EmptyThisBuffer failed: %x\n", err);
            return AVERROR_UNKNOWN;
        }
        s->num_in_frames++;
    }
    else
    {   
        buffer = get_buffer(&s->input_mutex, &s->input_cond,
                            &s->num_free_in_buffers, s->free_in_buffers, 1);
        //End of Stream
        buffer->nFlags = OMX_BUFFERFLAG_EOS;

        // Convert the timestamps to microseconds; some encoders can ignore
        // the framerate and do VFR bit allocation based on timestamps.
        err = OMX_EmptyThisBuffer(s->handle, buffer);
        if (err != OMX_ErrorNone) {
            append_buffer(&s->input_mutex, &s->input_cond, &s->num_free_in_buffers, s->free_in_buffers, buffer);
            av_log(avctx, AV_LOG_ERROR, "OMX_EmptyThisBuffer failed: %x\n", err);
            return AVERROR_UNKNOWN;
        }
    }
    
    while (!*got_frame && ret == 0) {
        
        // Only wait for output if flushing and not all frames have been output
        buffer = get_buffer(&s->output_mutex, &s->output_cond,
                            &s->num_done_out_buffers, s->done_out_buffers,
                            1);
        // printf();
        
        if(!buffer)
            break;

        // phy_add = ((OMXR_MC_VIDEO_DECODERESULTTYPE*)buffer->pOutputPortPrivate)->pvPhysImageAddressY;
        // if(s->firstFrame > 0){
        //     *got_frame = 0;
        //     break;
        // }
        // s->firstFrame++;

        frame->format = AV_PIX_FMT_YUV420P;
        frame->width = avctx->width;
        frame->height = avctx->height;
        frame->pkt_pts = buffer->nTimeStamp;
        // frame->pkt_dts = buffer->nTimeStamp;
        // frame->linesize[0] = frame->width;
        // frame->linesize[1] = frame->width/2;
        // frame->linesize[2] = frame->width/2;
        ret = av_image_fill_linesizes(frame->linesize, frame->format, frame->width);


        plane_length[0] = frame->linesize[0]*frame->height;
        plane_length[1] = frame->linesize[1]*frame->height;
        plane_length[2] = frame->linesize[2]*frame->height;

        // printf("VIRTUAL ADDR: %d\n", buffer->pBuffer);

        frame->buf[0] = av_buffer_alloc(plane_length[0]); //AVBufferRef*
        frame->buf[1] = av_buffer_alloc(plane_length[1]);
        frame->buf[2] = av_buffer_alloc(plane_length[2]);


        // frame->data[0] = frame->buf[0]->data;
        // frame->data[1] = frame->buf[1]->data;
        // frame->data[2] = frame->buf[2]->data;

        // frame->buf[0] =  av_buffer_create(buffer->pBuffer + buffer->nOffset, plane_length[0], blank_function, NULL, AV_BUFFER_FLAG_READONLY);
        // frame->buf[1] =  av_buffer_create(buffer->pBuffer + buffer->nOffset + plane_length[0], plane_length[1], blank_function, NULL, AV_BUFFER_FLAG_READONLY);
        // frame->buf[2] =  av_buffer_create(buffer->pBuffer + buffer->nOffset + plane_length[1], plane_length[2], blank_function, NULL, AV_BUFFER_FLAG_READONLY);
        // frame->buf[3] =  av_buffer_alloc(plane_length[2]);
        if(s->firstFrame == 0)
        {
            FILE *f = fopen("test.yuv", "ab");
            fwrite(frame->buf[0]->data, sizeof(char), plane_length[0], f);
            fwrite(frame->buf[1]->data, sizeof(char), plane_length[1], f);
            fwrite(frame->buf[2]->data, sizeof(char), plane_length[2], f);
            fclose(f);
        }
        s->firstFrame++;

        if(!frame->buf[0] && !frame->buf[1] && !frame->buf[2])
        {
            break;
        }
        
        
        ret = av_image_fill_arrays(frame->data, frame->linesize, buffer->pBuffer + buffer->nOffset, frame->format, frame->width, frame->height, 1); 
        
        *got_frame = 1;
end:
        err = OMX_FillThisBuffer(s->handle, buffer);
        if (err != OMX_ErrorNone) {
            append_buffer(&s->output_mutex, &s->output_cond, &s->num_done_out_buffers, s->done_out_buffers, buffer);
            av_log(avctx, AV_LOG_ERROR, "OMX_FillThisBuffer failed: %x\n", err);
            printf("AVCD\n");
            ret = AVERROR_UNKNOWN;
        }

    }
    
    return ret;
}

static av_cold int omx_decode_end(AVCodecContext *avctx)
{
    OMXCodecContext *s = avctx->priv_data;

    cleanup(s);
    return 0;
}

#define OFFSET(x) offsetof(OMXCodecContext, x)
#define VDE AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_DECODING_PARAM | AV_OPT_FLAG_ENCODING_PARAM
#define VE  AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_ENCODING_PARAM
#define VD  AV_OPT_FLAG_VIDEO_PARAM | AV_OPT_FLAG_DECODING_PARAM
static const AVOption options[] = {
    { "omx_libname", "OpenMAX library name", OFFSET(libname), AV_OPT_TYPE_STRING, { 0 }, 0, 0, VDE },
    { "omx_libprefix", "OpenMAX library prefix", OFFSET(libprefix), AV_OPT_TYPE_STRING, { 0 }, 0, 0, VDE },
    { "zerocopy", "Try to avoid copying input frames if possible", OFFSET(input_zerocopy), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 1, VE },
    { NULL }
};

static const enum AVPixelFormat omx_decoder_pix_fmts[] = {
    AV_PIX_FMT_YUV420P, AV_PIX_FMT_NONE
};

static const AVClass omx_h264dec_class = {
    .class_name = "h264_omx_dec",
    .item_name  = av_default_item_name,
    .option     = options,
    .version    = LIBAVUTIL_VERSION_INT,
};
AVCodec ff_h264_omx_dec_decoder = {
    .name             = "h264_omx_dec",
    .long_name        = NULL_IF_CONFIG_SMALL("OpenMAX IL H264 video decoder"),
    .type             = AVMEDIA_TYPE_VIDEO,
    .id               = AV_CODEC_ID_H264,
    .priv_data_size   = sizeof(OMXCodecContext),
    .init             = omx_decode_init,
    .decode           = omx_decode_frame,
    .close            = omx_decode_end,
    .pix_fmts         = omx_decoder_pix_fmts,
    // .capabilities     = AV_CODEC_CAP_DELAY,
    .caps_internal    = FF_CODEC_CAP_INIT_THREADSAFE | FF_CODEC_CAP_INIT_CLEANUP,
    .priv_class       = &omx_h264dec_class,
};
