package com.lyricscutter.app;

import com.lyricscutter.ffmpeg.FfmpegCutterPlugin;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(FfmpegCutterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
