package com.lyricscutter.ffmpeg;

// Drop this file into:
//   android/app/src/main/java/com/lyricscutter/ffmpeg/FfmpegCutterPlugin.java
// (create the folders — package name must match; change the package string
// above AND this path together if you use a different package id.)
//
// Registers a native Capacitor plugin that trims + encodes a clip using
// FFmpeg-Kit, operating on real file paths. No file bytes ever cross into
// the JS heap or get decoded to raw PCM in the WebView — this is what
// removes the duration ceiling entirely (limit becomes disk space, not RAM).

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.arthenica.ffmpegkit.FFmpegKit;
import com.arthenica.ffmpegkit.FFmpegSession;
import com.arthenica.ffmpegkit.ReturnCode;

import java.io.File;
import java.util.Locale;

@CapacitorPlugin(name = "FfmpegCutter")
public class FfmpegCutterPlugin extends Plugin {

    // call.getString("inputPath")  - real filesystem path to the source file
    //                                 (from @capawesome/capacitor-file-picker's `path`)
    // call.getDouble("startSec")   - clip start, seconds
    // call.getDouble("endSec")     - clip end, seconds
    // call.getString("outputPath") - full path to write the .mp3 to
    //                                 (build this in JS under Filesystem cache/data dir)
    @PluginMethod
    public void cut(PluginCall call) {
        String inputPath  = call.getString("inputPath");
        String outputPath = call.getString("outputPath");
        Double startSec    = call.getDouble("startSec");
        Double endSec      = call.getDouble("endSec");

        if (inputPath == null || outputPath == null || startSec == null || endSec == null) {
            call.reject("inputPath, outputPath, startSec, endSec are all required");
            return;
        }
        if (!new File(inputPath).exists()) {
            call.reject("inputPath does not exist: " + inputPath);
            return;
        }

        double duration = endSec - startSec;
        if (duration <= 0) {
            call.reject("endSec must be greater than startSec");
            return;
        }

        // -ss before -i = fast seek (input-side), avoids decoding everything
        // before the cut point. -t = duration of the slice, not absolute end.
        // 128k CBR mp3 to match the app's existing lamejs bitrate.
        String cmd = String.format(
            Locale.US,
            "-y -ss %.3f -i %s -t %.3f -vn -acodec libmp3lame -b:a 128k %s",
            startSec,
            quote(inputPath),
            duration,
            quote(outputPath)
        );

        FFmpegSession session = FFmpegKit.execute(cmd);

        if (ReturnCode.isSuccess(session.getReturnCode())) {
            JSObject ret = new JSObject();
            ret.put("outputPath", outputPath);
            call.resolve(ret);
        } else {
            call.reject("FFmpeg failed (rc=" + session.getReturnCode() + "): "
                + session.getFailStackTrace());
        }
    }

    // Optional: probe duration natively too, useful if you ever skip the
    // HTML media element for very unusual formats it can't read.
    @PluginMethod
    public void probeDuration(PluginCall call) {
        String inputPath = call.getString("inputPath");
        if (inputPath == null || !new File(inputPath).exists()) {
            call.reject("inputPath missing or does not exist");
            return;
        }
        String cmd = String.format(Locale.US, "-i %s -f null -", quote(inputPath));
        FFmpegSession session = FFmpegKit.execute(cmd);
        // Duration parsing from ffmpeg's stderr banner; FFmpegKit also
        // exposes MediaInformationSession if you want a cleaner API later.
        String log = session.getAllLogsAsString();
        JSObject ret = new JSObject();
        ret.put("rawLog", log);
        call.resolve(ret);
    }

    private static String quote(String path) {
        return "\"" + path.replace("\"", "\\\"") + "\"";
    }
}
